import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AppSettings,
  BrowserSessionInfo,
  ChapterContent,
  ChapterLink,
  ChapterImage,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DownloadHistoryEntry,
  EpubMergeProgress,
  EpubRepairProgress,
  EpubRepairResult,
  EpubRepairResponse,
  EbookConversionResponse,
  GenerateEpubInput,
  LibraryFileCorrection,
  LibraryFileRecord,
  LibraryOperation,
  LibraryEpubMergeResponse,
  LibraryIndex,
  LibraryProgress,
  QueueChapter,
  Result
} from '../shared/contracts'
import {
  DEFAULT_EPUB_CSS,
  MAX_ACTIVE_DISCOVERIES,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_EPUB_CSS_LENGTH,
  MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
  MAX_NOVEL_DESCRIPTION_LENGTH,
  MAX_SELECTED_CHAPTERS,
  MAX_TIMER_DELAY_MS,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../shared/constants'
import {
  clearBrowserSession,
  closeBrowserSession,
  openVerificationBrowser,
  readBrowserPage
} from './services/browserService'
import {
  markInterruptedDownloadJobs,
  readCoverArtifact,
  readChapterArtifact,
  readDiscoveryQueue,
  readDownloadHistory,
  readLibraryIndex,
  readLibraryIndexBackup,
  readLibraryOperations,
  readSettings,
  saveDownloadHistoryEntry,
  removeChapterArtifacts,
  writeLibraryCorrection,
  writeLibraryIndex,
  writeLibraryOperations,
  writeCoverArtifact,
  writeDiscoveryQueue,
  writeChapterArtifact,
  writeSettings
} from './services/localStore'
import { readTrackerCsv } from './services/trackerCsv'
import {
  fetchChapterContent,
  fetchChapterContentFromHtml,
  fetchImageResource,
  discoverChapters,
  discoverChaptersUsingPageLoader,
  HttpStatusError,
  validateHttpUrl
} from './services/scraper'
import { writeEpub } from './services/epub'
import { recommendArchiveCoverage } from '../shared/archiveRecommendation'
import { sanitizeEpubFilename, suggestEpubFilename } from '../shared/epubFilename'
import type { EpubMergeInput, EpubMergeResult } from './services/epubMerger'
import { convertAzw3ToEpub, convertEpubToAzw3 } from './services/azw3Converter'
import { initializeLocalLogger } from './services/localLogger'

let mainWindow: BrowserWindow | null = null
const approvedOutputDirectories = new Set<string>()
let discoveryQueueNotificationTimer: ReturnType<typeof setTimeout> | null = null
let libraryOperationFlushTimer: ReturnType<typeof setTimeout> | null = null
let libraryOperationWrites = Promise.resolve()
let libraryOperations: LibraryOperation[] = []
interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

type LibraryScanWorkerMessage =
  | { type: 'progress'; progress: LibraryProgress }
  | { type: 'complete' }
  | { type: 'error'; error: string }

let activeLibraryScan: ActiveLibraryScan | null = null
let libraryIndexRestoreActive = false
let discoveryQueue: DiscoveryQueueItem[] = []
let discoveryQueueWrites = Promise.resolve()
let historyWrites = Promise.resolve()
const pendingDiscoveries: string[] = []
const browserAssistedDiscoveries = new Set<string>()
const activeBrowserDiscoveries = new Map<string, AbortController>()
let activeDiscoveries = 0
const activeDownloads = new Map<string, { controller: AbortController; requestedAction: 'none' | 'pause' | 'cancel' }>()
let downloadPumpRunning = false
let downloadPumpRequested = false

function copyLibraryOperations(): LibraryOperation[] {
  return libraryOperations.map((operation) => ({
    ...operation,
    inputFiles: [...operation.inputFiles]
  }))
}

function persistLibraryOperations(): Promise<void> {
  const snapshot = copyLibraryOperations()
  const write = libraryOperationWrites.then(() => writeLibraryOperations(dataDirectory(), snapshot))
  libraryOperationWrites = write.then(() => undefined, () => undefined)
  return write
}

function broadcastLibraryOperations(): void {
  const operations = copyLibraryOperations()
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents
    if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) continue
    const frame = webContents.mainFrame
    if (frame.isDestroyed()) continue
    frame.send('library:operations:update', operations)
  }
}

async function flushLibraryOperations(): Promise<void> {
  if (libraryOperationFlushTimer) {
    clearTimeout(libraryOperationFlushTimer)
    libraryOperationFlushTimer = null
  }
  broadcastLibraryOperations()
  try {
    await persistLibraryOperations()
  } catch (error) {
    console.error('Library operation history could not be saved:', error)
  }
}

function scheduleLibraryOperationFlush(): void {
  if (libraryOperationFlushTimer) return
  libraryOperationFlushTimer = setTimeout(() => {
    libraryOperationFlushTimer = null
    void flushLibraryOperations()
  }, 500)
}

async function startLibraryOperation(
  input: Omit<LibraryOperation, 'id' | 'status' | 'startedAt' | 'updatedAt'>
): Promise<string> {
  const now = new Date().toISOString()
  const operation: LibraryOperation = {
    ...input,
    id: randomUUID(),
    status: 'running',
    startedAt: now,
    updatedAt: now,
    inputFiles: [...input.inputFiles]
  }
  libraryOperations.unshift(operation)
  while (libraryOperations.length > 30) {
    let removableIndex = -1
    for (let index = libraryOperations.length - 1; index >= 0; index -= 1) {
      if (libraryOperations[index]?.status !== 'running') {
        removableIndex = index
        break
      }
    }
    if (removableIndex < 0) break
    libraryOperations.splice(removableIndex, 1)
  }
  await flushLibraryOperations()
  return operation.id
}

async function updateLibraryOperation(
  id: string,
  update: Partial<Pick<LibraryOperation, 'status' | 'outputPath' | 'progress' | 'message' | 'error'>>,
  flushImmediately = false
): Promise<void> {
  const index = libraryOperations.findIndex((operation) => operation.id === id)
  if (index < 0) return
  const operation = libraryOperations[index]
  if (!operation) return
  Object.assign(operation, update, { updatedAt: new Date().toISOString() })
  libraryOperations.splice(index, 1)
  libraryOperations.unshift(operation)
  if (flushImmediately) await flushLibraryOperations()
  else scheduleLibraryOperationFlush()
}

function dataDirectory(): string {
  return app.getPath('userData')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function discoverySnapshotIsStale(discoveredAt: string, freshnessHours: number): boolean {
  const timestamp = Date.parse(discoveredAt)
  const now = Date.now()
  return !Number.isFinite(timestamp) || timestamp > now || now - timestamp >= freshnessHours * 60 * 60 * 1000
}

function discoveryQueueItemStatus(item: DiscoveryQueueItem): DiscoveryQueueItem['status'] {
  return item.status
}

async function fetchChapterContentWithBrowserFallback(
  chapter: ChapterLink,
  signal: AbortSignal
): Promise<ChapterContent> {
  try {
    return await fetchChapterContent(chapter, signal)
  } catch (error) {
    const verificationRequired =
      (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) ||
      /manual verification/i.test(errorMessage(error))
    if (!verificationRequired) throw error

    const { html, finalUrl } = await readBrowserPage(chapter.url, signal)
    return fetchChapterContentFromHtml(chapter, html, finalUrl, signal)
  }
}

function copyDiscoveryQueue(): DiscoveryQueueItem[] {
  return discoveryQueue.map((item) => ({
    ...item,
    trackerRow: item.trackerRow ? { ...item.trackerRow } : null,
    alternativeNames: [...(item.alternativeNames ?? [])],
    genres: [...(item.genres ?? [])],
    downloadOptions: item.downloadOptions
      ? {
          ...item.downloadOptions,
          alternativeNames: [...(item.downloadOptions.alternativeNames ?? [])],
          genres: [...(item.downloadOptions.genres ?? [])]
        }
      : null,
    completedChapterUrls: [...item.completedChapterUrls],
    failedChapters: item.failedChapters.map((chapter) => ({ ...chapter })),
    progress: item.progress ? { ...item.progress } : null,
    chapters: item.chapters.map((chapter) => ({ ...chapter }))
  }))
}

function persistDiscoveryQueue(): Promise<void> {
  const snapshot = copyDiscoveryQueue()
  const write = discoveryQueueWrites.then(() => writeDiscoveryQueue(dataDirectory(), snapshot))
  discoveryQueueWrites = write.then(() => undefined, () => undefined)
  return write
}

function persistHistoryEntry(entry: DownloadHistoryEntry): Promise<DownloadHistoryEntry[]> {
  const write = historyWrites.then(() => saveDownloadHistoryEntry(dataDirectory(), entry))
  historyWrites = write.then(() => undefined, () => undefined)
  return write
}

function hydrateQueueItem(item: DiscoveryQueueItem): DiscoveryQueueItem {
  return {
    ...item,
    description: item.description ?? '',
    coverUrl: item.coverUrl ?? '',
    alternativeNames: item.alternativeNames ?? [],
    genres: item.genres ?? [],
    source: item.source ?? '',
    novelStatus: item.novelStatus ?? '',
    status: item.status ?? 'needs-review',
    discoveryChanges: item.discoveryChanges ?? '',
    recommendationSummary: item.recommendationSummary ?? '',
    overlapAllowed: item.overlapAllowed ?? false,
    includeOverlap: item.includeOverlap ?? false,
    overlapCount: item.overlapCount ?? 10,
    repackageOnly: item.repackageOnly ?? false,
    downloadOptions: item.downloadOptions
      ? {
          ...item.downloadOptions,
          description: item.downloadOptions.description ?? '',
          coverUrl: item.downloadOptions.coverUrl ?? '',
          alternativeNames: item.downloadOptions.alternativeNames ?? [],
          genres: item.downloadOptions.genres ?? [],
          source: item.downloadOptions.source ?? '',
          novelStatus: item.downloadOptions.novelStatus ?? '',
          epubCss: item.downloadOptions.epubCss ?? DEFAULT_EPUB_CSS
        }
      : null,
    queuedAt: item.queuedAt ?? '',
    completedChapterUrls: item.completedChapterUrls ?? [],
    failedChapters: item.failedChapters ?? [],
    outputPath: item.outputPath ?? '',
    downloadHistoryId: item.downloadHistoryId ?? '',
    progress: item.progress ?? null,
    chapters: (item.chapters ?? []).map((chapter) => ({
      ...chapter,
      archiveStatus: chapter.archiveStatus ?? 'missing',
      archiveSources: chapter.archiveSources ?? [],
      chapterNumber: chapter.chapterNumber ?? null,
      archiveGap: chapter.archiveGap ?? false,
      recommended: chapter.recommended ?? true,
      deliberateOverlap: chapter.deliberateOverlap ?? false
    }))
  }
}

function expectedOutputPath(
  outputDirectory: string,
  title: string,
  filename: string,
  chapters: ChapterLink[]
): string {
  const requestedFilename = filename.trim() || suggestEpubFilename(
    title,
    chapters[0]?.title ?? '',
    chapters[chapters.length - 1]?.title ?? ''
  )
  return resolve(outputDirectory, sanitizeEpubFilename(requestedFilename)).toLowerCase()
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate)
  return relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

async function getIndexedLibraryFile(
  rawFileId: unknown,
  expectedFormat: LibraryFileRecord['format']
): Promise<string> {
  if (typeof rawFileId !== 'string' || !rawFileId) throw new Error('Select an indexed library file.')
  const [index, settings] = await Promise.all([
    readLibraryIndex(dataDirectory()),
    readSettings(dataDirectory())
  ])
  if (!index) throw new Error('Scan the library before working with indexed files.')
  if (!settings.libraryRoot) throw new Error('Go to Configuration and choose a historical library root first.')
  const file = index.files.find((candidate) => candidate.id === rawFileId)
  if (!file || file.format !== expectedFormat) {
    throw new Error(`The selected ${expectedFormat} is no longer indexed. Rescan and try again.`)
  }
  const [libraryRoot, indexRoot] = await Promise.all([
    realpath(settings.libraryRoot),
    realpath(index.libraryRoot)
  ])
  if (libraryRoot.toLocaleLowerCase() !== indexRoot.toLocaleLowerCase()) {
    throw new Error('The saved library index belongs to a different root. Scan the configured library first.')
  }
  const inputDetails = await lstat(file.path)
  const inputPath = await realpath(file.path)
  if (
    inputDetails.isSymbolicLink() ||
    !inputDetails.isFile() ||
    !isWithinDirectory(libraryRoot, inputPath) ||
    extname(inputPath).toLowerCase() !== (expectedFormat === 'EPUB' ? '.epub' : '.azw3')
  ) {
    throw new Error(`The selected ${expectedFormat} is not a regular file inside the configured library.`)
  }
  if (inputDetails.size !== file.size || inputDetails.mtime.toISOString() !== file.modifiedAt) {
    throw new Error(`The source file changed since the last scan: ${file.filename}. Rescan and try again.`)
  }
  return inputPath
}

async function getSiblingOutputPath(
  inputPath: string,
  suffix: string
): Promise<string | null> {
  const sourceName = basename(inputPath, extname(inputPath))
  const outputPath = join(dirname(inputPath), `${sourceName}${suffix}.epub`)
  if (resolve(outputPath).toLocaleLowerCase() === inputPath.toLocaleLowerCase()) {
    throw new Error('The output cannot replace the source file.')
  }
  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`The output path is already used by a folder or symbolic link: ${basename(outputPath)}`)
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('The app window is not available to confirm replacing the existing EPUB.')
    }
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Replace existing EPUB?',
      message: `Replace "${basename(outputPath)}"?`
    })
    if (confirmation.response !== 0) return null
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  return outputPath
}

async function chooseConversionOutputPath(
  window: BrowserWindow,
  inputPath: string,
  outputDirectory: string,
  extension: 'azw3' | 'epub',
  defaultFilename?: string
): Promise<string | null> {
  const formatName = extension.toUpperCase()
  const sourceName = basename(inputPath).replace(/\.[^.]+$/, '')
  const saveResult = await dialog.showSaveDialog(window, {
    defaultPath: join(outputDirectory, defaultFilename ?? `${sourceName}.${extension}`),
    filters: [{ name: `${formatName} books`, extensions: [extension] }]
  })
  if (saveResult.canceled || !saveResult.filePath) return null

  const outputPath = extname(saveResult.filePath).toLowerCase() === `.${extension}`
    ? saveResult.filePath
    : `${saveResult.filePath}.${extension}`
  if (resolve(outputPath).toLocaleLowerCase() === inputPath.toLocaleLowerCase()) {
    throw new Error(`The ${formatName} output cannot replace the source file.`)
  }
  const outputFolderDetails = await stat(dirname(outputPath))
  if (!outputFolderDetails.isDirectory()) throw new Error(`The ${formatName} output location is not a folder.`)

  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`The ${formatName} output path is already used by a folder or symbolic link.`)
    }
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: `Replace existing ${formatName}?`,
      message: `Replace "${basename(outputPath)}"?`
    })
    if (confirmation.response !== 0) return null
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  return outputPath
}

function notifyDiscoveryQueueChanged(): void {
  if (discoveryQueueNotificationTimer) return
  discoveryQueueNotificationTimer = setTimeout(() => {
    discoveryQueueNotificationTimer = null
    const items = copyDiscoveryQueue()
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) continue
      const frame = webContents.mainFrame
      if (frame.isDestroyed()) continue
      frame.send('discovery-queue:update', items)
    }
  }, 1000)
}

function sendToCurrentFrame(
  webContents: Electron.WebContents,
  frame: Electron.WebFrameMain | null,
  channel: string,
  value: unknown
): void {
  if (
    webContents.isDestroyed() ||
    webContents.isLoadingMainFrame() ||
    !frame ||
    frame.isDestroyed() ||
    webContents.mainFrame !== frame
  ) {
    return
  }
  frame.send(channel, value)
}

async function discoverQueueItem(id: string, browserAssisted = false): Promise<void> {
  const item = discoveryQueue.find((candidate) => candidate.id === id)
  if (!item || item.status !== 'discovering') return
  const browserController = browserAssisted ? new AbortController() : null
  const browserOperationId = `queue:${id}`
  if (browserController) activeBrowserDiscoveries.set(browserOperationId, browserController)
  const previousChapters = item.chapters.map((chapter) => ({ ...chapter }))
  const previousByUrl = new Map(previousChapters.map((chapter) => [chapter.url, chapter]))
  const hadPreviousSnapshot = Boolean(item.discoveredAt && previousChapters.length > 0)

  try {
    const result = browserAssisted
      ? await discoverChaptersUsingPageLoader(item.sourceUrl, readBrowserPage, undefined, browserController?.signal)
      : await discoverChapters(item.sourceUrl)
    if (item.status !== 'discovering') {
      if (browserController) activeBrowserDiscoveries.delete(browserOperationId)
      return
    }
    item.title = result.title || item.title
    item.author = result.author || item.author
    item.description = result.description
    item.coverUrl = result.coverUrl
    item.alternativeNames = [...result.alternativeNames]
    item.genres = [...result.genres]
    item.source = result.source
    item.novelStatus = result.novelStatus
    item.parserName = result.parserName
    const newUrls = new Set(result.chapters.map((chapter) => chapter.url))
    const addedCount = result.chapters.filter((chapter) => !previousByUrl.has(chapter.url)).length
    const removedCount = previousChapters.filter((chapter) => !newUrls.has(chapter.url)).length
    const orderChanged =
      previousChapters.length === result.chapters.length &&
      previousChapters.some((chapter, index) => chapter.url !== result.chapters[index].url)
    const refreshedChapters: QueueChapter[] = result.chapters.map((chapter) => ({
      ...chapter,
      archiveStatus: 'missing',
      archiveSources: [],
      chapterNumber: null,
      archiveGap: false,
      recommended: true,
      deliberateOverlap: false,
      selected: previousByUrl.get(chapter.url)?.selected ?? true
    }))
    const libraryIndex = await readLibraryIndex(dataDirectory())
    const recommendation = recommendArchiveCoverage(
      { ...item, chapters: refreshedChapters },
      libraryIndex?.files ?? [],
      item.includeOverlap,
      item.overlapCount
    )
    item.chapters = recommendation.chapters
    item.overlapAllowed = recommendation.overlapAllowed
    item.includeOverlap = item.includeOverlap && recommendation.overlapAllowed
    item.recommendationSummary = recommendation.summary
    item.discoveryChanges =
      hadPreviousSnapshot && (addedCount > 0 || removedCount > 0 || orderChanged)
        ? `Chapter list changed: ${addedCount} added, ${removedCount} removed${orderChanged ? ', order changed' : ''}. Review your selection.`
        : ''
    item.status = 'needs-review'
    item.error = ''
    item.discoveredAt = new Date().toISOString()
    item.updatedAt = item.discoveredAt
  } catch (error) {
    item.status = 'failed'
    item.error = errorMessage(error)
    item.updatedAt = new Date().toISOString()
  }

  try {
    await persistDiscoveryQueue()
  } catch (error) {
    console.error(`Discovery queue item ${id} could not be saved:`, error)
    item.status = 'failed'
    item.error = `Discovery result could not be saved: ${errorMessage(error)}`
    item.updatedAt = new Date().toISOString()
    try {
      await persistDiscoveryQueue()
    } catch (saveError) {
      console.error(`Discovery queue item ${id} failure state could not be saved:`, saveError)
    }
  }
  if (browserController) activeBrowserDiscoveries.delete(browserOperationId)
  notifyDiscoveryQueueChanged()
}

function pumpDiscoveryQueue(): void {
  while (activeDiscoveries < MAX_ACTIVE_DISCOVERIES && pendingDiscoveries.length > 0) {
    const id = pendingDiscoveries.shift()!
    activeDiscoveries += 1
    const browserAssisted = browserAssistedDiscoveries.delete(id)
    void discoverQueueItem(id, browserAssisted).finally(() => {
      activeDiscoveries -= 1
      pumpDiscoveryQueue()
    })
  }
}

async function revalidateStaleQueuedJob(
  item: DiscoveryQueueItem,
  historyEntry: DownloadHistoryEntry
): Promise<boolean> {
  const selectedUrls = item.chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.url)
  item.status = 'discovering'
  item.error = ''
  item.progress = {
    current: 0,
    total: selectedUrls.length,
    message: 'Refreshing the chapter list before starting this older job…'
  }
  await persistDownloadState(item, historyEntry)

  await discoverQueueItem(item.id)
  if (discoveryQueueItemStatus(item) === 'failed' && /manual verification|HTTP 401|HTTP 403/i.test(item.error)) {
    item.status = 'discovering'
    item.error = ''
    item.progress = {
      current: 0,
      total: selectedUrls.length,
      message: 'Retrying chapter-list refresh in the saved browser session…'
    }
    await persistDownloadState(item, historyEntry)
    await discoverQueueItem(item.id, true)
  }

  if (discoveryQueueItemStatus(item) !== 'needs-review') {
    if (discoveryQueueItemStatus(item) !== 'failed') {
      item.status = 'failed'
      item.error = 'The chapter list could not be refreshed before the EPUB job started.'
    } else {
      item.error = `The chapter list could not be refreshed before the EPUB job started: ${item.error}`
    }
    historyEntry.status = 'failed'
    historyEntry.error = item.error
    await persistDownloadState(item, historyEntry)
    return false
  }

  const previouslySelected = new Set(selectedUrls)
  for (const chapter of item.chapters) {
    chapter.selected = previouslySelected.has(chapter.url)
  }
  const refreshedSelection = item.chapters
    .filter((chapter) => chapter.selected)
    .map((chapter) => chapter.url)
  const selectionUnchanged =
    selectedUrls.length === refreshedSelection.length &&
    selectedUrls.every((url, index) => url === refreshedSelection[index])

  if (!selectionUnchanged) {
    item.status = 'needs-review'
    item.error = 'The chapter list changed since this EPUB was queued. Review the refreshed chapters before queueing it again.'
    historyEntry.status = 'failed'
    historyEntry.error = item.error
    await persistDownloadState(item, historyEntry)
    return false
  }

  item.status = 'queued'
  item.error = ''
  item.progress = {
    current: item.completedChapterUrls.filter((url) => selectedUrls.includes(url)).length,
    total: selectedUrls.length,
    message: 'The chapter list is fresh; starting the queued job…'
  }
  historyEntry.status = 'queued'
  historyEntry.error = ''
  await persistDownloadState(item, historyEntry)
  return true
}

function parseDiscoveryQueueInputs(value: unknown): DiscoveryQueueInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('Add between 1 and 100 tracker novels or URLs at a time.')
  }

  return value.map((rawItem, index) => {
    if (typeof rawItem !== 'object' || rawItem === null) {
      throw new Error(`Queue item ${index + 1} is invalid.`)
    }
    const input = rawItem as Record<string, unknown>
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const author = typeof input.author === 'string' ? input.author.trim() : ''
    const origin = input.origin
    if (!title || title.length > 300) throw new Error(`Queue item ${index + 1} needs a title of 1–300 characters.`)
    if (author.length > 300) throw new Error(`Queue item ${index + 1} has an author longer than 300 characters.`)
    if (origin !== 'tracker' && origin !== 'manual') throw new Error(`Queue item ${index + 1} has an invalid origin.`)

    let trackerRow: DiscoveryQueueInput['trackerRow']
    if (input.trackerRow !== undefined) {
      if (typeof input.trackerRow !== 'object' || input.trackerRow === null) {
        throw new Error(`Queue item ${index + 1} has an invalid tracker association.`)
      }
      const row = input.trackerRow as Record<string, unknown>
      if (
        typeof row.stableId !== 'string' || !row.stableId.trim() || row.stableId.length > 200 ||
        typeof row.rowNumber !== 'number' || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 ||
        typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300 ||
        (row.alternativeNames !== undefined &&
          (typeof row.alternativeNames !== 'string' || row.alternativeNames.length > 5000)) ||
        typeof row.csvPath !== 'string' || !row.csvPath.trim() || row.csvPath.length > 2048
      ) {
        throw new Error(`Queue item ${index + 1} has an invalid tracker association.`)
      }
      trackerRow = {
        stableId: row.stableId.trim(),
        rowNumber: row.rowNumber,
        title: row.title.trim(),
        alternativeNames: row.alternativeNames,
        csvPath: row.csvPath
      }
    }
    if (origin === 'tracker' && !trackerRow) {
      throw new Error(`Queue item ${index + 1} is missing its tracker association.`)
    }

    return {
      title,
      author,
      sourceUrl: validateHttpUrl(input.sourceUrl),
      origin,
      trackerRow
    }
  })
}

function runLibraryScanWorker(
  worker: Worker,
  onProgress: (progress: LibraryProgress) => void
): Promise<void> {
  return new Promise((resolveScan, rejectScan) => {
    let settled = false
    let completed = false
    const resolveOnce = () => {
      if (settled) return
      settled = true
      resolveScan()
    }
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      rejectScan(error)
    }

    worker.on('message', (message: LibraryScanWorkerMessage) => {
      if (message.type === 'progress') {
        onProgress(message.progress)
      } else if (message.type === 'complete') {
        completed = true
      } else {
        rejectOnce(new Error(message.error))
      }
    })
    worker.once('error', (error) => rejectOnce(error))
    worker.once('exit', (code) => {
      if (settled) return
      if (code !== 0) rejectOnce(new Error(`Library scan worker exited unexpectedly (code ${code}).`))
      else if (completed) resolveOnce()
      else rejectOnce(new Error('Library scan worker exited without saving an index.'))
    })
  })
}

function runEpubMergeWorker(
  worker: Worker,
  onProgress: (progress: EpubMergeProgress) => void
): Promise<EpubMergeResult> {
  return new Promise((resolveMerge, rejectMerge) => {
    let result: EpubMergeResult | null = null
    let failure = ''
    let settled = false
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      rejectMerge(error)
    }

    worker.on('message', (message: {
      type: string
      result?: EpubMergeResult
      error?: string
      progress?: EpubMergeProgress
    }) => {
      if (message.type === 'progress' && message.progress) onProgress(message.progress)
      else if (message.type === 'complete' && message.result) result = message.result
      else if (message.type === 'error') failure = message.error || 'EPUB merge failed.'
    })
    worker.once('error', rejectOnce)
    worker.once('exit', (code) => {
      if (settled) return
      if (code !== 0) {
        rejectOnce(new Error(`EPUB merge worker exited unexpectedly (code ${code}).`))
      } else if (failure) {
        rejectOnce(new Error(failure))
      } else if (result) {
        settled = true
        resolveMerge(result)
      } else {
        rejectOnce(new Error('EPUB merge worker exited without creating an EPUB.'))
      }
    })
  })
}

function runEpubRepairWorker(
  worker: Worker,
  onProgress: (progress: EpubRepairProgress) => void
): Promise<EpubRepairResult> {
  return new Promise((resolveRepair, rejectRepair) => {
    let result: EpubRepairResult | null = null
    let failure = ''
    let settled = false
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      rejectRepair(error)
    }

    worker.on('message', (message: {
      type: string
      result?: EpubRepairResult
      error?: string
      progress?: EpubRepairProgress
    }) => {
      if (message.type === 'progress' && message.progress) onProgress(message.progress)
      else if (message.type === 'complete' && message.result) result = message.result
      else if (message.type === 'error') failure = message.error || 'EPUB repair failed.'
    })
    worker.once('error', rejectOnce)
    worker.once('exit', (code) => {
      if (settled) return
      if (code !== 0) {
        rejectOnce(new Error(`EPUB repair worker exited unexpectedly (code ${code}).`))
      } else if (failure) {
        rejectOnce(new Error(failure))
      } else if (result) {
        settled = true
        resolveRepair(result)
      } else {
        rejectOnce(new Error('EPUB repair worker exited without creating an EPUB.'))
      }
    })
  })
}

function parseGenerateInput(value: unknown): GenerateEpubInput {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid EPUB request.')
  const input = value as Record<string, unknown>
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const author = typeof input.author === 'string' ? input.author.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const coverUrlValue = typeof input.coverUrl === 'string' ? input.coverUrl.trim() : ''
  const alternativeNames = parseMetadataLabels(input.alternativeNames, 'Alternative names')
  const genres = parseMetadataLabels(input.genres, 'Genres')
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  const novelStatus = typeof input.novelStatus === 'string' ? input.novelStatus.trim() : ''
  const language = typeof input.language === 'string' ? input.language.trim() : ''
  if (input.description !== undefined && typeof input.description !== 'string') {
    throw new Error('The novel description must be text.')
  }
  if (input.coverUrl !== undefined && typeof input.coverUrl !== 'string') {
    throw new Error('The novel cover URL must be text.')
  }
  if (input.source !== undefined && typeof input.source !== 'string') {
    throw new Error('The novel source must be text.')
  }
  if (input.novelStatus !== undefined && typeof input.novelStatus !== 'string') {
    throw new Error('The novel status must be text.')
  }
  if (description.length > MAX_NOVEL_DESCRIPTION_LENGTH) {
    throw new Error(`The novel description must be ${MAX_NOVEL_DESCRIPTION_LENGTH.toLocaleString()} characters or fewer.`)
  }
  if (source.length > 300 || novelStatus.length > 300) {
    throw new Error('Novel source and status must be 300 characters or fewer.')
  }
  if (input.filename !== undefined && typeof input.filename !== 'string') {
    throw new Error('The EPUB filename must be text.')
  }
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  const sourceUrl = input.sourceUrl === undefined ? '' : validateHttpUrl(input.sourceUrl)
  const coverUrl = coverUrlValue ? validateHttpUrl(coverUrlValue) : ''
  const outputDirectory = typeof input.outputDirectory === 'string' ? input.outputDirectory : ''

  if (!title || title.length > 300) throw new Error('Enter a title of 1–300 characters.')
  if (author.length > 300) throw new Error('Author must be 300 characters or fewer.')
  if (filename.length > 255) throw new Error('The EPUB filename must be 255 characters or fewer.')
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) {
    throw new Error('Enter a valid language code, such as en or en-US.')
  }
  if (!approvedOutputDirectories.has(resolve(outputDirectory))) {
    throw new Error('Choose an output folder using the folder picker before creating the EPUB.')
  }
  if (
    !Array.isArray(input.chapters) ||
    input.chapters.length === 0 ||
    input.chapters.length > MAX_SELECTED_CHAPTERS
  ) {
    throw new Error(`Select between 1 and ${MAX_SELECTED_CHAPTERS.toLocaleString()} chapters.`)
  }
  let trackerRow: GenerateEpubInput['trackerRow']
  if (input.trackerRow !== undefined) {
    if (typeof input.trackerRow !== 'object' || input.trackerRow === null) {
      throw new Error('The selected tracker row is invalid.')
    }
    const row = input.trackerRow as Record<string, unknown>
    if (
      typeof row.stableId !== 'string' || !row.stableId.trim() || row.stableId.length > 200 ||
      typeof row.rowNumber !== 'number' || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 ||
      typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300 ||
      (row.alternativeNames !== undefined &&
        (typeof row.alternativeNames !== 'string' || row.alternativeNames.length > 5000)) ||
      typeof row.csvPath !== 'string' || !row.csvPath.trim() || row.csvPath.length > 2048
    ) {
      throw new Error('The selected tracker row is invalid.')
    }
    trackerRow = {
      stableId: row.stableId.trim(),
      rowNumber: row.rowNumber,
      title: row.title.trim(),
      alternativeNames: row.alternativeNames,
      csvPath: row.csvPath
    }
  }

  const chapters: ChapterLink[] = input.chapters.map((chapter, index) => {
    if (typeof chapter !== 'object' || chapter === null) throw new Error(`Chapter ${index + 1} is invalid.`)
    const item = chapter as Record<string, unknown>
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500) {
      throw new Error(`Chapter ${index + 1} needs a title of 1–500 characters.`)
    }
    return {
      id: `chapter-${index + 1}`,
      title: item.title.trim(),
      url: validateHttpUrl(item.url)
    }
  })

  return {
    title,
    author,
    description,
    coverUrl,
    alternativeNames,
    genres,
    source,
    novelStatus,
    language,
    filename: filename || undefined,
    sourceUrl: sourceUrl || undefined,
    outputDirectory: resolve(outputDirectory),
    chapters,
    trackerRow
  }
}

function parseMetadataLabels(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must contain no more than 100 values.`)
  }
  const labels = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length > 300) {
      throw new Error(`Each ${label.toLowerCase()} value must be text of 300 characters or fewer.`)
    }
    if (item.trim()) labels.add(item.trim())
  }
  return [...labels]
}

async function cancellableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('EPUB creation was cancelled.')
  if (milliseconds <= 0) return
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const deadline = Date.now() + milliseconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      rejectDelay(new Error('EPUB creation was cancelled.'))
    }
    const schedule = (): void => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        cleanup()
        resolveDelay()
        return
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    schedule()
  })
}

function canRetryChapter(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 408 || error.status === 429 || error.status >= 500
  const message = errorMessage(error)
  return !/manual verification|no readable chapter content|HTTP 4\d\d/i.test(message)
}

async function persistDownloadState(
  item: DiscoveryQueueItem,
  historyEntry: DownloadHistoryEntry,
  checkpoint = true
): Promise<void> {
  const now = new Date().toISOString()
  item.updatedAt = now
  historyEntry.updatedAt = now
  if (checkpoint) {
    await persistDiscoveryQueue()
    await persistHistoryEntry(historyEntry)
  }
  notifyDiscoveryQueueChanged()
}

async function runQueuedDownload(
  itemId: string,
  controller: AbortController,
  historyEntry: DownloadHistoryEntry
): Promise<void> {
  const item = discoveryQueue.find((candidate) => candidate.id === itemId)
  if (!item || !item.downloadOptions) return
  const options = item.downloadOptions
  const selectedChapters = item.chapters.filter((chapter) => chapter.selected)
  const selectedChapterUrls = new Set(selectedChapters.map((chapter) => chapter.url))
  const completedChapterUrls = new Set(item.completedChapterUrls)
  let completedSelectedChapterCount = [...completedChapterUrls]
    .filter((url) => selectedChapterUrls.has(url)).length
  let chaptersSinceCheckpoint = 0
  let lastCheckpointAt = Date.now()

  const persistChapterProgress = async (): Promise<void> => {
    chaptersSinceCheckpoint += 1
    const now = Date.now()
    const shouldCheckpoint = chaptersSinceCheckpoint >= 25 || now - lastCheckpointAt >= 5000
    await persistDownloadState(item, historyEntry, shouldCheckpoint)
    if (shouldCheckpoint) {
      chaptersSinceCheckpoint = 0
      lastCheckpointAt = now
    }
  }

  try {
    if (selectedChapters.length === 0) throw new Error('Select at least one chapter before queueing this EPUB.')
    for (let index = 0; index < selectedChapters.length; index += 1) {
      const chapter = selectedChapters[index]
      const active = activeDownloads.get(itemId)
      if (!active || active.requestedAction !== 'none' || controller.signal.aborted) break

      let savedContent: ChapterContent | null = null
      if (item.repackageOnly) {
        item.progress = {
          current: index,
          total: selectedChapters.length,
          message: `Validating saved chapter ${index + 1} of ${selectedChapters.length}: ${chapter.title}`
        }
        await persistDownloadState(item, historyEntry, false)
        savedContent = await readChapterArtifact(dataDirectory(), itemId, chapter.url)
        if (!savedContent || savedContent.url !== chapter.url) {
          throw new Error(`Saved chapter content is missing or invalid for "${chapter.title}".`)
        }
        if (!completedChapterUrls.has(chapter.url)) {
          completedChapterUrls.add(chapter.url)
          item.completedChapterUrls.push(chapter.url)
          if (selectedChapterUrls.has(chapter.url)) completedSelectedChapterCount += 1
        }
      } else {
        try {
          savedContent = await readChapterArtifact(dataDirectory(), itemId, chapter.url)
          if (savedContent && savedContent.url !== chapter.url) {
            console.warn(`Saved chapter artifact for ${chapter.url} has a mismatched URL and will be fetched again.`)
            savedContent = null
          }
        } catch (error) {
          console.warn(`Saved chapter artifact for ${chapter.url} will be fetched again:`, errorMessage(error))
        }
        if (savedContent && !completedChapterUrls.has(chapter.url)) {
          completedChapterUrls.add(chapter.url)
          item.completedChapterUrls.push(chapter.url)
          if (selectedChapterUrls.has(chapter.url)) completedSelectedChapterCount += 1
        } else if (!savedContent && completedChapterUrls.has(chapter.url)) {
          completedChapterUrls.delete(chapter.url)
          item.completedChapterUrls = item.completedChapterUrls.filter((url) => url !== chapter.url)
          if (selectedChapterUrls.has(chapter.url)) completedSelectedChapterCount -= 1
        }
      }

      if (!savedContent) {
        item.progress = {
          current: item.completedChapterUrls.length,
          total: selectedChapters.length,
          message: `Fetching chapter ${index + 1} of ${selectedChapters.length}: ${chapter.title}`
        }
        await persistDownloadState(item, historyEntry, false)

        let lastError: unknown = new Error('Chapter could not be fetched.')
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            savedContent = await fetchChapterContentWithBrowserFallback(chapter, controller.signal)
            break
          } catch (error) {
            if (controller.signal.aborted) break
            lastError = error
            if (attempt === 2 || !canRetryChapter(error)) break
            const retryAfter = error instanceof HttpStatusError ? error.retryAfterMs : null
            const delay = retryAfter ?? 1000 * (2 ** attempt)
            try {
              await cancellableDelay(delay, controller.signal)
            } catch {
              break
            }
          }
        }

        if (controller.signal.aborted) break
        if (savedContent) {
          await writeChapterArtifact(dataDirectory(), itemId, savedContent)
          if (!completedChapterUrls.has(chapter.url)) {
            completedChapterUrls.add(chapter.url)
            item.completedChapterUrls.push(chapter.url)
            if (selectedChapterUrls.has(chapter.url)) completedSelectedChapterCount += 1
          }
          item.failedChapters = item.failedChapters.filter((failed) => failed.url !== chapter.url)
        } else {
          item.failedChapters = [
            ...item.failedChapters.filter((failed) => failed.url !== chapter.url),
            { url: chapter.url, title: chapter.title, error: errorMessage(lastError) }
          ]
          item.error = `${item.failedChapters.length} chapter(s) failed. Retry failed chapters to continue.`
        }
      }

      historyEntry.completedChapters = completedSelectedChapterCount
      item.progress = {
        current: historyEntry.completedChapters,
        total: selectedChapters.length,
        message: savedContent
          ? item.repackageOnly
            ? `Validated saved content for ${chapter.title}`
            : `Fetched ${chapter.title}`
          : `Failed ${chapter.title}`
      }
      await persistChapterProgress()
    }

    const requestedAction = activeDownloads.get(itemId)?.requestedAction ?? 'cancel'
    if (requestedAction === 'pause') {
      item.status = 'paused'
      item.progress = { ...(item.progress ?? { current: 0, total: selectedChapters.length, message: '' }), message: 'Paused' }
      historyEntry.status = 'paused'
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      return
    }
    if (requestedAction === 'cancel' || controller.signal.aborted) {
      item.status = 'cancelled'
      item.progress = { ...(item.progress ?? { current: 0, total: selectedChapters.length, message: '' }), message: 'Cancelled' }
      historyEntry.status = 'cancelled'
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      return
    }
    if (item.failedChapters.length > 0) {
      item.status = item.completedChapterUrls.length > 0 ? 'partially-completed' : 'failed'
      item.progress = {
        current: historyEntry.completedChapters,
        total: selectedChapters.length,
        message: `${item.failedChapters.length} chapter(s) failed`
      }
      historyEntry.status = item.status
      historyEntry.error = `${item.failedChapters.length} chapter(s) failed.`
      await persistDownloadState(item, historyEntry)
      return
    }

    const chapters: ChapterContent[] = []
    for (const chapter of selectedChapters) {
      const content = await readChapterArtifact(dataDirectory(), itemId, chapter.url)
      if (!content || content.url !== chapter.url) {
        throw new Error(`Saved chapter content is missing or invalid for "${chapter.title}".`)
      }
      chapters.push(content)
    }
    let cover: ChapterImage | undefined
    if (options.coverUrl) {
      if (item.repackageOnly) {
        cover = (await readCoverArtifact(dataDirectory(), itemId)) ?? undefined
        if (!cover) throw new Error('Saved cover content is missing; retry this EPUB online before repackaging.')
      } else {
        try {
          cover = (await readCoverArtifact(dataDirectory(), itemId)) ?? undefined
        } catch (error) {
          console.warn(`Saved cover artifact for queue item ${itemId} will be fetched again:`, errorMessage(error))
        }
        if (!cover) {
          item.progress = {
            current: selectedChapters.length,
            total: selectedChapters.length,
            message: 'Fetching novel cover…'
          }
          await persistDownloadState(item, historyEntry)
          let lastError: unknown = new Error('The novel cover could not be fetched.')
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              cover = await fetchImageResource(
                options.coverUrl,
                options.sourceUrl || item.sourceUrl,
                controller.signal
              )
              await writeCoverArtifact(dataDirectory(), itemId, cover)
              break
            } catch (error) {
              if (controller.signal.aborted) break
              lastError = error
              if (attempt === 2 || !canRetryChapter(error)) break
              const retryAfter = error instanceof HttpStatusError ? error.retryAfterMs : null
              try {
                await cancellableDelay(retryAfter ?? 1000 * (2 ** attempt), controller.signal)
              } catch {
                break
              }
            }
          }
          if (!cover) {
            if (controller.signal.aborted) throw new Error('EPUB creation was cancelled.')
            throw lastError
          }
        }
      }
    }
    item.progress = {
      current: selectedChapters.length,
      total: selectedChapters.length,
      message: 'Validating and packaging EPUB…'
    }
    await persistDownloadState(item, historyEntry)
    const result = await writeEpub(
      options.outputDirectory,
      options.title,
      options.author,
      options.language,
      chapters,
      options.filename,
      controller.signal,
      options.epubCss,
      {
        description: options.description,
        alternativeNames: options.alternativeNames,
        genres: options.genres,
        source: options.source,
        novelStatus: options.novelStatus,
        sourceUrl: options.sourceUrl || item.sourceUrl,
        cover
      }
    )
    item.status = 'completed'
    item.repackageOnly = false
    item.outputPath = result.outputPath
    item.error = ''
    item.progress = { current: selectedChapters.length, total: selectedChapters.length, message: 'Completed' }
    historyEntry.status = 'completed'
    historyEntry.outputPath = result.outputPath
    historyEntry.error = ''
    await persistDownloadState(item, historyEntry)
    await removeChapterArtifacts(dataDirectory(), itemId).catch((error: unknown) => {
      console.warn(`Completed chapter artifacts for queue item ${itemId} could not be removed:`, errorMessage(error))
    })
  } catch (error) {
    const requestedAction = activeDownloads.get(itemId)?.requestedAction ?? 'none'
    if (requestedAction === 'pause' || requestedAction === 'cancel') {
      item.status = requestedAction === 'pause' ? 'paused' : 'cancelled'
      historyEntry.status = requestedAction === 'pause' ? 'paused' : 'cancelled'
      historyEntry.error = ''
    } else {
      item.status = item.completedChapterUrls.length > 0 ? 'partially-completed' : 'failed'
      item.error = errorMessage(error)
      historyEntry.status = item.status
      historyEntry.error = item.error
      console.error(`Queued EPUB job ${itemId} failed:`, error)
    }
    item.progress = {
      current: historyEntry.completedChapters,
      total: historyEntry.selectedChapterCount,
      message: item.status
    }
    try {
      await persistDownloadState(item, historyEntry)
    } catch (saveError) {
      console.error(`Queued EPUB job ${itemId} state could not be saved:`, saveError)
    }
  }
}

async function pumpDownloadQueue(): Promise<void> {
  if (downloadPumpRunning) {
    downloadPumpRequested = true
    return
  }
  downloadPumpRunning = true
  try {
    const settings = await readSettings(dataDirectory())
    if (
      !Number.isInteger(settings.maxSimultaneousDownloads) ||
      settings.maxSimultaneousDownloads < MIN_SIMULTANEOUS_DOWNLOADS ||
      settings.maxSimultaneousDownloads > MAX_SIMULTANEOUS_DOWNLOADS
    ) {
      throw new Error(
        `Maximum simultaneous novel downloads must be from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
      )
    }
    while (activeDownloads.size < settings.maxSimultaneousDownloads) {
      const item = discoveryQueue
        .filter((candidate) => candidate.status === 'queued' && candidate.downloadOptions)
        .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))[0]
      if (!item) break
      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      const currentHead = discoveryQueue
        .filter((candidate) => candidate.status === 'queued' && candidate.downloadOptions)
        .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))[0]
      if (item.status !== 'queued' || currentHead?.id !== item.id) continue
      if (!historyEntry) {
        item.status = 'failed'
        item.error = 'The saved job history entry is missing.'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        continue
      }
      if (!item.repackageOnly && discoverySnapshotIsStale(item.discoveredAt, settings.discoveryFreshnessHours)) {
        try {
          await revalidateStaleQueuedJob(item, historyEntry)
        } catch (error) {
          item.status = 'failed'
          item.error = `The chapter list could not be refreshed before the EPUB job started: ${errorMessage(error)}`
          historyEntry.status = 'failed'
          historyEntry.error = item.error
          try {
            await persistDownloadState(item, historyEntry)
          } catch (saveError) {
            console.error(`Stale EPUB job ${item.id} failure state could not be saved:`, saveError)
            notifyDiscoveryQueueChanged()
          }
        }
        continue
      }
      const controller = new AbortController()
      activeDownloads.set(item.id, { controller, requestedAction: 'none' })
      item.status = 'downloading'
      item.error = ''
      item.progress = {
        current: historyEntry.completedChapters,
        total: historyEntry.selectedChapterCount,
        message: 'Starting download…'
      }
      historyEntry.status = 'running'
      historyEntry.error = ''
      try {
        await persistDownloadState(item, historyEntry)
      } catch (error) {
        activeDownloads.delete(item.id)
        item.status = 'failed'
        item.error = `The queued job could not be started: ${errorMessage(error)}`
        historyEntry.status = 'failed'
        historyEntry.error = item.error
        console.error(`Queued EPUB job ${item.id} could not be started:`, error)
        await persistDiscoveryQueue().catch((saveError: unknown) => {
          console.error(`Queued EPUB job ${item.id} failure state could not be saved:`, saveError)
        })
        await persistHistoryEntry(historyEntry).catch((saveError: unknown) => {
          console.error(`Queued EPUB job ${item.id} failure history could not be saved:`, saveError)
        })
        notifyDiscoveryQueueChanged()
        continue
      }
      void runQueuedDownload(item.id, controller, historyEntry).finally(() => {
        activeDownloads.delete(item.id)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
      })
    }
  } catch (error) {
    console.error('Download queue scheduler failed:', error)
    const history = await readDownloadHistory(dataDirectory()).catch((readError: unknown) => {
      console.error('Download history could not be loaded after a scheduler failure:', readError)
      return []
    })
    for (const item of discoveryQueue) {
      if (item.status === 'queued') {
        item.status = 'failed'
        item.error = errorMessage(error)
        item.updatedAt = new Date().toISOString()
        const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
        if (historyEntry) {
          historyEntry.status = 'failed'
          historyEntry.error = item.error
          historyEntry.updatedAt = item.updatedAt
          await persistHistoryEntry(historyEntry).catch((saveError: unknown) => {
            console.error(`Download history for ${item.id} could not be updated:`, saveError)
          })
        }
      }
    }
    await persistDiscoveryQueue().catch((saveError: unknown) => {
      console.error('Download queue scheduler failure could not be saved:', saveError)
    })
    notifyDiscoveryQueueChanged()
  } finally {
    downloadPumpRunning = false
    if (downloadPumpRequested) {
      downloadPumpRequested = false
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
    }
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('unresponsive', () => {
    console.error('Renderer became unresponsive.')
  })
  mainWindow.webContents.on('responsive', () => {
    console.info('Renderer became responsive.')
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason, details.exitCode)
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const current = new URL(mainWindow!.webContents.getURL())
      const next = new URL(target)
      if (next.origin !== current.origin || next.protocol !== current.protocol) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('chapter:discover', async (event, value: unknown): Promise<Result<Awaited<ReturnType<typeof discoverChapters>>>> => {
    try {
      return {
        ok: true,
        value: await discoverChapters(value, (progress) =>
          sendToCurrentFrame(event.sender, event.senderFrame, 'job:progress', progress)
        )
      }
    } catch (error) {
      console.error('Chapter discovery failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('browser:open-verification', async (_event, value: unknown): Promise<Result<BrowserSessionInfo>> => {
    try {
      return { ok: true, value: await openVerificationBrowser(value, dataDirectory()) }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('browser:discover', async (event, value: unknown): Promise<Result<Awaited<ReturnType<typeof discoverChapters>>>> => {
    const controller = new AbortController()
    const operationId = `renderer:${event.sender.id}`
    if (activeBrowserDiscoveries.has(operationId)) {
      return { ok: false, error: 'Browser-assisted discovery is already running.' }
    }
    activeBrowserDiscoveries.set(operationId, controller)
    try {
      return {
        ok: true,
        value: await discoverChaptersUsingPageLoader(value, readBrowserPage, undefined, controller.signal)
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    } finally {
      activeBrowserDiscoveries.delete(operationId)
    }
  })

  ipcMain.handle('browser:cancel-discovery', async (event, rawQueueItemId: unknown): Promise<void> => {
    const operationId = typeof rawQueueItemId === 'string'
      ? `queue:${rawQueueItemId}`
      : `renderer:${event.sender.id}`
    activeBrowserDiscoveries.get(operationId)?.abort()
  })

  ipcMain.handle('browser:clear-session', async (): Promise<Result<void>> => {
    try {
      await clearBrowserSession(dataDirectory())
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('dialog:choose-output-directory', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose EPUB output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await stat(directory)
    if (!details.isDirectory()) throw new Error('The selected output path is not a folder.')
    approvedOutputDirectories.add(directory)
    const settings = await readSettings(dataDirectory())
    settings.outputDirectory = directory
    await writeSettings(dataDirectory(), settings)
    return directory
  })

  ipcMain.handle('settings:get', async (): Promise<AppSettings> => readSettings(dataDirectory()))

  ipcMain.handle('settings:epub-css', async (_event, rawCss: unknown): Promise<Result<AppSettings>> => {
    try {
      if (typeof rawCss !== 'string' || rawCss.length > MAX_EPUB_CSS_LENGTH) {
        throw new Error(`EPUB CSS must be text of at most ${MAX_EPUB_CSS_LENGTH.toLocaleString()} characters.`)
      }
      const settings = await readSettings(dataDirectory())
      settings.epubCss = rawCss
      await writeSettings(dataDirectory(), settings)
      return { ok: true, value: settings }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('settings:app-theme', async (_event, rawTheme: unknown): Promise<Result<AppSettings>> => {
    try {
      if (rawTheme !== 'light' && rawTheme !== 'dark') {
        throw new Error('The app theme must be light or dark.')
      }
      const settings = await readSettings(dataDirectory())
      settings.appTheme = rawTheme
      await writeSettings(dataDirectory(), settings)
      return { ok: true, value: settings }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('settings:download-concurrency', async (_event, rawValue: unknown): Promise<Result<AppSettings>> => {
    try {
      if (
        typeof rawValue !== 'number' ||
        !Number.isInteger(rawValue) ||
        rawValue < MIN_SIMULTANEOUS_DOWNLOADS ||
        rawValue > MAX_SIMULTANEOUS_DOWNLOADS
      ) {
        throw new Error(
          `Maximum simultaneous downloads must be a whole number from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
        )
      }
      const settings = await readSettings(dataDirectory())
      settings.maxSimultaneousDownloads = rawValue
      await writeSettings(dataDirectory(), settings)
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: settings }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    'settings:library-scan-options',
    async (_event, rawScanOldFolder: unknown): Promise<Result<AppSettings>> => {
      try {
        if (typeof rawScanOldFolder !== 'boolean') {
          throw new Error('The Old-folder scan option must be enabled or disabled.')
        }
        const settings = await readSettings(dataDirectory())
        settings.scanOldFolder = rawScanOldFolder
        await writeSettings(dataDirectory(), settings)
        return { ok: true, value: settings }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle('settings:discovery-freshness', async (_event, rawValue: unknown): Promise<Result<AppSettings>> => {
    try {
      if (
        typeof rawValue !== 'number' ||
        !Number.isInteger(rawValue) ||
        rawValue < MIN_DISCOVERY_FRESHNESS_HOURS ||
        rawValue > MAX_DISCOVERY_FRESHNESS_HOURS
      ) {
        throw new Error(
          `The discovery freshness window must be a whole number from ${MIN_DISCOVERY_FRESHNESS_HOURS} to ${MAX_DISCOVERY_FRESHNESS_HOURS} hours.`
        )
      }
      const settings = await readSettings(dataDirectory())
      settings.discoveryFreshnessHours = rawValue
      await writeSettings(dataDirectory(), settings)
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: settings }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('dialog:choose-library-root', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose historical library root',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The selected library root is not a folder.')

    const settings = await readSettings(dataDirectory())
    settings.libraryRoot = directory
    const downloaded = resolve(directory, 'Downloaded')
    try {
      const downloadedDetails = await lstat(downloaded)
      if (downloadedDetails.isDirectory() && !downloadedDetails.isSymbolicLink() && !settings.outputDirectory) {
        settings.outputDirectory = await realpath(downloaded)
        approvedOutputDirectories.add(settings.outputDirectory)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await writeSettings(dataDirectory(), settings)
    return directory
  })

  ipcMain.handle('dialog:choose-tracker-csv', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Novel Tracker CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = await realpath(result.filePaths[0])
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('The selected CSV path is not a file.')
    const settings = await readSettings(dataDirectory())
    settings.trackerCsvPath = path
    await writeSettings(dataDirectory(), settings)
    return path
  })

  ipcMain.handle('tracker:list', async (): Promise<Result<Awaited<ReturnType<typeof readTrackerCsv>>>> => {
    try {
      const settings = await readSettings(dataDirectory())
      if (!settings.trackerCsvPath) throw new Error('Choose a tracker CSV file in Configuration first.')
      return { ok: true, value: await readTrackerCsv(settings.trackerCsvPath) }
    } catch (error) {
      console.error('Tracker CSV load failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('download-history:list', async () => readDownloadHistory(dataDirectory()))

  ipcMain.handle('discovery-queue:list', () => copyDiscoveryQueue())

  ipcMain.handle('discovery-queue:add', async (_event, rawItems: unknown): Promise<Result<DiscoveryQueueItem[]>> => {
    try {
      const inputs = parseDiscoveryQueueInputs(rawItems)
      const existingUrls = new Set(discoveryQueue.map((item) => item.sourceUrl))
      const added: DiscoveryQueueItem[] = []
      for (const input of inputs) {
        if (existingUrls.has(input.sourceUrl)) continue
        existingUrls.add(input.sourceUrl)
        const now = new Date().toISOString()
        added.push({
          id: randomUUID(),
          title: input.title,
          author: input.author,
          description: '',
          coverUrl: '',
          alternativeNames: [],
          genres: [],
          source: '',
          novelStatus: '',
          sourceUrl: input.sourceUrl,
          origin: input.origin,
          trackerRow: input.trackerRow ?? null,
          status: 'discovering',
          parserName: '',
          chapters: [],
          discoveryChanges: '',
          recommendationSummary: '',
          overlapAllowed: false,
          includeOverlap: false,
          overlapCount: 10,
          downloadOptions: null,
          repackageOnly: false,
          queuedAt: '',
          completedChapterUrls: [],
          failedChapters: [],
          outputPath: '',
          downloadHistoryId: '',
          progress: null,
          error: '',
          discoveredAt: '',
          updatedAt: now
        })
      }

      if (added.length > 0) {
        discoveryQueue.push(...added)
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(...added.map((item) => item.id))
        pumpDiscoveryQueue()
      }
      return { ok: true, value: added }
    } catch (error) {
      console.error('Discovery queue update failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('discovery-queue:retry', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid discovery queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item) throw new Error('The selected discovery queue item no longer exists.')
      if (item.status !== 'failed' || item.downloadOptions) {
        throw new Error('Only failed discovery items can be retried.')
      }
      const previousError = item.error
      const previousUpdatedAt = item.updatedAt
      item.status = 'discovering'
      item.error = ''
      item.updatedAt = new Date().toISOString()
      try {
        await persistDiscoveryQueue()
      } catch (error) {
        item.status = 'failed'
        item.error = previousError
        item.updatedAt = previousUpdatedAt
        throw error
      }
      notifyDiscoveryQueueChanged()
      pendingDiscoveries.push(item.id)
      pumpDiscoveryQueue()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('Discovery queue retry failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('discovery-queue:retry-browser', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid discovery queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item) throw new Error('The selected discovery queue item no longer exists.')
      if (item.status !== 'failed' || item.downloadOptions) {
        throw new Error('Only failed discovery items can be retried with the browser.')
      }
      const previousError = item.error
      const previousUpdatedAt = item.updatedAt
      item.status = 'discovering'
      item.error = ''
      item.updatedAt = new Date().toISOString()
      try {
        await persistDiscoveryQueue()
      } catch (error) {
        item.status = 'failed'
        item.error = previousError
        item.updatedAt = previousUpdatedAt
        throw error
      }
      browserAssistedDiscoveries.add(item.id)
      notifyDiscoveryQueueChanged()
      pendingDiscoveries.push(item.id)
      pumpDiscoveryQueue()
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('discovery-queue:refresh', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid discovery queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item) throw new Error('The selected discovery queue item no longer exists.')
      if (item.status !== 'needs-review' && item.status !== 'ready') {
        throw new Error('Only reviewed discovery items can be refreshed.')
      }
      const previousUpdatedAt = item.updatedAt
      const previousStatus = item.status
      item.status = 'discovering'
      item.updatedAt = new Date().toISOString()
      try {
        await persistDiscoveryQueue()
      } catch (error) {
        item.status = previousStatus
        item.updatedAt = previousUpdatedAt
        throw error
      }
      notifyDiscoveryQueueChanged()
      pendingDiscoveries.push(item.id)
      pumpDiscoveryQueue()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('Discovery queue refresh failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    'discovery-queue:accept-recommendations',
    async (_event, rawId: unknown, rawIncludeOverlap: unknown, rawOverlapCount: unknown): Promise<Result<void>> => {
      try {
        if (
          typeof rawId !== 'string' ||
          typeof rawIncludeOverlap !== 'boolean' ||
          typeof rawOverlapCount !== 'number' ||
          !Number.isInteger(rawOverlapCount) ||
          rawOverlapCount < 0 ||
          rawOverlapCount > 1000
        ) {
          throw new Error('Invalid recommendation settings.')
        }
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || (item.status !== 'needs-review' && item.status !== 'ready')) {
          throw new Error('The selected item is not ready for recommendations.')
        }
        if (rawIncludeOverlap && !item.overlapAllowed) {
          throw new Error('Overlap cannot be applied because archive coverage is uncertain or has unresolved gaps.')
        }
        const libraryIndex = await readLibraryIndex(dataDirectory())
        const recommendation = recommendArchiveCoverage(
          item,
          libraryIndex?.files ?? [],
          rawIncludeOverlap,
          rawOverlapCount
        )
        if (rawIncludeOverlap && !recommendation.overlapAllowed) {
          throw new Error('Overlap cannot be applied because archive coverage is uncertain or has unresolved gaps.')
        }
        item.chapters = recommendation.chapters.map((chapter) => ({
          ...chapter,
          selected: chapter.recommended || chapter.deliberateOverlap
        }))
        item.includeOverlap = rawIncludeOverlap
        item.overlapCount = rawOverlapCount
        item.overlapAllowed = recommendation.overlapAllowed
        item.recommendationSummary = recommendation.summary
        item.status = 'ready'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
      } catch (error) {
        console.error('Archive recommendation acceptance failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle('discovery-queue:remove', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid discovery queue item.')
      const index = discoveryQueue.findIndex((candidate) => candidate.id === rawId)
      if (index < 0) throw new Error('The selected discovery queue item no longer exists.')
      if (['discovering', 'queued', 'downloading', 'paused'].includes(discoveryQueue[index].status)) {
        throw new Error('Finish or cancel the active work before removing this item.')
      }
      const [removedItem] = discoveryQueue.splice(index, 1)
      try {
        await persistDiscoveryQueue()
      } catch (error) {
        discoveryQueue.splice(index, 0, removedItem)
        throw error
      }
      if (removedItem.downloadOptions) {
        await removeChapterArtifacts(dataDirectory(), removedItem.id).catch((error: unknown) => {
          console.warn(`Chapter artifacts for removed queue item ${removedItem.id} could not be removed:`, errorMessage(error))
        })
      }
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('Discovery queue item removal failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('discovery-queue:clear', async (): Promise<Result<void>> => {
    try {
      if (discoveryQueue.some((item) => ['discovering', 'queued', 'downloading', 'paused'].includes(item.status))) {
        throw new Error('Finish or cancel active work before clearing the queue.')
      }
      const previousQueue = discoveryQueue
      discoveryQueue = []
      try {
        await persistDiscoveryQueue()
      } catch (error) {
        discoveryQueue = previousQueue
        throw error
      }
      for (const item of previousQueue) {
        if (item.downloadOptions) {
          await removeChapterArtifacts(dataDirectory(), item.id).catch((error: unknown) => {
            console.warn(`Chapter artifacts for cleared queue item ${item.id} could not be removed:`, errorMessage(error))
          })
        }
      }
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('Discovery queue clear failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    'discovery-queue:update-selection',
    async (_event, rawId: unknown, rawSelectedUrls: unknown): Promise<Result<void>> => {
      try {
        if (
          typeof rawId !== 'string' ||
          !Array.isArray(rawSelectedUrls) ||
          rawSelectedUrls.length > MAX_SELECTED_CHAPTERS
        ) {
          throw new Error('Invalid chapter selection update.')
        }
        const selectedUrls = new Set(
          rawSelectedUrls.map((url) => {
            if (typeof url !== 'string') throw new Error('Invalid chapter selection update.')
            return validateHttpUrl(url)
          })
        )
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || (item.status !== 'needs-review' && item.status !== 'ready')) {
          throw new Error('The selected discovery queue item is no longer ready for review.')
        }
        const availableUrls = new Set(item.chapters.map((chapter) => chapter.url))
        if ([...selectedUrls].some((url) => !availableUrls.has(url))) {
          throw new Error('The chapter selection no longer matches the saved discovery snapshot.')
        }
        for (const chapter of item.chapters) chapter.selected = selectedUrls.has(chapter.url)
        item.status = 'ready'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
      } catch (error) {
        console.error('Discovery queue selection update failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(
    'download-queue:enqueue',
    async (_event, rawInput: unknown, rawQueueItemId: unknown): Promise<Result<{ queueItemId: string; historyId: string }>> => {
      let previousItem: DiscoveryQueueItem | null = null
      let createdItemId = ''
      let queueMutated = false
      let historyEntry: DownloadHistoryEntry | null = null
      try {
        const input = parseGenerateInput(rawInput)
        const settings = await readSettings(dataDirectory())
        if (rawQueueItemId !== undefined && typeof rawQueueItemId !== 'string') {
          throw new Error('Invalid discovery queue item.')
        }
        let item = typeof rawQueueItemId === 'string'
          ? discoveryQueue.find((candidate) => candidate.id === rawQueueItemId)
          : undefined
        if (rawQueueItemId !== undefined && !item) {
          throw new Error('The selected discovery queue item no longer exists.')
        }
        if (item && item.status !== 'needs-review' && item.status !== 'ready') {
          throw new Error('This novel is not ready to be queued for EPUB creation.')
        }

        const sourceUrl = input.sourceUrl || item?.sourceUrl || input.chapters[0].url
        const outputPath = expectedOutputPath(input.outputDirectory, input.title, input.filename ?? '', input.chapters)
        const outputConflict = discoveryQueue.find((candidate) => {
          if (candidate.id === item?.id || !candidate.downloadOptions || candidate.status === 'completed') return false
          const selectedChapters = candidate.chapters.filter((chapter) => chapter.selected)
          return expectedOutputPath(
            candidate.downloadOptions.outputDirectory,
            candidate.downloadOptions.title,
            candidate.downloadOptions.filename,
            selectedChapters
          ) === outputPath
        })
        if (outputConflict) {
          throw new Error(
            `Another saved EPUB job uses this output filename. Remove or complete "${outputConflict.title}" before reusing it.`
          )
        }
        if (!item) {
          const libraryIndex = await readLibraryIndex(dataDirectory())
          const duplicate = discoveryQueue.find(
            (candidate) =>
              candidate.sourceUrl === sourceUrl &&
              ['needs-review', 'ready', 'queued', 'downloading', 'paused'].includes(candidate.status)
          )
          if (duplicate) throw new Error('A job for this novel or source is already active in the queue.')
          const now = new Date().toISOString()
          const createdItem: DiscoveryQueueItem = {
            id: randomUUID(),
            title: input.title,
            author: input.author,
            description: input.description ?? '',
            coverUrl: input.coverUrl ?? '',
            alternativeNames: [...(input.alternativeNames ?? [])],
            genres: [...(input.genres ?? [])],
            source: input.source ?? '',
            novelStatus: input.novelStatus ?? '',
            sourceUrl,
            origin: 'manual',
            trackerRow: input.trackerRow ?? null,
            status: 'needs-review',
            parserName: 'Manual chapter selection',
            chapters: input.chapters.map((chapter) => ({
              ...chapter,
              selected: true,
              archiveStatus: 'missing',
              archiveSources: [],
              chapterNumber: null,
              archiveGap: false,
              recommended: true,
              deliberateOverlap: false
            })),
            discoveryChanges: '',
            recommendationSummary: '',
            overlapAllowed: false,
            includeOverlap: false,
            overlapCount: 10,
            downloadOptions: null,
            repackageOnly: false,
            queuedAt: '',
            completedChapterUrls: [],
            failedChapters: [],
            outputPath: '',
            downloadHistoryId: '',
            progress: null,
            error: '',
            discoveredAt: now,
            updatedAt: now
          }
          item = createdItem
          discoveryQueue.push(createdItem)
          createdItemId = createdItem.id
          queueMutated = true
          const recommendation = recommendArchiveCoverage(createdItem, libraryIndex?.files ?? [])
          createdItem.chapters = recommendation.chapters
          createdItem.overlapAllowed = recommendation.overlapAllowed
          createdItem.recommendationSummary = recommendation.summary
        } else {
          const existingItem = item
          previousItem = copyDiscoveryQueue().find((candidate) => candidate.id === existingItem.id) ?? null
          if (input.sourceUrl && validateHttpUrl(input.sourceUrl) !== existingItem.sourceUrl) {
            throw new Error('The source URL does not match the selected queue item.')
          }
          const duplicate = discoveryQueue.find(
            (candidate) =>
              candidate.id !== existingItem.id &&
              candidate.sourceUrl === sourceUrl &&
              ['queued', 'downloading', 'paused'].includes(candidate.status)
          )
          if (duplicate) throw new Error('A job for this novel or source is already active in the queue.')
          const selectedUrls = new Set(input.chapters.map((chapter) => chapter.url))
          const availableUrls = new Set(existingItem.chapters.map((chapter) => chapter.url))
          if ([...selectedUrls].some((url) => !availableUrls.has(url))) {
            throw new Error('The selected chapters no longer match the saved discovery snapshot.')
          }
          queueMutated = true
          for (const chapter of existingItem.chapters) chapter.selected = selectedUrls.has(chapter.url)
          existingItem.title = input.title
          existingItem.author = input.author
          existingItem.description = input.description ?? existingItem.description
          existingItem.coverUrl = input.coverUrl ?? existingItem.coverUrl
          existingItem.alternativeNames = [...(input.alternativeNames ?? existingItem.alternativeNames)]
          existingItem.genres = [...(input.genres ?? existingItem.genres)]
          existingItem.source = input.source ?? existingItem.source
          existingItem.novelStatus = input.novelStatus ?? existingItem.novelStatus
          existingItem.trackerRow = input.trackerRow ?? existingItem.trackerRow
        }

        const queueItem = item
        if (!queueItem) throw new Error('The EPUB job could not be added to the queue.')
        const now = new Date().toISOString()
        historyEntry = {
          id: randomUUID(),
          queueItemId: queueItem.id,
          title: input.title,
          author: input.author,
          sourceUrl,
          trackerRow: input.trackerRow ?? null,
          selectedChapterCount: input.chapters.length,
          status: 'queued',
          completedChapters: 0,
          outputPath: '',
          error: '',
          startedAt: now,
          updatedAt: now
        }
        queueItem.status = 'queued'
        queueItem.downloadOptions = {
          title: input.title,
          author: input.author,
          description: input.description ?? queueItem.description,
          coverUrl: input.coverUrl ?? queueItem.coverUrl,
          alternativeNames: [...(input.alternativeNames ?? queueItem.alternativeNames)],
          genres: [...(input.genres ?? queueItem.genres)],
          source: input.source ?? queueItem.source,
          novelStatus: input.novelStatus ?? queueItem.novelStatus,
          language: input.language,
          filename: input.filename ?? '',
          sourceUrl,
          outputDirectory: input.outputDirectory,
          epubCss: settings.epubCss
        }
        queueItem.queuedAt = now
        queueItem.completedChapterUrls = []
        queueItem.failedChapters = []
        queueItem.outputPath = ''
        queueItem.downloadHistoryId = historyEntry.id
        queueItem.progress = { current: 0, total: input.chapters.length, message: 'Queued for download' }
        queueItem.error = ''
        queueItem.updatedAt = now

        await persistHistoryEntry(historyEntry)
        try {
          await persistDiscoveryQueue()
        } catch (error) {
          historyEntry.status = 'failed'
          historyEntry.error = `The queue item could not be saved: ${errorMessage(error)}`
          await persistHistoryEntry(historyEntry)
          throw error
        }
        notifyDiscoveryQueueChanged()
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: { queueItemId: queueItem.id, historyId: historyEntry.id } }
      } catch (error) {
        if (queueMutated) {
          if (createdItemId) {
            discoveryQueue = discoveryQueue.filter((candidate) => candidate.id !== createdItemId)
          } else if (previousItem) {
            const index = discoveryQueue.findIndex((candidate) => candidate.id === previousItem?.id)
            if (index >= 0) discoveryQueue[index] = previousItem
          }
          await persistDiscoveryQueue().catch((saveError: unknown) => {
            console.error('Failed queue submission rollback could not be saved:', saveError)
          })
          notifyDiscoveryQueueChanged()
        }
        if (historyEntry?.status === 'queued') {
          historyEntry.status = 'failed'
          historyEntry.error = errorMessage(error)
          await persistHistoryEntry(historyEntry).catch((saveError: unknown) => {
            console.error('Failed queue submission history could not be saved:', saveError)
          })
        }
        console.error('EPUB queueing failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle('download-queue:retry', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid download queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions || !item.downloadHistoryId) {
        throw new Error('This item has no saved EPUB job to retry.')
      }
      if (item.status !== 'failed' && item.status !== 'partially-completed' && item.status !== 'cancelled') {
        throw new Error('Only failed, partially completed, or cancelled jobs can be retried.')
      }
      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (!historyEntry) throw new Error('The saved job history entry is missing.')
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'failed' && item.status !== 'partially-completed' && item.status !== 'cancelled')
      ) {
        throw new Error('The EPUB job changed before it could be retried.')
      }
      item.status = 'queued'
      item.repackageOnly = false
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.progress = {
        current: item.completedChapterUrls.length,
        total: item.chapters.filter((chapter) => chapter.selected).length,
        message: 'Queued for retry'
      }
      historyEntry.status = 'queued'
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('EPUB job retry failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('download-queue:repackage', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid download queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions || !item.downloadHistoryId) {
        throw new Error('This item has no saved EPUB job to repackage.')
      }
      if (item.status !== 'failed' && item.status !== 'partially-completed' && item.status !== 'cancelled') {
        throw new Error('Only failed, partially completed, or cancelled jobs can be repackaged.')
      }
      const selectedChapters = item.chapters.filter((chapter) => chapter.selected)
      if (selectedChapters.length === 0) throw new Error('Select at least one saved chapter before repackaging.')
      for (const chapter of selectedChapters) {
        const content = await readChapterArtifact(dataDirectory(), item.id, chapter.url)
        if (!content || content.url !== chapter.url) {
          throw new Error(`Saved chapter content is missing or invalid for "${chapter.title}".`)
        }
      }
      if (item.downloadOptions.coverUrl && !(await readCoverArtifact(dataDirectory(), item.id))) {
        throw new Error('Saved cover content is missing; retry this EPUB online before repackaging.')
      }

      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (!historyEntry) throw new Error('The saved job history entry is missing.')
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'failed' && item.status !== 'partially-completed' && item.status !== 'cancelled')
      ) {
        throw new Error('The EPUB job changed before it could be repackaged.')
      }

      item.repackageOnly = true
      item.status = 'queued'
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.failedChapters = []
      item.completedChapterUrls = selectedChapters.map((chapter) => chapter.url)
      item.progress = {
        current: selectedChapters.length,
        total: selectedChapters.length,
        message: 'Queued for offline repackaging'
      }
      historyEntry.status = 'queued'
      historyEntry.completedChapters = selectedChapters.length
      historyEntry.selectedChapterCount = selectedChapters.length
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('Offline EPUB repackaging failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    'download-queue:move',
    async (_event, rawId: unknown, rawDirection: unknown): Promise<Result<void>> => {
      try {
        if (typeof rawId !== 'string' || (rawDirection !== 'up' && rawDirection !== 'down')) {
          throw new Error('Invalid queue reorder request.')
        }
        const queuedItems = discoveryQueue
          .filter((item) => item.status === 'queued' && item.downloadOptions)
          .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))
        const index = queuedItems.findIndex((item) => item.id === rawId)
        if (index < 0) throw new Error('Only queued EPUB jobs can be reordered.')
        const targetIndex = index + (rawDirection === 'up' ? -1 : 1)
        if (targetIndex < 0 || targetIndex >= queuedItems.length) {
          return { ok: true, value: undefined }
        }
        const oldTimes = new Map(queuedItems.map((item) => [item.id, { queuedAt: item.queuedAt, updatedAt: item.updatedAt }]))
        const movingItem = queuedItems[index]
        const displacedItem = queuedItems[targetIndex]
        if (!movingItem || !displacedItem) throw new Error('The queue order changed before the job could be moved.')
        queuedItems[index] = displacedItem
        queuedItems[targetIndex] = movingItem
        const now = Date.now()
        queuedItems.forEach((item, position) => {
          item.queuedAt = new Date(now + position).toISOString()
          item.updatedAt = new Date().toISOString()
        })
        try {
          await persistDiscoveryQueue()
        } catch (error) {
          for (const item of queuedItems) {
            const previous = oldTimes.get(item.id)
            if (previous) {
              item.queuedAt = previous.queuedAt
              item.updatedAt = previous.updatedAt
            }
          }
          throw error
        }
        notifyDiscoveryQueueChanged()
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
      } catch (error) {
        console.error('EPUB queue reorder failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle('download-queue:pause', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid download queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadHistoryId) throw new Error('The selected item has no active EPUB job.')
      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (!historyEntry) throw new Error('The saved job history entry is missing.')
      if (!discoveryQueue.includes(item) || (item.status !== 'queued' && item.status !== 'downloading')) {
        throw new Error('The EPUB job changed before it could be paused.')
      }
      if (item.status === 'queued') {
        item.status = 'paused'
        item.progress = { ...(item.progress ?? { current: 0, total: 0, message: '' }), message: 'Paused' }
        historyEntry.status = 'paused'
        await persistDownloadState(item, historyEntry)
        return { ok: true, value: undefined }
      }
      const active = activeDownloads.get(item.id)
      if (item.status !== 'downloading' || !active) throw new Error('Only queued or downloading jobs can be paused.')
      active.requestedAction = 'pause'
      active.controller.abort()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('EPUB job pause failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('download-queue:resume', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid download queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || item.status !== 'paused' || !item.downloadHistoryId) {
        throw new Error('Only paused EPUB jobs can be resumed.')
      }
      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (!historyEntry) throw new Error('The saved job history entry is missing.')
      if (!discoveryQueue.includes(item) || item.status !== 'paused') {
        throw new Error('The EPUB job changed before it could be resumed.')
      }
      item.status = 'queued'
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.progress = {
        current: item.completedChapterUrls.length,
        total: item.chapters.filter((chapter) => chapter.selected).length,
        message: 'Queued to resume'
      }
      historyEntry.status = 'queued'
      await persistDownloadState(item, historyEntry)
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('EPUB job resume failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('download-queue:cancel', async (_event, rawId: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawId !== 'string') throw new Error('Invalid download queue item.')
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadHistoryId) throw new Error('The selected item has no active EPUB job.')
      const history = await readDownloadHistory(dataDirectory())
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (!historyEntry) throw new Error('The saved job history entry is missing.')
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'queued' && item.status !== 'paused' && item.status !== 'downloading')
      ) {
        throw new Error('The EPUB job changed before it could be cancelled.')
      }
      if (item.status === 'queued' || item.status === 'paused') {
        item.status = 'cancelled'
        item.progress = { ...(item.progress ?? { current: 0, total: 0, message: '' }), message: 'Cancelled' }
        historyEntry.status = 'cancelled'
        await persistDownloadState(item, historyEntry)
        return { ok: true, value: undefined }
      }
      const active = activeDownloads.get(item.id)
      if (item.status !== 'downloading' || !active) {
        throw new Error('Only queued, paused, or downloading jobs can be cancelled.')
      }
      active.requestedAction = 'cancel'
      active.controller.abort()
      return { ok: true, value: undefined }
    } catch (error) {
      console.error('EPUB job cancellation failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('library:index', async () => readLibraryIndex(dataDirectory()))

  ipcMain.handle('library:operations', () => copyLibraryOperations())

  ipcMain.handle('library:index-backup', async () => readLibraryIndexBackup(dataDirectory()))

  ipcMain.handle('library:restore-index-backup', async (): Promise<Result<LibraryIndex>> => {
    if (activeLibraryScan || libraryIndexRestoreActive) {
      return { ok: false, error: 'Wait for the current library operation to finish before restoring its backup.' }
    }
    libraryIndexRestoreActive = true
    try {
      const backup = await readLibraryIndexBackup(dataDirectory())
      if (!backup) throw new Error('No library index backup is available.')
      const settings = await readSettings(dataDirectory())
      if (!settings.libraryRoot) throw new Error('Go to Configuration and choose a historical library root first.')
      const [configuredRoot, backupRoot] = await Promise.all([
        realpath(settings.libraryRoot),
        realpath(backup.libraryRoot)
      ])
      if (configuredRoot.toLocaleLowerCase() !== backupRoot.toLocaleLowerCase()) {
        throw new Error('The saved index backup belongs to a different library root.')
      }
      await writeLibraryIndex(dataDirectory(), backup)
      return { ok: true, value: backup }
    } catch (error) {
      console.error('Library index backup restore failed:', error)
      return { ok: false, error: errorMessage(error) }
    } finally {
      libraryIndexRestoreActive = false
    }
  })

  ipcMain.handle('library:scan', async (event, rawForceRebuild: unknown = false): Promise<Result<LibraryIndex>> => {
    if (typeof rawForceRebuild !== 'boolean') return { ok: false, error: 'Invalid library scan option.' }
    if (activeLibraryScan || libraryIndexRestoreActive) {
      return { ok: false, error: 'Another library operation is already running.' }
    }
    const scan: ActiveLibraryScan = { worker: null, cancelRequested: false }
    activeLibraryScan = scan
    try {
      const settings = await readSettings(dataDirectory())
      if (!settings.libraryRoot) throw new Error('Go to Configuration and choose a historical library root first.')
      if (scan.cancelRequested) throw new Error('Library scan cancelled.')
      const worker = new Worker(join(__dirname, 'libraryScanWorker.js'), {
        workerData: {
          libraryRoot: settings.libraryRoot,
          dataDirectory: dataDirectory(),
          forceRebuild: rawForceRebuild,
          scanOldFolder: settings.scanOldFolder
        },
        resourceLimits: { maxOldGenerationSizeMb: 1024 }
      })
      scan.worker = worker
      if (scan.cancelRequested) worker.postMessage({ type: 'cancel' })
      await runLibraryScanWorker(worker, (progress) => {
        sendToCurrentFrame(event.sender, event.senderFrame, 'library:progress', progress)
      })
      const index = await readLibraryIndex(dataDirectory())
      if (!index) throw new Error('The library scan completed without saving an index.')
      return { ok: true, value: index }
    } catch (error) {
      if (!scan.cancelRequested) console.error('Library scan failed:', error)
      return { ok: false, error: errorMessage(error) }
    } finally {
      if (activeLibraryScan === scan) activeLibraryScan = null
    }
  })

  ipcMain.handle('library:cancel-scan', () => {
    if (!activeLibraryScan) return
    activeLibraryScan.cancelRequested = true
    activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  })

  ipcMain.handle('library:correct-file', async (_event, rawFileId: unknown, rawCorrection: unknown) => {
    try {
      if (typeof rawFileId !== 'string' || typeof rawCorrection !== 'object' || rawCorrection === null) {
        throw new Error('Invalid library correction.')
      }
      const correction = rawCorrection as Record<string, unknown>
      const novelTitle = correction.novelTitle
      const chapterNumbers = correction.chapterNumbers
      if (novelTitle !== undefined && (typeof novelTitle !== 'string' || novelTitle.length > 300)) {
        throw new Error('Novel title must be 300 characters or fewer.')
      }
      if (
        chapterNumbers !== undefined &&
        (!Array.isArray(chapterNumbers) ||
          chapterNumbers.length > MAX_SELECTED_CHAPTERS ||
          chapterNumbers.some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0))
      ) {
        throw new Error('Chapter corrections must be a list of non-negative numbers.')
      }
      return {
        ok: true,
        value: await writeLibraryCorrection(dataDirectory(), rawFileId, {
          novelTitle: novelTitle as string | undefined,
          chapterNumbers: chapterNumbers as number[] | undefined
        } satisfies LibraryFileCorrection)
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle(
    'library:merge-epubs',
    async (event, rawFileIds: unknown, rawFilename: unknown): Promise<LibraryEpubMergeResponse> => {
      let operationId: string | null = null
      try {
        if (
          !Array.isArray(rawFileIds) ||
          rawFileIds.length < 2 ||
          rawFileIds.length > 20 ||
          rawFileIds.some((id) => typeof id !== 'string') ||
          new Set(rawFileIds).size !== rawFileIds.length
        ) {
          throw new Error('Select between 2 and 20 distinct EPUB files to combine.')
        }
        if (typeof rawFilename !== 'string' || rawFilename.length > 200) {
          throw new Error('Enter an EPUB filename of 200 characters or fewer.')
        }
        if (activeLibraryScan || libraryIndexRestoreActive) {
          throw new Error('Wait for the current library operation to finish before combining EPUBs.')
        }
        const index = await readLibraryIndex(dataDirectory())
        if (!index) throw new Error('Scan the library before combining existing EPUBs.')
        const settings = await readSettings(dataDirectory())
        if (!settings.libraryRoot) throw new Error('Go to Configuration and choose a historical library root first.')
        if (!settings.outputDirectory) throw new Error('Go to Configuration and choose an EPUB output folder first.')
        const outputDirectory = await realpath(settings.outputDirectory)
        if (!(await stat(outputDirectory)).isDirectory()) throw new Error('The configured EPUB output path is not a folder.')
        const filename = sanitizeEpubFilename(rawFilename)
        const outputPath = resolve(outputDirectory, filename)
        const sourceFiles = rawFileIds.map((id) => {
          const file = index.files.find((candidate) => candidate.id === id)
          if (!file || file.format !== 'EPUB') throw new Error('A selected source EPUB is no longer indexed.')
          return file
        })
        const novelKeys = new Set(sourceFiles.map((file) =>
          file.novelTitle.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
        ))
        if (novelKeys.size !== 1) throw new Error('Select EPUBs belonging to the same indexed novel.')

        const [configuredRoot, libraryRoot] = await Promise.all([
          realpath(settings.libraryRoot),
          realpath(index.libraryRoot)
        ])
        if (configuredRoot.toLocaleLowerCase() !== libraryRoot.toLocaleLowerCase()) {
          throw new Error('The saved library index belongs to a different root. Scan the configured library first.')
        }
        let totalSourceBytes = 0
        for (const file of sourceFiles) {
          const [currentPath, details] = await Promise.all([realpath(file.path), lstat(file.path)])
          const relativePath = relative(libraryRoot, currentPath)
          if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath) ||
            details.isSymbolicLink() ||
            !details.isFile()
          ) {
            throw new Error(`The selected source file is outside the configured library: ${file.filename}`)
          }
          if (details.size !== file.size || details.mtime.toISOString() !== file.modifiedAt) {
            throw new Error(`The source file changed since the last scan: ${file.filename}. Rescan and try again.`)
          }
          totalSourceBytes += details.size
          if (totalSourceBytes > MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES) {
            throw new Error(
              `Selected EPUBs exceed the ${MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES / (1024 * 1024)} MB combined input limit.`
            )
          }
        }
        if (sourceFiles.some((file) => resolve(file.path).toLocaleLowerCase() === outputPath.toLocaleLowerCase())) {
          throw new Error('The merged EPUB cannot overwrite one of its source files.')
        }
        try {
          const target = await lstat(outputPath)
          if (target.isSymbolicLink() || !target.isFile()) {
            throw new Error('The output filename is already used by a folder or symbolic link.')
          }
          if (!mainWindow) throw new Error('The app window is not available to confirm replacing the existing EPUB.')
          const confirmation = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Replace', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Replace existing EPUB?',
            message: `Replace "${filename}" in the configured output folder?`
          })
          if (confirmation.response !== 0) {
            return { ok: false, cancelled: true }
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }

        const input: EpubMergeInput = {
          title: sourceFiles[0]?.novelTitle ?? 'Merged novel',
          filename,
          outputDirectory,
          language: sourceFiles[0]?.language ?? 'en',
          epubCss: settings.epubCss,
          sources: sourceFiles.map((file) => ({
            path: file.path,
            filename: file.filename,
            chapterNumbers: file.chapterNumbers,
            filenameRange: file.filenameRange
          }))
        }
        const trackedOperationId = await startLibraryOperation({
          kind: 'merge-epubs',
          inputFiles: sourceFiles.map((file) => file.path),
          outputPath,
          progress: 0,
          message: 'Preparing EPUB merge…',
          error: ''
        })
        operationId = trackedOperationId
        const worker = new Worker(join(__dirname, 'epubMergeWorker.js'), {
          workerData: input,
          resourceLimits: { maxOldGenerationSizeMb: 1024 }
        })
        const result = await runEpubMergeWorker(worker, (progress) => {
          void updateLibraryOperation(trackedOperationId, {
            progress: progress.percentage,
            message: progress.message,
            status: progress.stage === 'failed' ? 'failed' : 'running',
            error: progress.stage === 'failed' ? progress.message : ''
          }, progress.stage === 'failed')
          sendToCurrentFrame(event.sender, event.senderFrame, 'library:merge-progress', progress)
        })
        await updateLibraryOperation(operationId, {
          status: 'completed',
          outputPath: result.outputPath,
          progress: 100,
          message: 'Merged EPUB created and validated.',
          error: ''
        }, true)
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(operationId, {
            status: 'failed',
            message: 'EPUB merge failed.',
            error: errorMessage(error)
          }, true)
        }
        console.error('Existing EPUB merge failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(
    'library:convert-azw3',
    async (_event, rawInputPath: unknown): Promise<EbookConversionResponse> => {
      let operationId: string | null = null
      try {
        if (typeof rawInputPath !== 'string' || extname(rawInputPath).toLowerCase() !== '.epub') {
          throw new Error('Select an EPUB file to convert.')
        }
        if (!mainWindow || mainWindow.isDestroyed()) {
          throw new Error('The app window is not available to choose an AZW3 output path.')
        }

        const settings = await readSettings(dataDirectory())
        const inputFile = resolve(rawInputPath)
        const inputDetails = await lstat(inputFile)
        if (inputDetails.isSymbolicLink() || !inputDetails.isFile()) {
          throw new Error('The selected EPUB is not a regular file.')
        }
        const inputPath = await realpath(inputFile)
        const allowedRoots: string[] = []
        for (const rootPath of [settings.libraryRoot, settings.outputDirectory]) {
          if (!rootPath) continue
          try {
            allowedRoots.push(await realpath(rootPath))
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          }
        }
        if (!allowedRoots.some((rootPath) => isWithinDirectory(rootPath, inputPath))) {
          throw new Error('The selected EPUB must be inside the configured library or EPUB output folder.')
        }

        const outputDirectory = settings.outputDirectory || dirname(inputPath)
        const outputPath = await chooseConversionOutputPath(mainWindow, inputPath, outputDirectory, 'azw3')
        if (!outputPath) return { ok: false, cancelled: true }

        operationId = await startLibraryOperation({
          kind: 'epub-to-azw3',
          inputFiles: [inputPath],
          outputPath,
          progress: null,
          message: 'Converting EPUB to AZW3 with Calibre…',
          error: ''
        })
        const result = await convertEpubToAzw3(inputPath, outputPath)
        await updateLibraryOperation(operationId, {
          status: 'completed',
          outputPath: result.outputPath,
          progress: 100,
          message: 'AZW3 conversion completed.',
          error: ''
        }, true)
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(operationId, {
            status: 'failed',
            message: 'EPUB to AZW3 conversion failed.',
            error: errorMessage(error)
          }, true)
        }
        console.error('EPUB to AZW3 conversion failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(
    'library:convert-azw3-to-epub',
    async (_event, rawFileId: unknown): Promise<EbookConversionResponse> => {
      let operationId: string | null = null
      try {
        const inputPath = await getIndexedLibraryFile(rawFileId, 'AZW3')
        const outputPath = await getSiblingOutputPath(inputPath, '')
        if (!outputPath) return { ok: false, cancelled: true }

        operationId = await startLibraryOperation({
          kind: 'azw3-to-epub',
          inputFiles: [inputPath],
          outputPath,
          progress: null,
          message: 'Converting AZW3 to EPUB with Calibre…',
          error: ''
        })
        const result = await convertAzw3ToEpub(inputPath, outputPath)
        await updateLibraryOperation(operationId, {
          status: 'completed',
          outputPath: result.outputPath,
          progress: 100,
          message: 'EPUB conversion completed.',
          error: ''
        }, true)
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(operationId, {
            status: 'failed',
            message: 'AZW3 to EPUB conversion failed.',
            error: errorMessage(error)
          }, true)
        }
        console.error('AZW3 to EPUB conversion failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle(
    'library:repair-epub',
    async (_event, rawFileId: unknown): Promise<EpubRepairResponse> => {
      let operationId: string | null = null
      try {
        const inputPath = await getIndexedLibraryFile(rawFileId, 'EPUB')
        const outputPath = await getSiblingOutputPath(inputPath, '-repaired')
        if (!outputPath) return { ok: false, cancelled: true }

        operationId = await startLibraryOperation({
          kind: 'repair-epub',
          inputFiles: [inputPath],
          outputPath,
          progress: 0,
          message: 'Preparing EPUB check and repair…',
          error: ''
        })
        const trackedOperationId = operationId
        const worker = new Worker(join(__dirname, 'epubRepairWorker.js'), {
          workerData: { inputPath, outputPath },
          resourceLimits: { maxOldGenerationSizeMb: 1024 }
        })
        const result = await runEpubRepairWorker(worker, (progress) => {
          void updateLibraryOperation(trackedOperationId, {
            progress: progress.percentage,
            message: progress.message
          })
        })
        const summary = result.repairedWebpImages > 0
          ? `Converted ${result.repairedWebpImages.toLocaleString()} WebP image(s) to JPEG.`
          : 'No WebP images needed conversion.'
        const coverSummary = result.upscaledCover ? ' Upscaled the undersized cover to Kindle minimum dimensions.' : ''
        const mimetypeSummary = result.fixedMimetype ? ' Corrected EPUB mimetype and ZIP ordering.' : ''
        await updateLibraryOperation(operationId, {
          status: 'completed',
          outputPath: result.outputPath,
          progress: 100,
          message: `${summary}${coverSummary}${mimetypeSummary}`,
          error: ''
        }, true)
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(operationId, {
            status: 'failed',
            message: 'EPUB check and repair failed.',
            error: errorMessage(error)
          }, true)
        }
        console.error('EPUB repair failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  ipcMain.handle('library:open-path', async (_event, rawPath: unknown, reveal: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawPath !== 'string' || typeof reveal !== 'boolean') throw new Error('Invalid library path request.')
      const settings = await readSettings(dataDirectory())
      if (!settings.libraryRoot) throw new Error('Go to Configuration and choose a historical library root first.')
      const root = await realpath(settings.libraryRoot)
      const target = await realpath(rawPath)
      const relativePath = relative(root, target)
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('The requested path is outside the configured library.')
      }
      if (reveal) shell.showItemInFolder(target)
      else {
        const error = await shell.openPath(target)
        if (error) throw new Error(error)
      }
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

}

app.whenReady().then(async () => {
  initializeLocalLogger(dataDirectory(), app.getVersion())
  if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.resourcesPath, 'playwright-browsers')
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.brightfyre.noveltracker')
  registerIpcHandlers()
  libraryOperations = await readLibraryOperations(dataDirectory())
  let interruptedLibraryOperations = false
  for (const operation of libraryOperations) {
    if (operation.status !== 'running') continue
    operation.status = 'interrupted'
    operation.message = 'The app closed before this operation finished.'
    operation.error = operation.message
    operation.updatedAt = new Date().toISOString()
    interruptedLibraryOperations = true
  }
  if (interruptedLibraryOperations) await flushLibraryOperations()
  await markInterruptedDownloadJobs(dataDirectory())
  discoveryQueue = (await readDiscoveryQueue(dataDirectory())).map(hydrateQueueItem)
  const history = await readDownloadHistory(dataDirectory())
  let interruptedDownloads = false
  for (const item of discoveryQueue) {
    const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
    if (historyEntry && item.downloadOptions) {
      if (item.status === 'completed' && historyEntry.status !== 'completed') {
        historyEntry.status = 'completed'
        historyEntry.outputPath = item.outputPath
        historyEntry.error = ''
        historyEntry.updatedAt = item.updatedAt
        interruptedDownloads = true
      } else if (item.status === 'partially-completed' && historyEntry.status !== 'partially-completed') {
        historyEntry.status = 'partially-completed'
        historyEntry.error = item.error
        historyEntry.updatedAt = item.updatedAt
        interruptedDownloads = true
      } else if (item.status === 'failed' && historyEntry.status !== 'failed') {
        historyEntry.status = 'failed'
        historyEntry.error = item.error
        historyEntry.updatedAt = item.updatedAt
        interruptedDownloads = true
      } else if (item.status === 'cancelled' && historyEntry.status !== 'cancelled') {
        historyEntry.status = 'cancelled'
        historyEntry.error = ''
        historyEntry.updatedAt = item.updatedAt
        interruptedDownloads = true
      } else if (item.status === 'paused' && historyEntry.status !== 'paused') {
        historyEntry.status = 'paused'
        historyEntry.error = ''
        historyEntry.updatedAt = item.updatedAt
        interruptedDownloads = true
      }
    }
    if (item.status !== 'downloading' && item.status !== 'queued') continue
    if (!item.downloadOptions || !historyEntry) {
      item.status = 'failed'
      item.error = 'The saved EPUB job or its history entry is missing.'
      item.updatedAt = new Date().toISOString()
      interruptedDownloads = true
      continue
    }
    if (item.status === 'downloading' || historyEntry.status === 'running' || historyEntry.status === 'interrupted') {
      item.status = 'queued'
      item.error = ''
      item.queuedAt = new Date().toISOString()
      item.progress = {
        current: item.completedChapterUrls.length,
        total: item.chapters.filter((chapter) => chapter.selected).length,
        message: 'Resuming after app restart'
      }
      historyEntry.status = 'queued'
      historyEntry.error = ''
      historyEntry.completedChapters = item.completedChapterUrls.filter((url) =>
        item.chapters.some((chapter) => chapter.selected && chapter.url === url)
      ).length
      historyEntry.updatedAt = new Date().toISOString()
      interruptedDownloads = true
    }
  }
  if (interruptedDownloads) {
    await persistDiscoveryQueue()
    for (const item of discoveryQueue) {
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (historyEntry) await persistHistoryEntry(historyEntry)
    }
  }
  let interruptedDiscoveries = false
  for (const item of discoveryQueue) {
    if (item.status === 'discovering') {
      item.status = 'failed'
      item.error = 'Discovery was interrupted when the app closed. Retry to refresh the chapter list.'
      item.updatedAt = new Date().toISOString()
      interruptedDiscoveries = true
      const historyEntry = history.find((entry) => entry.id === item.downloadHistoryId)
      if (item.downloadOptions && historyEntry) {
        historyEntry.status = 'failed'
        historyEntry.error = item.error
        historyEntry.updatedAt = item.updatedAt
        await persistHistoryEntry(historyEntry)
      }
    }
  }
  if (interruptedDiscoveries) await persistDiscoveryQueue()
  const settings = await readSettings(dataDirectory())
  if (settings.outputDirectory) {
    try {
      const directory = await realpath(settings.outputDirectory)
      if ((await stat(directory)).isDirectory()) approvedOutputDirectories.add(directory)
    } catch (error) {
      console.warn('Saved EPUB output folder is unavailable:', errorMessage(error))
    }
  }
  await createWindow()
  void pumpDownloadQueue().catch((error: unknown) => {
    console.error('Download queue scheduler failed:', error)
  })

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
}).catch((error: unknown) => {
  console.error('Application startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let closingBrowserSession = false
app.on('before-quit', (event) => {
  if (closingBrowserSession) return
  event.preventDefault()
  closingBrowserSession = true
  void closeBrowserSession().catch(() => {
    console.error('The browser session could not be closed cleanly.')
  }).finally(() => app.quit())
})
