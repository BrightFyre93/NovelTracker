import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, readdir, rm, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AppSettings,
  ChapterContent,
  ChapterLink,
  ChapterImage,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DomainRequestDelayPreference,
  DownloadHistoryEntry,
  EpubMergeProgress,
  EpubRepairProgress,
  EpubRepairResult,
  GenerateEpubInput,
  LibraryFileCorrection,
  LibraryOperation,
  LibraryProgress,
  QueueChapter,
  Result,
  SiteExtractionPreference
} from '../shared/contracts'
import {
  DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  DEFAULT_EPUB_CSS,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_DOMAIN_REQUEST_PREFERENCES,
  MAX_EPUB_CSS_LENGTH,
  MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
  MAX_NOVEL_DESCRIPTION_LENGTH,
  MAX_SELECTED_CHAPTERS,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DISCOVERIES,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_SITE_EXTRACTION_PREFERENCES,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DISCOVERIES,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../shared/constants'
import {
  normalizeSiteExtractionPreferences,
  siteExtractionModeForUrl
} from '../shared/siteExtractionPreferences'
import { normalizeDomainRequestDelays } from '../shared/domainRequestPreferences'
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
  readDiscoveryQueueItemChapters,
  readDownloadHistory,
  readLibraryIndex,
  readLibraryIndexBackup,
  readLibraryIndexBackupDate,
  readLibraryOperations,
  readSettings,
  migrateSettings,
  takeStorageRecoveryWarnings,
  saveDownloadHistoryEntry,
  removeChapterArtifacts,
  writeLibraryCorrection,
  writeLibraryIndex,
  writeLibraryOperations,
  writeCoverArtifact,
  writeDiscoveryQueue,
  writeDiscoveryQueueItemChapters,
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
  setDomainRequestDelays,
  validateHttpUrl
} from './services/scraper'
import { writeEpub } from './services/epub'
import { SerialQueue } from './services/serialQueue'
import { samePath } from './services/pathUtils'
import { withRetry } from './services/retry'
import { runWorker } from './services/workerRunner'
import {
  copyQueueItem,
  copyQueueItemForPersistence,
  copyQueueItemSummary,
  createQueueItem
} from './services/queueItem'
import { recommendArchiveCoverage } from '../shared/archiveRecommendation'
import {
  HttpStatusError,
  NoReadableContentError,
  OperationCancelledError,
  TransientNetworkError,
  VerificationRequiredError,
  errorCode,
  isNodeError,
  toMessage
} from '../shared/errors'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventMap,
  IpcMap
} from '../shared/ipc'
import { summarizeLibraryIndex } from '../shared/libraryIndexSummary'
import {
  normalizeNovelTitleForGrouping,
  normalizeNovelTitleForMatching
} from '../shared/novelTitle'
import { z } from 'zod'
import {
  MAX_EPUB_FILENAME_BASENAME_LENGTH,
  sanitizeEpubFilename,
  suggestEpubFilename
} from '../shared/epubFilename'
import type { EpubMergeInput, EpubMergeResult } from './services/epubMerger'
import { flushLocalLogger, initializeLocalLogger } from './services/localLogger'

let mainWindow: BrowserWindow | null = null
let mainWindowReady = false
let focusRequestedBeforeWindowReady = false
const approvedOutputDirectories = new Set<string>()
let discoveryQueueNotificationTimer: ReturnType<typeof setTimeout> | null = null
let libraryOperationFlushTimer: ReturnType<typeof setTimeout> | null = null
const libraryOperationWrites = new SerialQueue()
const settingsUpdateQueue = new SerialQueue()
let libraryOperations: LibraryOperation[] = []
interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

let activeLibraryScan: ActiveLibraryScan | null = null
let libraryIndexRestoreActive = false
let libraryCorrectionActive = false
const activeLibraryWorkers = new Set<Worker>()
const activeBackgroundTasks = new Set<Promise<void>>()
let activeLibraryOperationHandlers = 0
let discoveryQueue: DiscoveryQueueItem[] = []
const reservedOutputPaths = new Set<string>()
const discoveryQueueWrites = new SerialQueue()
const dirtyQueueChapterIds = new Map<string, number>()
let queueChapterRevision = 0
const historyWrites = new SerialQueue()
const pendingDiscoveries: string[] = []
const browserAssistedDiscoveries = new Set<string>()
const activeBrowserDiscoveries = new Map<string, AbortController>()
const activeQueueDiscoveries = new Map<string, AbortController>()
let activeDiscoveries = 0
let maxActiveDiscoveries = DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES
const activeDownloads = new Map<
  string,
  {
    controller: AbortController
    requestedAction: 'none' | 'pause' | 'cancel' | 'shutdown'
  }
>()
let downloadPumpRunning = false
let downloadPumpRequested = false
let fatalProcessErrorHandled = false
let shuttingDown = false
let shutdownComplete = false
let shutdownPromise: Promise<void> | null = null

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
      focusRequestedBeforeWindowReady = true
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
} else {
  app.quit()
}

function copyLibraryOperations(): LibraryOperation[] {
  return libraryOperations.map((operation) => ({
    ...operation,
    inputFiles: [...operation.inputFiles]
  }))
}

function persistLibraryOperations(): Promise<void> {
  const snapshot = copyLibraryOperations()
  return libraryOperationWrites.enqueue(() =>
    writeLibraryOperations(dataDirectory(), snapshot)
  )
}

function broadcastLibraryOperations(): void {
  const operations = copyLibraryOperations()
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents
    if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) continue
    const frame = webContents.mainFrame
    if (frame.isDestroyed()) continue
    sendIpcEvent(frame, 'library:operations:update', operations)
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
  update: Partial<
    Pick<
      LibraryOperation,
      'status' | 'outputPath' | 'progress' | 'message' | 'error'
    >
  >,
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

function updateSettings(
  update: (settings: AppSettings) => void | Promise<void>,
  afterUpdate?: (settings: AppSettings) => void | Promise<void>
): Promise<AppSettings> {
  return settingsUpdateQueue.enqueue(async () => {
    const settings = await readSettings(dataDirectory())
    await update(settings)
    await writeSettings(dataDirectory(), settings)
    await afterUpdate?.(settings)
    return settings
  })
}

function errorMessage(error: unknown): string {
  return toMessage(error)
}

type ResultIpcChannel = {
  [Channel in IpcChannel]: IpcMap[Channel]['result'] extends Result<unknown>
    ? Channel
    : never
}[IpcChannel]

type ResultLikeIpcChannel = {
  [Channel in IpcChannel]: Extract<
    IpcMap[Channel]['result'],
    { ok: false; error: string }
  > extends never
    ? never
    : Channel
}[IpcChannel]

type ResultIpcValue<Channel extends ResultIpcChannel> =
  IpcMap[Channel]['result'] extends Result<infer Value> ? Value : never

function integerInRange(
  minimum: number,
  maximum: number,
  message: string
): z.ZodType<number> {
  return z.custom<number>(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum,
    message
  )
}

function handleResultIpc<Channel extends ResultIpcChannel>(
  channel: Channel,
  schema: z.ZodType<IpcMap[Channel]['args']>,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcMap[Channel]['args']
  ) => ResultIpcValue<Channel> | Promise<ResultIpcValue<Channel>>
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    const parsed = schema.safeParse(rawArgs)
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid IPC arguments.',
        code: 'invalid-arguments'
      }
    }

    try {
      return { ok: true, value: await handler(event, ...parsed.data) }
    } catch (error) {
      console.error(`${channel} failed:`, error)
      return { ok: false, error: errorMessage(error), code: errorCode(error) }
    }
  })
}

function handleValidatedResultIpc<Channel extends ResultLikeIpcChannel>(
  channel: Channel,
  schema: z.ZodType<IpcMap[Channel]['args']>,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcMap[Channel]['args']
  ) => IpcMap[Channel]['result'] | Promise<IpcMap[Channel]['result']>
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    const parsed = schema.safeParse(rawArgs)
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Invalid IPC arguments.',
        code: 'invalid-arguments'
      }
    }
    try {
      const result = await handler(event, ...parsed.data)
      if (result.ok || !('error' in result)) return result
      return { ...result, code: result.code ?? 'operation-failed' }
    } catch (error) {
      console.error(`${channel} failed:`, error)
      return { ok: false, error: errorMessage(error), code: errorCode(error) }
    }
  })
}

function handleTypedIpc<Channel extends IpcChannel>(
  channel: Channel,
  schema: z.ZodType<IpcMap[Channel]['args']>,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcMap[Channel]['args']
  ) => IpcMap[Channel]['result'] | Promise<IpcMap[Channel]['result']>
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    const parsed = schema.safeParse(rawArgs)
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues[0]?.message ?? 'Invalid IPC arguments.'
      )
    }
    return handler(event, ...parsed.data)
  })
}

function trackLibraryWorker(worker: Worker): Worker {
  activeLibraryWorkers.add(worker)
  worker.once('exit', () => activeLibraryWorkers.delete(worker))
  return worker
}

function trackBackgroundTask(task: Promise<void>, label: string): void {
  activeBackgroundTasks.add(task)
  void task.then(
    () => activeBackgroundTasks.delete(task),
    (error: unknown) => {
      activeBackgroundTasks.delete(task)
      console.error(`${label} failed:`, error)
    }
  )
}

function handleFatalProcessError(kind: string, error: unknown): void {
  console.error(`Fatal process error (${kind}):`, error)
  if (fatalProcessErrorHandled) return
  fatalProcessErrorHandled = true
  dialog.showErrorBox(
    'NovelTracker encountered an unexpected error',
    `The application will close to protect your data.\n\n${errorMessage(error)}`
  )
  app.quit()
}

function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', (error) =>
    handleFatalProcessError('uncaughtException', error)
  )
  process.on('unhandledRejection', (reason) =>
    handleFatalProcessError('unhandledRejection', reason)
  )
}

function discoverySnapshotIsStale(
  discoveredAt: string,
  freshnessHours: number
): boolean {
  const timestamp = Date.parse(discoveredAt)
  const now = Date.now()
  return (
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp >= freshnessHours * 60 * 60 * 1000
  )
}

function discoveryQueueItemStatus(
  item: DiscoveryQueueItem
): DiscoveryQueueItem['status'] {
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
      (error instanceof HttpStatusError &&
        (error.status === 401 || error.status === 403)) ||
      error instanceof VerificationRequiredError
    if (!verificationRequired) throw error

    const { html, finalUrl } = await readBrowserPage(chapter.url, signal)
    return fetchChapterContentFromHtml(chapter, html, finalUrl, signal)
  }
}

function copyDiscoveryQueue(): DiscoveryQueueItemSummary[] {
  return discoveryQueue.map(copyQueueItemSummary)
}

function updateQueueChapterSummary(item: DiscoveryQueueItem): void {
  item.chapterSummary = {
    total: item.chapters.length,
    selected: item.chapters.filter((chapter) => chapter.selected).length,
    recommended: item.chapters.filter((chapter) => chapter.recommended).length,
    hasUncertainArchiveChapters: item.chapters.some(
      (chapter) =>
        chapter.archiveStatus === 'uncertain' ||
        chapter.archiveStatus === 'probable'
    ),
    latestTitle: item.chapters[item.chapters.length - 1]?.title ?? ''
  }
}

function markQueueItemChaptersDirty(item: DiscoveryQueueItem): void {
  updateQueueChapterSummary(item)
  dirtyQueueChapterIds.set(item.id, ++queueChapterRevision)
}

async function ensureQueueItemChapters(
  item: DiscoveryQueueItem
): Promise<void> {
  if (item.chapters.length > 0 || item.chapterSummary.total === 0) return
  const chapters = await readDiscoveryQueueItemChapters(
    dataDirectory(),
    item.id
  )
  if (!chapters || chapters.length !== item.chapterSummary.total) {
    throw new Error(
      `Saved chapter details are missing or incomplete for "${item.title}".`
    )
  }
  let savedChapterDataChanged = false
  item.chapters = chapters.map((chapter) => {
    const normalized = {
      id: chapter.id,
      title: chapter.title,
      url: chapter.url,
      selected: chapter.selected,
      archiveStatus: chapter.archiveStatus ?? 'missing',
      archiveSources: chapter.archiveSources ?? [],
      chapterNumber: chapter.chapterNumber ?? null,
      archiveGap: chapter.archiveGap ?? false,
      recommended: chapter.recommended ?? true
    }
    if (hasUnknownProperties(chapter, normalized))
      savedChapterDataChanged = true
    return normalized
  })
  if (savedChapterDataChanged) markQueueItemChaptersDirty(item)
}

function releaseQueueItemChapters(item: DiscoveryQueueItem): void {
  item.chapters = []
  item.completedChapterUrls = []
}

function persistDiscoveryQueue(): Promise<void> {
  const changedChapterData = [...dirtyQueueChapterIds.entries()].flatMap(
    ([id, revision]) => {
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      return item
        ? [
            {
              id,
              revision,
              chapters: item.chapters.map((chapter) => ({ ...chapter }))
            }
          ]
        : []
    }
  )
  const snapshot = discoveryQueue.map(copyQueueItemForPersistence)
  return discoveryQueueWrites.enqueue(async () => {
    for (const { id, chapters } of changedChapterData) {
      await writeDiscoveryQueueItemChapters(dataDirectory(), id, chapters)
    }
    await writeDiscoveryQueue(dataDirectory(), snapshot)
    for (const { id, revision } of changedChapterData) {
      if (dirtyQueueChapterIds.get(id) === revision)
        dirtyQueueChapterIds.delete(id)
    }
  })
}

async function persistDiscoveryQueueOrRollback(
  rollback: () => void
): Promise<void> {
  try {
    await persistDiscoveryQueue()
  } catch (error) {
    rollback()
    throw error
  }
}

function persistHistoryEntry(
  entry: DownloadHistoryEntry
): Promise<DownloadHistoryEntry[]> {
  return historyWrites.enqueue(() =>
    saveDownloadHistoryEntry(
      dataDirectory(),
      entry,
      discoveryQueue.map((item) => item.downloadHistoryId)
    )
  )
}

function historyEntryForQueueItem(
  item: DiscoveryQueueItem
): DownloadHistoryEntry | null {
  const options = item.downloadOptions
  if (!options) return null
  const now = new Date().toISOString()
  const id = item.downloadHistoryId || randomUUID()
  item.downloadHistoryId = id
  const savedSelectedCount = item.chapterSummary.selected
  const selectedChapterCount =
    Number.isInteger(savedSelectedCount) && savedSelectedCount >= 0
      ? savedSelectedCount
      : 0
  const progress = item.progress?.current ?? 0
  const completedChapters = Number.isInteger(progress)
    ? Math.max(0, Math.min(progress, selectedChapterCount))
    : 0
  const statusByQueueStatus: Record<
    DiscoveryQueueItem['status'],
    DownloadHistoryEntry['status']
  > = {
    queued: 'queued',
    downloading: 'running',
    paused: 'paused',
    completed: 'completed',
    'partially-completed': 'partially-completed',
    failed: 'failed',
    cancelled: 'cancelled',
    discovering: 'failed',
    'needs-review': 'failed',
    ready: 'failed'
  }
  return {
    id,
    queueItemId: item.id,
    title: options.title || item.title,
    author: options.author || item.author,
    sourceUrl: options.sourceUrl || item.sourceUrl,
    trackerRow: item.trackerRow ? { ...item.trackerRow } : null,
    selectedChapterCount,
    status: statusByQueueStatus[item.status],
    completedChapters,
    outputPath: item.outputPath || '',
    error: item.error || '',
    startedAt: item.queuedAt || item.updatedAt || item.discoveredAt || now,
    updatedAt: item.updatedAt || now
  }
}

interface EnsuredQueueItemHistoryEntry {
  entry: DownloadHistoryEntry
  created: boolean
}

async function ensureQueueItemHistoryEntry(
  item: DiscoveryQueueItem,
  history?: DownloadHistoryEntry[]
): Promise<EnsuredQueueItemHistoryEntry | null> {
  if (!item.downloadOptions) return null
  const entries = history ?? (await readDownloadHistory(dataDirectory()))
  const existing = entries.find((entry) => entry.id === item.downloadHistoryId)
  if (existing) {
    item.recoveryReason = undefined
    return { entry: existing, created: false }
  }
  const restored = historyEntryForQueueItem(item)
  if (!restored) return null
  await persistHistoryEntry(restored)
  entries.push(restored)
  item.recoveryReason = undefined
  return { entry: restored, created: true }
}

function hydrateQueueItem(item: DiscoveryQueueItem): DiscoveryQueueItem {
  const chapters = (item.chapters ?? []).map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    url: chapter.url,
    selected: chapter.selected,
    archiveStatus: chapter.archiveStatus ?? 'missing',
    archiveSources: chapter.archiveSources ?? [],
    chapterNumber: chapter.chapterNumber ?? null,
    archiveGap: chapter.archiveGap ?? false,
    recommended: chapter.recommended ?? true
  }))
  const hydrated = createQueueItem({
    ...item,
    chapters,
    chapterSummary: {
      total: item.chapterSummary?.total ?? 0,
      selected: item.chapterSummary?.selected ?? 0,
      recommended: item.chapterSummary?.recommended ?? 0,
      hasUncertainArchiveChapters:
        item.chapterSummary?.hasUncertainArchiveChapters ?? false,
      latestTitle: item.chapterSummary?.latestTitle ?? ''
    },
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
    updatedAt: item.updatedAt ?? ''
  })
  if (chapters.length > 0 || !item.chapterSummary)
    updateQueueChapterSummary(hydrated)
  return hydrated
}

function hasUnknownProperties(saved: object, normalized: object): boolean {
  const normalizedKeys = new Set(Object.keys(normalized))
  return Object.keys(saved).some((key) => !normalizedKeys.has(key))
}

function expectedOutputPath(
  outputDirectory: string,
  title: string,
  filename: string,
  chapters: ChapterLink[]
): string {
  const requestedFilename =
    filename.trim() ||
    suggestEpubFilename(
      title,
      chapters[0]?.title ?? '',
      chapters[chapters.length - 1]?.title ?? ''
    )
  return resolve(
    outputDirectory,
    sanitizeEpubFilename(requestedFilename)
  ).toLowerCase()
}

function findOutputConflict(
  outputPath: string,
  itemId: string
): DiscoveryQueueItem | undefined {
  return discoveryQueue.find(
    (candidate) =>
      candidate.id !== itemId &&
      candidate.downloadOptions &&
      candidate.status !== 'completed' &&
      candidate.targetOutputPath === outputPath
  )
}

function assertOutputPathAvailable(outputPath: string, itemId: string): void {
  const conflict = findOutputConflict(outputPath, itemId)
  if (conflict) {
    throw new Error(
      `Another saved EPUB job uses this output filename. Remove or complete "${conflict.title}" before reusing it.`
    )
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

async function reserveIncompleteEpubFilename(
  item: DiscoveryQueueItem,
  chapters: ChapterLink[]
): Promise<{ filename: string; outputPath: string; release: () => void }> {
  const options = item.downloadOptions
  if (!options) throw new Error('This item has no saved EPUB job to package.')
  const requestedFilename =
    options.filename.trim() ||
    suggestEpubFilename(
      options.title,
      chapters[0]?.title ?? '',
      chapters[chapters.length - 1]?.title ?? ''
    )
  const base = sanitizeEpubFilename(requestedFilename).replace(/\.epub$/i, '')

  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const marker = suffix === 1 ? ' (incomplete)' : ` (incomplete ${suffix})`
    const stem = base
      .slice(0, MAX_EPUB_FILENAME_BASENAME_LENGTH - marker.length)
      .replace(/[. ]+$/g, '')
    const filename = sanitizeEpubFilename(`${stem}${marker}.epub`)
    const outputPath = resolve(options.outputDirectory, filename)
    const normalizedPath = outputPath.toLowerCase()
    if (
      reservedOutputPaths.has(normalizedPath) ||
      discoveryQueue.some(
        (candidate) =>
          candidate.id !== item.id &&
          candidate.targetOutputPath === normalizedPath &&
          candidate.status !== 'completed'
      )
    ) {
      continue
    }

    try {
      await lstat(outputPath)
      continue
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    if (
      reservedOutputPaths.has(normalizedPath) ||
      discoveryQueue.some(
        (candidate) =>
          candidate.id !== item.id &&
          candidate.targetOutputPath === normalizedPath &&
          candidate.status !== 'completed'
      )
    ) {
      continue
    }
    reservedOutputPaths.add(normalizedPath)
    return {
      filename,
      outputPath: normalizedPath,
      release: () => reservedOutputPaths.delete(normalizedPath)
    }
  }
  throw new Error(
    'A unique filename for the incomplete EPUB could not be reserved.'
  )
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

async function getIndexedLibraryFile(fileId: string): Promise<string> {
  if (!fileId) throw new Error('Select an indexed library file.')
  const [index, settings] = await Promise.all([
    readLibraryIndex(dataDirectory()),
    readSettings(dataDirectory())
  ])
  if (!index)
    throw new Error('Scan the library before working with indexed files.')
  if (!settings.libraryRoot)
    throw new Error(
      'Go to Configuration and choose a historical library root first.'
    )
  const file = index.files.find((candidate) => candidate.id === fileId)
  if (!file || file.format !== 'EPUB') {
    throw new Error(
      'The selected EPUB is no longer indexed. Rescan and try again.'
    )
  }
  const [libraryRoot, indexRoot] = await Promise.all([
    realpath(settings.libraryRoot),
    realpath(index.libraryRoot)
  ])
  if (!samePath(libraryRoot, indexRoot)) {
    throw new Error(
      'The saved library index belongs to a different root. Scan the configured library first.'
    )
  }
  const inputDetails = await lstat(file.path)
  const inputPath = await realpath(file.path)
  if (
    inputDetails.isSymbolicLink() ||
    !inputDetails.isFile() ||
    !isWithinDirectory(libraryRoot, inputPath) ||
    extname(inputPath).toLowerCase() !== '.epub'
  ) {
    throw new Error(
      'The selected EPUB is not a regular file inside the configured library.'
    )
  }
  if (
    inputDetails.size !== file.size ||
    inputDetails.mtime.toISOString() !== file.modifiedAt
  ) {
    throw new Error(
      `The source file changed since the last scan: ${file.filename}. Rescan and try again.`
    )
  }
  return inputPath
}

async function getSiblingOutputPath(
  inputPath: string,
  suffix: string
): Promise<string | null> {
  const sourceName = basename(inputPath, extname(inputPath))
  const outputPath = join(dirname(inputPath), `${sourceName}${suffix}.epub`)
  if (samePath(outputPath, inputPath)) {
    throw new Error('The output cannot replace the source file.')
  }
  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(
        `The output path is already used by a folder or symbolic link: ${basename(outputPath)}`
      )
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error(
        'The app window is not available to confirm replacing the existing EPUB.'
      )
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
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
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
      if (webContents.isDestroyed() || webContents.isLoadingMainFrame())
        continue
      const frame = webContents.mainFrame
      if (frame.isDestroyed()) continue
      sendIpcEvent(frame, 'discovery-queue:update', items)
    }
  }, 1000)
}

function sendIpcEvent<Channel extends IpcEventChannel>(
  frame: Electron.WebFrameMain,
  channel: Channel,
  value: IpcEventMap[Channel]
): void {
  frame.send(channel, value)
}

function sendToCurrentFrame<Channel extends IpcEventChannel>(
  webContents: Electron.WebContents,
  frame: Electron.WebFrameMain | null,
  channel: Channel,
  value: IpcEventMap[Channel]
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
  sendIpcEvent(frame, channel, value)
}

async function discoverQueueItem(
  id: string,
  browserAssisted = false
): Promise<boolean> {
  const item = discoveryQueue.find((candidate) => candidate.id === id)
  if (!item || item.status !== 'discovering') return false
  const controller = new AbortController()
  activeQueueDiscoveries.set(id, controller)
  const browserController = browserAssisted ? controller : null
  const browserOperationId = `queue:${id}`
  if (browserController)
    activeBrowserDiscoveries.set(browserOperationId, browserController)
  let previousChapters: QueueChapter[] = []
  let previousByUrl = new Map<string, QueueChapter>()
  let hadPreviousSnapshot = false
  let verificationRequired = false
  const cleanup = (notify: boolean): void => {
    if (activeBrowserDiscoveries.get(browserOperationId) === browserController) {
      activeBrowserDiscoveries.delete(browserOperationId)
    }
    if (activeQueueDiscoveries.get(id) === controller)
      activeQueueDiscoveries.delete(id)
    if (!dirtyQueueChapterIds.has(id)) releaseQueueItemChapters(item)
    if (notify) notifyDiscoveryQueueChanged()
  }

  try {
    await ensureQueueItemChapters(item)
    if (item.siteExtractionMode === undefined) {
      const settings = await readSettings(dataDirectory())
      item.siteExtractionMode = siteExtractionModeForUrl(
        item.sourceUrl,
        settings.siteExtractionPreferences
      )
      await persistDiscoveryQueue()
      notifyDiscoveryQueueChanged()
    }
    previousChapters = item.chapters.map((chapter) => ({ ...chapter }))
    previousByUrl = new Map(
      previousChapters.map((chapter) => [chapter.url, chapter])
    )
    hadPreviousSnapshot = Boolean(
      item.discoveredAt && previousChapters.length > 0
    )
    const result = browserAssisted
      ? await discoverChaptersUsingPageLoader(
          item.sourceUrl,
          readBrowserPage,
          (progress) => {
            if (activeQueueDiscoveries.get(id) !== controller) return
            item.progress = progress
            notifyDiscoveryQueueChanged()
          },
          controller.signal,
          item.siteExtractionMode
        )
      : await discoverChapters(
          item.sourceUrl,
          (progress) => {
            if (activeQueueDiscoveries.get(id) !== controller) return
            item.progress = progress
            notifyDiscoveryQueueChanged()
          },
          controller.signal,
          item.siteExtractionMode
        )
    if (controller.signal.aborted)
      throw new OperationCancelledError('Discovery was cancelled.')
    if (
      activeQueueDiscoveries.get(id) !== controller ||
      item.status !== 'discovering'
    ) {
      cleanup(false)
      return false
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
    const addedCount = result.chapters.filter(
      (chapter) => !previousByUrl.has(chapter.url)
    ).length
    const removedCount = previousChapters.filter(
      (chapter) => !newUrls.has(chapter.url)
    ).length
    const orderChanged =
      previousChapters.length === result.chapters.length &&
      previousChapters.some(
        (chapter, index) => chapter.url !== result.chapters[index].url
      )
    const refreshedChapters: QueueChapter[] = result.chapters.map(
      (chapter) => ({
        ...chapter,
        archiveStatus: 'missing',
        archiveSources: [],
        chapterNumber: null,
        archiveGap: false,
        recommended: true,
        selected: previousByUrl.get(chapter.url)?.selected ?? true
      })
    )
    const libraryIndex = await readLibraryIndex(dataDirectory())
    if (
      controller.signal.aborted ||
      activeQueueDiscoveries.get(id) !== controller ||
      item.status !== 'discovering'
    ) {
      cleanup(false)
      return false
    }
    const recommendation = recommendArchiveCoverage(
      { ...item, chapters: refreshedChapters },
      libraryIndex?.files ?? []
    )
    item.chapters = recommendation.chapters
    markQueueItemChaptersDirty(item)
    item.recommendationSummary = recommendation.summary
    item.discoveryChanges =
      hadPreviousSnapshot &&
      (addedCount > 0 || removedCount > 0 || orderChanged)
        ? `Chapter list changed: ${addedCount} added, ${removedCount} removed${orderChanged ? ', order changed' : ''}. Review your selection.`
        : ''
    item.status = 'needs-review'
    item.progress = null
    item.error = ''
    item.discoveredAt = new Date().toISOString()
    item.updatedAt = item.discoveredAt
  } catch (error) {
    if (activeQueueDiscoveries.get(id) !== controller) {
      cleanup(false)
      return false
    }
    verificationRequired =
      error instanceof VerificationRequiredError ||
      (error instanceof HttpStatusError &&
        (error.status === 401 || error.status === 403))
    item.status =
      controller.signal.aborted && !shuttingDown ? 'cancelled' : 'failed'
    item.progress = null
    item.error = item.status === 'cancelled' ? '' : errorMessage(error)
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
      console.error(
        `Discovery queue item ${id} failure state could not be saved:`,
        saveError
      )
    }
  }
  cleanup(true)
  return verificationRequired
}

function pumpDiscoveryQueue(): void {
  while (
    !shuttingDown &&
    activeDiscoveries < maxActiveDiscoveries &&
    pendingDiscoveries.length > 0
  ) {
    const id = pendingDiscoveries.shift()!
    activeDiscoveries += 1
    const browserAssisted = browserAssistedDiscoveries.delete(id)
    const task = discoverQueueItem(id, browserAssisted)
      .then(() => undefined)
      .finally(() => {
        activeDiscoveries -= 1
        if (!shuttingDown) pumpDiscoveryQueue()
      })
    trackBackgroundTask(task, `Discovery task ${id}`)
  }
}

async function revalidateStaleQueuedJob(
  item: DiscoveryQueueItem,
  historyEntry: DownloadHistoryEntry
): Promise<boolean> {
  await ensureQueueItemChapters(item)
  const selectedUrls = item.chapters
    .filter((chapter) => chapter.selected)
    .map((chapter) => chapter.url)
  item.status = 'discovering'
  item.error = ''
  item.progress = {
    current: 0,
    total: selectedUrls.length,
    message: 'Refreshing the chapter list before starting this older job…'
  }
  await persistDownloadState(item, historyEntry)

  const verificationRequired = await discoverQueueItem(item.id)
  if (discoveryQueueItemStatus(item) === 'failed' && verificationRequired) {
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

  if (discoveryQueueItemStatus(item) === 'cancelled') {
    historyEntry.status = 'cancelled'
    historyEntry.error = ''
    await persistDownloadState(item, historyEntry)
    releaseQueueItemChapters(item)
    return false
  }

  if (discoveryQueueItemStatus(item) !== 'needs-review') {
    if (discoveryQueueItemStatus(item) !== 'failed') {
      item.status = 'failed'
      item.error =
        'The chapter list could not be refreshed before the EPUB job started.'
    } else {
      item.error = `The chapter list could not be refreshed before the EPUB job started: ${item.error}`
    }
    historyEntry.status = 'failed'
    historyEntry.error = item.error
    await persistDownloadState(item, historyEntry)
    releaseQueueItemChapters(item)
    return false
  }

  await ensureQueueItemChapters(item)
  const previouslySelected = new Set(selectedUrls)
  for (const chapter of item.chapters) {
    chapter.selected = previouslySelected.has(chapter.url)
  }
  markQueueItemChaptersDirty(item)
  const refreshedSelection = item.chapters
    .filter((chapter) => chapter.selected)
    .map((chapter) => chapter.url)
  const selectionUnchanged =
    selectedUrls.length === refreshedSelection.length &&
    selectedUrls.every((url, index) => url === refreshedSelection[index])

  if (!selectionUnchanged) {
    item.status = 'needs-review'
    item.error =
      'The chapter list changed since this EPUB was queued. Review the refreshed chapters before queueing it again.'
    historyEntry.status = 'failed'
    historyEntry.error = item.error
    await persistDownloadState(item, historyEntry)
    releaseQueueItemChapters(item)
    return false
  }

  item.status = 'queued'
  item.error = ''
  item.progress = {
    current: historyEntry.completedChapters,
    total: selectedUrls.length,
    message: 'The chapter list is fresh; starting the queued job…'
  }
  historyEntry.status = 'queued'
  historyEntry.error = ''
  await persistDownloadState(item, historyEntry)
  releaseQueueItemChapters(item)
  return true
}

const trackerRowSchema = z.object({
  stableId: z.string().max(200).trim().min(1),
  rowNumber: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  title: z.string().max(300).trim().min(1),
  alternativeNames: z.string().max(5000).optional(),
  csvPath: z.string().max(2048).trim().min(1)
})

function parseTrackerRow(
  value: unknown,
  invalidMessage: string
): NonNullable<GenerateEpubInput['trackerRow']> {
  const parsed = trackerRowSchema.safeParse(value)
  if (!parsed.success) throw new Error(invalidMessage)
  return parsed.data
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
    const separateJob = input.separateJob
    if (!title || title.length > 300)
      throw new Error(
        `Queue item ${index + 1} needs a title of 1–300 characters.`
      )
    if (author.length > 300)
      throw new Error(
        `Queue item ${index + 1} has an author longer than 300 characters.`
      )
    if (origin !== 'tracker' && origin !== 'manual')
      throw new Error(`Queue item ${index + 1} has an invalid origin.`)
    if (separateJob !== undefined && typeof separateJob !== 'boolean') {
      throw new Error(
        `Queue item ${index + 1} has an invalid separate-job setting.`
      )
    }

    const trackerRow =
      input.trackerRow === undefined
        ? undefined
        : parseTrackerRow(
            input.trackerRow,
            `Queue item ${index + 1} has an invalid tracker association.`
          )
    if (origin === 'tracker' && !trackerRow) {
      throw new Error(
        `Queue item ${index + 1} is missing its tracker association.`
      )
    }

    return {
      title,
      author,
      sourceUrl: validateHttpUrl(input.sourceUrl),
      origin,
      separateJob: separateJob === true,
      trackerRow
    }
  })
}

function runLibraryScanWorker(
  worker: Worker,
  onProgress: (progress: LibraryProgress) => void
): Promise<void> {
  return runWorker<LibraryProgress, void>(worker, {
    workerName: 'Library scan',
    missingResultMessage: 'Library scan worker exited without saving an index.',
    onProgress
  })
}

function runEpubMergeWorker(
  worker: Worker,
  onProgress: (progress: EpubMergeProgress) => void
): Promise<EpubMergeResult> {
  return runWorker<EpubMergeProgress, EpubMergeResult>(worker, {
    workerName: 'EPUB merge',
    missingResultMessage: 'EPUB merge worker exited without creating an EPUB.',
    onProgress
  })
}

function runEpubRepairWorker(
  worker: Worker,
  onProgress: (progress: EpubRepairProgress) => void
): Promise<EpubRepairResult> {
  return runWorker<EpubRepairProgress, EpubRepairResult>(worker, {
    workerName: 'EPUB repair',
    missingResultMessage: 'EPUB repair worker exited without creating an EPUB.',
    onProgress
  })
}

function parseGenerateInput(value: unknown): GenerateEpubInput {
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid EPUB request.')
  const input = value as Record<string, unknown>
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const author = typeof input.author === 'string' ? input.author.trim() : ''
  const description =
    typeof input.description === 'string' ? input.description.trim() : ''
  const coverUrlValue =
    typeof input.coverUrl === 'string' ? input.coverUrl.trim() : ''
  const alternativeNames = parseMetadataLabels(
    input.alternativeNames,
    'Alternative names'
  )
  const genres = parseMetadataLabels(input.genres, 'Genres')
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  const novelStatus =
    typeof input.novelStatus === 'string' ? input.novelStatus.trim() : ''
  const language =
    typeof input.language === 'string' ? input.language.trim() : ''
  if (
    input.description !== undefined &&
    typeof input.description !== 'string'
  ) {
    throw new Error('The novel description must be text.')
  }
  if (input.coverUrl !== undefined && typeof input.coverUrl !== 'string') {
    throw new Error('The novel cover URL must be text.')
  }
  if (input.source !== undefined && typeof input.source !== 'string') {
    throw new Error('The novel source must be text.')
  }
  if (
    input.novelStatus !== undefined &&
    typeof input.novelStatus !== 'string'
  ) {
    throw new Error('The novel status must be text.')
  }
  if (description.length > MAX_NOVEL_DESCRIPTION_LENGTH) {
    throw new Error(
      `The novel description must be ${MAX_NOVEL_DESCRIPTION_LENGTH.toLocaleString()} characters or fewer.`
    )
  }
  if (source.length > 300 || novelStatus.length > 300) {
    throw new Error('Novel source and status must be 300 characters or fewer.')
  }
  if (input.filename !== undefined && typeof input.filename !== 'string') {
    throw new Error('The EPUB filename must be text.')
  }
  const filename =
    typeof input.filename === 'string' ? input.filename.trim() : ''
  const sourceUrl =
    input.sourceUrl === undefined ? '' : validateHttpUrl(input.sourceUrl)
  const coverUrl = coverUrlValue ? validateHttpUrl(coverUrlValue) : ''
  const outputDirectory =
    typeof input.outputDirectory === 'string' ? input.outputDirectory : ''

  if (!title || title.length > 300)
    throw new Error('Enter a title of 1–300 characters.')
  if (author.length > 300)
    throw new Error('Author must be 300 characters or fewer.')
  if (filename.length > 255)
    throw new Error('The EPUB filename must be 255 characters or fewer.')
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) {
    throw new Error('Enter a valid language code, such as en or en-US.')
  }
  if (!approvedOutputDirectories.has(resolve(outputDirectory))) {
    throw new Error(
      'Choose an output folder using the folder picker before creating the EPUB.'
    )
  }
  if (
    !Array.isArray(input.chapters) ||
    input.chapters.length === 0 ||
    input.chapters.length > MAX_SELECTED_CHAPTERS
  ) {
    throw new Error(
      `Select between 1 and ${MAX_SELECTED_CHAPTERS.toLocaleString()} chapters.`
    )
  }
  const trackerRow =
    input.trackerRow === undefined
      ? undefined
      : parseTrackerRow(input.trackerRow, 'The selected tracker row is invalid.')

  const chapters: ChapterLink[] = input.chapters.map((chapter, index) => {
    if (typeof chapter !== 'object' || chapter === null)
      throw new Error(`Chapter ${index + 1} is invalid.`)
    const item = chapter as Record<string, unknown>
    if (
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 500
    ) {
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
      throw new Error(
        `Each ${label.toLowerCase()} value must be text of 300 characters or fewer.`
      )
    }
    if (item.trim()) labels.add(item.trim())
  }
  return [...labels]
}

function canRetryChapter(error: unknown): boolean {
  if (
    error instanceof OperationCancelledError ||
    error instanceof VerificationRequiredError ||
    error instanceof NoReadableContentError
  ) {
    return false
  }
  if (error instanceof HttpStatusError)
    return error.status === 408 || error.status === 429 || error.status >= 500
  return error instanceof TransientNetworkError
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
  historyEntry: DownloadHistoryEntry,
  maxSimultaneousChapters: number
): Promise<void> {
  const item = discoveryQueue.find((candidate) => candidate.id === itemId)
  if (!item || !item.downloadOptions) return
  const options = item.downloadOptions
  const saveAvailableChaptersOnly = item.saveAvailableChaptersOnly === true
  const selectedChapters = item.chapters.filter((chapter) => chapter.selected)
  const missingSelectedChapterUrls = new Set<string>()
  let completedSelectedChapterCount = 0
  let activeChapterRequests = 0
  let lastCheckpointAt = Date.now()
  let chaptersSinceCheckpoint = 0
  let progressCheckpointTail = Promise.resolve()
  let releaseOutputReservation = (): void => {}

  const recordUnavailableChapter = (
    chapter: ChapterLink,
    reason: string
  ): void => {
    missingSelectedChapterUrls.add(chapter.url)
    item.failedChapters = [
      ...item.failedChapters.filter((failed) => failed.url !== chapter.url),
      { url: chapter.url, title: chapter.title, error: reason }
    ]
    item.error = `${missingSelectedChapterUrls.size} selected chapter(s) are unavailable; saving the available chapters.`
  }

  const persistChapterProgress = (): Promise<void> => {
    const operation = progressCheckpointTail.then(async () => {
      chaptersSinceCheckpoint += 1
      const now = Date.now()
      const shouldCheckpoint =
        chaptersSinceCheckpoint >= 25 || now - lastCheckpointAt >= 5000
      await persistDownloadState(item, historyEntry, shouldCheckpoint)
      if (shouldCheckpoint) {
        chaptersSinceCheckpoint = 0
        lastCheckpointAt = now
      }
    })
    progressCheckpointTail = operation
    return operation
  }

  try {
    if (selectedChapters.length === 0)
      throw new Error('Select at least one chapter before queueing this EPUB.')
    const processChapter = async (
      index: number,
      chapter: ChapterLink
    ): Promise<void> => {
      const active = activeDownloads.get(itemId)
      if (
        !active ||
        active.requestedAction !== 'none' ||
        controller.signal.aborted
      )
        return
      let savedContent: ChapterContent | null = null
      if (item.repackageOnly) {
        item.progress = {
          current: completedSelectedChapterCount,
          total: selectedChapters.length,
          message: `Validating saved chapter ${index + 1} of ${selectedChapters.length}: ${chapter.title}`
        }
        await persistDownloadState(item, historyEntry, false)
        try {
          savedContent = await readChapterArtifact(
            dataDirectory(),
            itemId,
            chapter.url
          )
        } catch (error) {
          if (!saveAvailableChaptersOnly) throw error
          console.warn(
            `Saved chapter artifact for ${chapter.url} will be omitted:`,
            errorMessage(error)
          )
        }
        if (!savedContent || savedContent.url !== chapter.url) {
          const reason = `Saved chapter content is missing or invalid for "${chapter.title}".`
          if (!saveAvailableChaptersOnly) throw new Error(reason)
          recordUnavailableChapter(chapter, reason)
          historyEntry.completedChapters = completedSelectedChapterCount
          item.progress = {
            current: completedSelectedChapterCount,
            total: selectedChapters.length,
            message: `Skipped unavailable saved chapter: ${chapter.title}`
          }
          await persistChapterProgress()
          return
        }
        missingSelectedChapterUrls.delete(chapter.url)
        item.failedChapters = item.failedChapters.filter(
          (failed) => failed.url !== chapter.url
        )
        completedSelectedChapterCount += 1
      } else {
        try {
          savedContent = await readChapterArtifact(
            dataDirectory(),
            itemId,
            chapter.url
          )
          if (savedContent && savedContent.url !== chapter.url) {
            console.warn(
              `Saved chapter artifact for ${chapter.url} has a mismatched URL and will be fetched again.`
            )
            savedContent = null
          }
        } catch (error) {
          console.warn(
            `Saved chapter artifact for ${chapter.url} will be fetched again:`,
            errorMessage(error)
          )
        }
        if (savedContent) {
          completedSelectedChapterCount += 1
          item.failedChapters = item.failedChapters.filter(
            (failed) => failed.url !== chapter.url
          )
        }
      }

      if (!savedContent) {
        let lastError: unknown = new Error('Chapter could not be fetched.')
        activeChapterRequests += 1
        try {
          item.progress = {
            current: completedSelectedChapterCount,
            total: selectedChapters.length,
            message: `Fetching chapter ${index + 1} of ${selectedChapters.length} (${activeChapterRequests} active): ${chapter.title}`
          }
          await persistDownloadState(item, historyEntry, false)

          try {
            savedContent = await withRetry(
              () =>
                fetchChapterContentWithBrowserFallback(
                  chapter,
                  controller.signal
                ),
              {
                attempts: 3,
                shouldRetry: canRetryChapter,
                signal: controller.signal,
                cancellationMessage: 'EPUB creation was cancelled.'
              }
            )
          } catch (error) {
            if (controller.signal.aborted) return
            lastError = error
          }

          if (controller.signal.aborted) return
          if (savedContent) {
            await writeChapterArtifact(dataDirectory(), itemId, savedContent)
            completedSelectedChapterCount += 1
            item.failedChapters = item.failedChapters.filter(
              (failed) => failed.url !== chapter.url
            )
          } else {
            item.failedChapters = [
              ...item.failedChapters.filter(
                (failed) => failed.url !== chapter.url
              ),
              {
                url: chapter.url,
                title: chapter.title,
                error: errorMessage(lastError)
              }
            ]
            item.error = `${item.failedChapters.length} chapter(s) failed. Retry failed chapters to continue.`
          }
        } finally {
          activeChapterRequests -= 1
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

    let nextChapterIndex = 0
    let fatalError: Error | undefined
    const worker = async (): Promise<void> => {
      while (true) {
        const active = activeDownloads.get(itemId)
        if (
          !active ||
          active.requestedAction !== 'none' ||
          controller.signal.aborted ||
          fatalError
        )
          return
        const index = nextChapterIndex
        nextChapterIndex += 1
        const chapter = selectedChapters[index]
        if (!chapter) return
        try {
          await processChapter(index, chapter)
        } catch (error) {
          fatalError ??=
            error instanceof Error ? error : new Error(String(error))
          controller.abort()
          return
        }
      }
    }
    const workerCount = Math.min(
      maxSimultaneousChapters,
      selectedChapters.length
    )
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    await progressCheckpointTail
    if (fatalError) throw fatalError

    const requestedAction =
      activeDownloads.get(itemId)?.requestedAction ?? 'cancel'
    if (requestedAction === 'pause') {
      item.status = 'paused'
      item.progress = {
        ...(item.progress ?? {
          current: 0,
          total: selectedChapters.length,
          message: ''
        }),
        message: 'Paused'
      }
      historyEntry.status = 'paused'
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      return
    }
    if (requestedAction === 'shutdown') {
      item.status = 'downloading'
      item.progress = {
        ...(item.progress ?? {
          current: 0,
          total: selectedChapters.length,
          message: ''
        }),
        message: 'Interrupted; resuming after app restart'
      }
      historyEntry.status = 'interrupted'
      historyEntry.error = 'The app closed before this job finished.'
      await persistDownloadState(item, historyEntry)
      return
    }
    if (requestedAction === 'cancel' || controller.signal.aborted) {
      item.status = 'cancelled'
      item.progress = {
        ...(item.progress ?? {
          current: 0,
          total: selectedChapters.length,
          message: ''
        }),
        message: 'Cancelled'
      }
      historyEntry.status = 'cancelled'
      historyEntry.error = ''
      await persistDownloadState(item, historyEntry)
      return
    }
    if (item.failedChapters.length > 0 && !saveAvailableChaptersOnly) {
      item.status =
        completedSelectedChapterCount > 0 ? 'partially-completed' : 'failed'
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
      let content: ChapterContent | null = null
      let artifactError: Error | undefined
      try {
        content = await readChapterArtifact(
          dataDirectory(),
          itemId,
          chapter.url
        )
      } catch (error) {
        artifactError =
          error instanceof Error ? error : new Error(String(error))
      }
      if (!content || content.url !== chapter.url) {
        const reason = `Saved chapter content is missing or invalid for "${chapter.title}".`
        if (!saveAvailableChaptersOnly) {
          if (artifactError) throw artifactError
          throw new Error(reason)
        }
        recordUnavailableChapter(chapter, reason)
        continue
      }
      missingSelectedChapterUrls.delete(chapter.url)
      chapters.push(content)
    }
    if (chapters.length === 0) {
      throw new Error(
        'No valid saved chapter content is available to create an EPUB.'
      )
    }
    let cover: ChapterImage | undefined
    if (options.coverUrl) {
      if (item.repackageOnly) {
        try {
          cover =
            (await readCoverArtifact(dataDirectory(), itemId)) ?? undefined
        } catch (error) {
          if (!saveAvailableChaptersOnly) throw error
          console.warn(
            `Saved cover artifact for queue item ${itemId} will be omitted:`,
            errorMessage(error)
          )
        }
        if (!cover && !saveAvailableChaptersOnly) {
          throw new Error(
            'Saved cover content is missing; retry this EPUB online before repackaging.'
          )
        }
      } else {
        try {
          cover =
            (await readCoverArtifact(dataDirectory(), itemId)) ?? undefined
        } catch (error) {
          console.warn(
            `Saved cover artifact for queue item ${itemId} will be fetched again:`,
            errorMessage(error)
          )
        }
        if (!cover) {
          item.progress = {
            current: selectedChapters.length,
            total: selectedChapters.length,
            message: 'Fetching novel cover…'
          }
          await persistDownloadState(item, historyEntry)
          try {
            cover = await withRetry(
              async () => {
                const fetchedCover = await fetchImageResource(
                  options.coverUrl,
                  options.sourceUrl || item.sourceUrl,
                  controller.signal
                )
                await writeCoverArtifact(dataDirectory(), itemId, fetchedCover)
                return fetchedCover
              },
              {
                attempts: 3,
                shouldRetry: canRetryChapter,
                signal: controller.signal,
                cancellationMessage: 'EPUB creation was cancelled.'
              }
            )
          } catch (error) {
            if (controller.signal.aborted) {
              throw new OperationCancelledError('EPUB creation was cancelled.')
            }
            throw error
          }
        }
      }
    }
    item.progress = {
      current: chapters.length,
      total: selectedChapters.length,
      message: 'Validating and packaging EPUB…'
    }
    await persistDownloadState(item, historyEntry)
    const omittedChapterCount = selectedChapters.length - chapters.length
    const incompleteOutput =
      saveAvailableChaptersOnly && omittedChapterCount > 0
    let outputFilename = options.filename
    if (incompleteOutput) {
      const reservation = await reserveIncompleteEpubFilename(
        item,
        selectedChapters
      )
      outputFilename = reservation.filename
      item.targetOutputPath = reservation.outputPath
      releaseOutputReservation = reservation.release
      await persistDownloadState(item, historyEntry)
    } else {
      const outputPath = expectedOutputPath(
        options.outputDirectory,
        options.title,
        options.filename,
        selectedChapters
      )
      assertOutputPathAvailable(outputPath, itemId)
      item.targetOutputPath = outputPath
      await persistDownloadState(item, historyEntry)
    }
    const result = await writeEpub(
      options.outputDirectory,
      options.title,
      options.author,
      options.language,
      chapters,
      outputFilename,
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
    item.status = incompleteOutput ? 'partially-completed' : 'completed'
    item.repackageOnly = false
    item.saveAvailableChaptersOnly = false
    item.outputPath = result.outputPath
    item.targetOutputPath = result.outputPath.toLowerCase()
    item.error = incompleteOutput
      ? `${omittedChapterCount} selected chapter(s) were omitted. Retry to fetch them and create a complete EPUB.`
      : ''
    item.progress = {
      current: chapters.length,
      total: selectedChapters.length,
      message: incompleteOutput
        ? `Saved ${chapters.length} of ${selectedChapters.length} selected chapters (incomplete)`
        : 'Completed'
    }
    item.completedChapterUrls = []
    item.failedChapters = incompleteOutput
      ? item.failedChapters.filter((failed) =>
          missingSelectedChapterUrls.has(failed.url)
        )
      : []
    historyEntry.completedChapters = chapters.length
    historyEntry.status = item.status
    historyEntry.outputPath = result.outputPath
    historyEntry.error = item.error
    await persistDownloadState(item, historyEntry)
    if (!incompleteOutput) {
      await removeChapterArtifacts(dataDirectory(), itemId).catch(
        (error: unknown) => {
          console.warn(
            `Completed chapter artifacts for queue item ${itemId} could not be removed:`,
            errorMessage(error)
          )
        }
      )
    }
  } catch (error) {
    const requestedAction =
      activeDownloads.get(itemId)?.requestedAction ?? 'none'
    if (requestedAction === 'shutdown') {
      item.status = 'downloading'
      item.error = ''
      historyEntry.status = 'interrupted'
      historyEntry.error = 'The app closed before this job finished.'
      item.progress = {
        current: historyEntry.completedChapters,
        total: historyEntry.selectedChapterCount,
        message: 'Interrupted; resuming after app restart'
      }
    } else if (requestedAction === 'pause' || requestedAction === 'cancel') {
      item.status = requestedAction === 'pause' ? 'paused' : 'cancelled'
      historyEntry.status = requestedAction === 'pause' ? 'paused' : 'cancelled'
      historyEntry.error = ''
    } else {
      item.status =
        completedSelectedChapterCount > 0 ? 'partially-completed' : 'failed'
      historyEntry.completedChapters = completedSelectedChapterCount
      item.error = errorMessage(error)
      historyEntry.status = item.status
      historyEntry.error = item.error
      console.error(`Queued EPUB job ${itemId} failed:`, error)
    }
    if (requestedAction !== 'shutdown') {
      item.progress = {
        current: historyEntry.completedChapters,
        total: historyEntry.selectedChapterCount,
        message: item.status
      }
    }
    try {
      await persistDownloadState(item, historyEntry)
    } catch (saveError) {
      console.error(
        `Queued EPUB job ${itemId} state could not be saved:`,
        saveError
      )
    }
  } finally {
    releaseOutputReservation()
  }
}

async function pumpDownloadQueue(): Promise<void> {
  if (shuttingDown) return
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
    while (
      !shuttingDown &&
      activeDownloads.size < settings.maxSimultaneousDownloads
    ) {
      const item = discoveryQueue
        .filter(
          (candidate) =>
            candidate.status === 'queued' && candidate.downloadOptions
        )
        .sort(
          (left, right) =>
            left.queuedAt.localeCompare(right.queuedAt) ||
            left.id.localeCompare(right.id)
        )[0]
      if (!item) break
      const history = await readDownloadHistory(dataDirectory())
      const ensuredHistory = await ensureQueueItemHistoryEntry(item, history)
      const historyEntry = ensuredHistory?.entry ?? null
      const currentHead = discoveryQueue
        .filter(
          (candidate) =>
            candidate.status === 'queued' && candidate.downloadOptions
        )
        .sort(
          (left, right) =>
            left.queuedAt.localeCompare(right.queuedAt) ||
            left.id.localeCompare(right.id)
        )[0]
      if (item.status !== 'queued' || currentHead?.id !== item.id) continue
      if (!historyEntry) {
        item.status = 'failed'
        item.error =
          'The saved EPUB job details are missing and cannot be restored.'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        continue
      }
      if (
        !item.repackageOnly &&
        discoverySnapshotIsStale(
          item.discoveredAt,
          settings.discoveryFreshnessHours
        )
      ) {
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
            console.error(
              `Stale EPUB job ${item.id} failure state could not be saved:`,
              saveError
            )
            notifyDiscoveryQueueChanged()
          }
        }
        if (item.status === 'queued') item.chapters = []
        continue
      }
      try {
        await ensureQueueItemChapters(item)
      } catch (error) {
        item.status = 'failed'
        item.error = errorMessage(error)
        item.updatedAt = new Date().toISOString()
        historyEntry.status = 'failed'
        historyEntry.error = item.error
        await persistDownloadState(item, historyEntry)
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
          console.error(
            `Queued EPUB job ${item.id} failure state could not be saved:`,
            saveError
          )
        })
        await persistHistoryEntry(historyEntry).catch((saveError: unknown) => {
          console.error(
            `Queued EPUB job ${item.id} failure history could not be saved:`,
            saveError
          )
        })
        notifyDiscoveryQueueChanged()
        continue
      }
      const task = runQueuedDownload(
        item.id,
        controller,
        historyEntry,
        settings.maxSimultaneousChaptersPerNovel
      ).finally(() => {
        activeDownloads.delete(item.id)
        const finishedItem = discoveryQueue.find(
          (candidate) => candidate.id === item.id
        )
        if (
          finishedItem &&
          finishedItem.downloadOptions &&
          [
            'completed',
            'partially-completed',
            'failed',
            'cancelled',
            'paused'
          ].includes(finishedItem.status)
        ) {
          finishedItem.chapters = []
        }
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
      })
      trackBackgroundTask(task, `EPUB download task ${item.id}`)
    }
  } catch (error) {
    console.error('Download queue scheduler failed:', error)
    const history = await readDownloadHistory(dataDirectory()).catch(
      (readError: unknown) => {
        console.error(
          'Download history could not be loaded after a scheduler failure:',
          readError
        )
        return []
      }
    )
    for (const item of discoveryQueue) {
      if (item.status === 'queued') {
        item.status = 'failed'
        item.error = errorMessage(error)
        item.updatedAt = new Date().toISOString()
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (historyEntry) {
          historyEntry.status = 'failed'
          historyEntry.error = item.error
          historyEntry.updatedAt = item.updatedAt
          await persistHistoryEntry(historyEntry).catch(
            (saveError: unknown) => {
              console.error(
                `Download history for ${item.id} could not be updated:`,
                saveError
              )
            }
          )
        }
      }
    }
    await persistDiscoveryQueue().catch((saveError: unknown) => {
      console.error(
        'Download queue scheduler failure could not be saved:',
        saveError
      )
    })
    notifyDiscoveryQueueChanged()
  } finally {
    downloadPumpRunning = false
    if (downloadPumpRequested && !shuttingDown) {
      downloadPumpRequested = false
      void pumpDownloadQueue().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
    }
  }
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  mainWindowReady = false
  window.once('ready-to-show', () => {
    mainWindowReady = true
    window.maximize()
    window.show()
    if (focusRequestedBeforeWindowReady) {
      focusRequestedBeforeWindowReady = false
      window.focus()
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('unresponsive', () => {
    console.error('Renderer became unresponsive.')
  })
  window.webContents.on('responsive', () => {
    console.info('Renderer became responsive.')
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details.reason, details.exitCode)
  })
  window.webContents.on('will-navigate', (event, target) => {
    try {
      const current = new URL(window.webContents.getURL())
      const next = new URL(target)
      if (next.origin !== current.origin || next.protocol !== current.protocol)
        event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault()
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  handleResultIpc('chapter:discover', z.tuple([z.string()]), (_event, url) =>
    discoverChapters(url)
  )

  handleResultIpc(
    'browser:open-verification',
    z.tuple([z.string()]),
    (_event, url) => openVerificationBrowser(url, dataDirectory())
  )

  handleResultIpc(
    'browser:discover',
    z.tuple([z.string()]),
    async (event, url) => {
      if (shuttingDown) throw new Error('NovelTracker is closing.')
      const controller = new AbortController()
      const operationId = `renderer:${event.sender.id}`
      if (activeBrowserDiscoveries.has(operationId)) {
        throw new Error('Browser-assisted discovery is already running.')
      }
      activeBrowserDiscoveries.set(operationId, controller)
      try {
        return await discoverChaptersUsingPageLoader(
          url,
          readBrowserPage,
          undefined,
          controller.signal
        )
      } finally {
        activeBrowserDiscoveries.delete(operationId)
      }
    }
  )

  handleTypedIpc(
    'browser:cancel-discovery',
    z.tuple([z.string().optional()]),
    (event, queueItemId) => {
      const operationId =
        queueItemId !== undefined
          ? `queue:${queueItemId}`
          : `renderer:${event.sender.id}`
      activeBrowserDiscoveries.get(operationId)?.abort()
    }
  )

  handleValidatedResultIpc('browser:clear-session', z.tuple([]), async () => {
      await clearBrowserSession(dataDirectory())
      return { ok: true, value: undefined }
  })

  handleTypedIpc('dialog:choose-output-directory', z.tuple([]), async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose EPUB output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await stat(directory)
    if (!details.isDirectory())
      throw new Error('The selected output path is not a folder.')
    await updateSettings((settings) => {
      settings.outputDirectory = directory
    })
    approvedOutputDirectories.add(directory)
    return directory
  })

  handleTypedIpc('settings:get', z.tuple([]), async () =>
    readSettings(dataDirectory())
  )

  handleResultIpc(
    'settings:epub-css',
    z.tuple([
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= MAX_EPUB_CSS_LENGTH,
        `EPUB CSS must be text of at most ${MAX_EPUB_CSS_LENGTH.toLocaleString()} characters.`
      )
    ]),
    async (_event, css) =>
      updateSettings((current) => {
        current.epubCss = css
      })
  )

  handleResultIpc(
    'settings:app-theme',
    z.tuple([
      z.custom<AppSettings['appTheme']>(
        (value): value is AppSettings['appTheme'] =>
          value === 'light' || value === 'dark',
        'The app theme must be light or dark.'
      )
    ]),
    async (_event, theme) =>
      updateSettings((current) => {
        current.appTheme = theme
      })
  )

  handleResultIpc(
    'settings:download-concurrency',
    z.tuple([
      integerInRange(
        MIN_SIMULTANEOUS_DOWNLOADS,
        MAX_SIMULTANEOUS_DOWNLOADS,
        `Maximum simultaneous downloads must be a whole number from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
      )
    ]),
    async (_event, value) =>
      updateSettings(
        (settings) => {
          settings.maxSimultaneousDownloads = value
        },
        () => {
          void pumpDownloadQueue().catch((error: unknown) => {
            console.error('Download queue scheduler failed:', error)
          })
        }
      )
  )

  handleResultIpc(
    'settings:discovery-concurrency',
    z.tuple([
      integerInRange(
        MIN_SIMULTANEOUS_DISCOVERIES,
        MAX_SIMULTANEOUS_DISCOVERIES,
        `Maximum simultaneous discoveries must be a whole number from ${MIN_SIMULTANEOUS_DISCOVERIES} to ${MAX_SIMULTANEOUS_DISCOVERIES}.`
      )
    ]),
    async (_event, value) =>
      updateSettings(
        (current) => {
          current.maxSimultaneousDiscoveries = value
        },
        () => {
          maxActiveDiscoveries = value
          pumpDiscoveryQueue()
        }
      )
  )

  handleResultIpc(
    'settings:chapter-concurrency',
    z.tuple([
      integerInRange(
        MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
        MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
        `Maximum chapter requests per novel must be a whole number from ${MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL} to ${MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL}.`
      )
    ]),
    async (_event, value) =>
      updateSettings((current) => {
        current.maxSimultaneousChaptersPerNovel = value
      })
  )

  handleResultIpc(
    'settings:domain-request-delays',
    z.tuple([
      z.custom<DomainRequestDelayPreference[]>(
        (value): value is DomainRequestDelayPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_DOMAIN_REQUEST_PREFERENCES,
        `Configure no more than ${MAX_DOMAIN_REQUEST_PREFERENCES} domain request delays.`
      )
    ]),
    async (_event, preferences) =>
      updateSettings(
        (current) => {
          current.domainRequestDelays =
            normalizeDomainRequestDelays(preferences)
        },
        (current) => {
          setDomainRequestDelays(current.domainRequestDelays)
        }
      )
  )

  handleResultIpc(
    'settings:site-extraction-preferences',
    z.tuple([
      z.custom<SiteExtractionPreference[]>(
        (value): value is SiteExtractionPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_SITE_EXTRACTION_PREFERENCES,
        `Configure no more than ${MAX_SITE_EXTRACTION_PREFERENCES} site extraction preferences.`
      )
    ]),
    async (_event, preferences) =>
      updateSettings((current) => {
        current.siteExtractionPreferences =
          normalizeSiteExtractionPreferences(preferences)
      })
  )

  handleResultIpc(
    'settings:library-scan-options',
    z.tuple([
      z.custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old-folder scan option must be enabled or disabled.'
      ),
      z.custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old Completed-folder scan option must be enabled or disabled.'
      )
    ]),
    async (_event, scanOldFolder, scanOldCompletedFolder) =>
      updateSettings((current) => {
        current.scanOldFolder = scanOldFolder
        current.scanOldCompletedFolder = scanOldCompletedFolder
      })
  )

  handleResultIpc(
    'settings:discovery-freshness',
    z.tuple([
      integerInRange(
        MIN_DISCOVERY_FRESHNESS_HOURS,
        MAX_DISCOVERY_FRESHNESS_HOURS,
        `The discovery freshness window must be a whole number from ${MIN_DISCOVERY_FRESHNESS_HOURS} to ${MAX_DISCOVERY_FRESHNESS_HOURS} hours.`
      )
    ]),
    async (_event, value) =>
      updateSettings(
        (current) => {
          current.discoveryFreshnessHours = value
        },
        () => {
          void pumpDownloadQueue().catch((error: unknown) => {
            console.error('Download queue scheduler failed:', error)
          })
        }
      )
  )

  handleTypedIpc('dialog:choose-library-root', z.tuple([]), async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose historical library root',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error('The selected library root is not a folder.')

    const settings = await updateSettings(async (current) => {
      current.libraryRoot = directory
      const downloaded = resolve(directory, 'Downloaded')
      try {
        const downloadedDetails = await lstat(downloaded)
        if (
          downloadedDetails.isDirectory() &&
          !downloadedDetails.isSymbolicLink() &&
          !current.outputDirectory
        ) {
          current.outputDirectory = await realpath(downloaded)
        }
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
      }
    })
    if (settings.outputDirectory)
      approvedOutputDirectories.add(settings.outputDirectory)
    return directory
  })

  handleTypedIpc('dialog:choose-tracker-csv', z.tuple([]), async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Novel Tracker CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = await realpath(result.filePaths[0])
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error('The selected CSV path is not a file.')
    await updateSettings((settings) => {
      settings.trackerCsvPath = path
    })
    return path
  })

  handleValidatedResultIpc('tracker:list', z.tuple([]), async () => {
      const settings = await readSettings(dataDirectory())
      if (!settings.trackerCsvPath)
        throw new Error('Choose a tracker CSV file in Configuration first.')
      return { ok: true, value: await readTrackerCsv(settings.trackerCsvPath) }
  })

  handleTypedIpc('download-history:list', z.tuple([]), async () =>
    readDownloadHistory(dataDirectory())
  )

  handleTypedIpc('discovery-queue:list', z.tuple([]), () =>
    copyDiscoveryQueue()
  )

  handleResultIpc(
    'discovery-queue:item',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, id) => {
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      const chapters =
        item.chapters.length > 0 || item.chapterSummary.total === 0
          ? item.chapters
          : await readDiscoveryQueueItemChapters(dataDirectory(), item.id)
      if (!chapters || chapters.length !== item.chapterSummary.total) {
        throw new Error(
          `Saved chapter details are missing or incomplete for "${item.title}".`
        )
      }
      return copyQueueItem({ ...item, chapters })
    }
  )

  handleResultIpc(
    'discovery-queue:add',
    z.tuple([
      z.custom<DiscoveryQueueInput[]>(
        (value): value is DiscoveryQueueInput[] => Array.isArray(value),
        'Add between 1 and 100 tracker novels or URLs at a time.'
      )
    ]),
    async (_event, rawItems) => {
      const inputs = parseDiscoveryQueueInputs(rawItems)
      const existingUrls = new Set(discoveryQueue.map((item) => item.sourceUrl))
      const submittedUrls = new Set<string>()
      const added: DiscoveryQueueItem[] = []
      for (const input of inputs) {
        if (submittedUrls.has(input.sourceUrl)) continue
        submittedUrls.add(input.sourceUrl)
        const isDuplicateSource = existingUrls.has(input.sourceUrl)
        if (isDuplicateSource && !input.separateJob) continue
        if (isDuplicateSource) {
          for (const existingItem of discoveryQueue) {
            if (
              existingItem.sourceUrl === input.sourceUrl &&
              !existingItem.downloadOptions
            ) {
              existingItem.separateJob = true
            }
          }
        }
        existingUrls.add(input.sourceUrl)
        const now = new Date().toISOString()
        added.push(
          createQueueItem({
            title: input.title,
            author: input.author,
            sourceUrl: input.sourceUrl,
            origin: input.origin,
            separateJob: isDuplicateSource && input.separateJob === true,
            trackerRow: input.trackerRow ?? null,
            status: 'discovering',
            saveAvailableChaptersOnly: false,
            updatedAt: now
          })
        )
      }

      if (added.length > 0) {
        discoveryQueue.push(...added)
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(...added.map((item) => item.id))
        pumpDiscoveryQueue()
      }
      return added
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item)
          throw new Error('The selected discovery queue item no longer exists.')
        if (
          (item.status !== 'failed' && item.status !== 'cancelled') ||
          item.downloadOptions
        ) {
          throw new Error(
            'Only failed or cancelled discovery items can be retried.'
          )
        }
        const previousError = item.error
        const previousUpdatedAt = item.updatedAt
        item.status = 'discovering'
        item.error = ''
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueueOrRollback(() => {
          item.status = 'failed'
          item.error = previousError
          item.updatedAt = previousUpdatedAt
        })
        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(item.id)
        pumpDiscoveryQueue()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry-failed',
    z.tuple([]),
    async () => {
        const failedItems = discoveryQueue.filter(
          (item) => item.status === 'failed' && !item.downloadOptions
        )
        if (failedItems.length === 0) return { ok: true, value: 0 }

        const previousStates = failedItems.map((item) => ({
          item,
          error: item.error,
          progress: item.progress,
          updatedAt: item.updatedAt
        }))
        const now = new Date().toISOString()
        for (const item of failedItems) {
          item.status = 'discovering'
          item.progress = null
          item.error = ''
          item.updatedAt = now
        }

        await persistDiscoveryQueueOrRollback(() => {
          for (const previous of previousStates) {
            previous.item.status = 'failed'
            previous.item.error = previous.error
            previous.item.progress = previous.progress
            previous.item.updatedAt = previous.updatedAt
          }
        })

        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(...failedItems.map((item) => item.id))
        pumpDiscoveryQueue()
        return { ok: true, value: failedItems.length }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:force-retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || item.status !== 'discovering' || item.downloadOptions) {
          throw new Error('Only active discovery items can be force-retried.')
        }

        browserAssistedDiscoveries.delete(item.id)
        const supersedingController = new AbortController()
        const activeController = activeQueueDiscoveries.get(item.id)
        activeQueueDiscoveries.set(item.id, supersedingController)
        activeController?.abort()
        for (
          let index = pendingDiscoveries.length - 1;
          index >= 0;
          index -= 1
        ) {
          if (pendingDiscoveries[index] === item.id)
            pendingDiscoveries.splice(index, 1)
        }
        item.error = ''
        item.progress = {
          current: 0,
          total: 0,
          message: 'Restarting chapter discovery…'
        }
        item.updatedAt = new Date().toISOString()

        try {
          await persistDiscoveryQueue()
        } catch (error) {
          item.status = 'failed'
          item.error = `The forced discovery retry could not be saved: ${errorMessage(error)}`
          item.updatedAt = new Date().toISOString()
          if (activeQueueDiscoveries.get(item.id) === supersedingController) {
            activeQueueDiscoveries.delete(item.id)
          }
          await persistDiscoveryQueue().catch((saveError: unknown) => {
            console.error(
              `Discovery retry failure state for ${item.id} could not be saved:`,
              saveError
            )
          })
          throw error
        }

        pendingDiscoveries.push(item.id)
        notifyDiscoveryQueueChanged()
        pumpDiscoveryQueue()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry-browser',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item)
          throw new Error('The selected discovery queue item no longer exists.')
        if (
          (item.status !== 'failed' && item.status !== 'cancelled') ||
          item.downloadOptions
        ) {
          throw new Error(
            'Only failed or cancelled discovery items can be retried with the browser.'
          )
        }
        const previousError = item.error
        const previousUpdatedAt = item.updatedAt
        item.status = 'discovering'
        item.error = ''
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueueOrRollback(() => {
          item.status = 'failed'
          item.error = previousError
          item.updatedAt = previousUpdatedAt
        })
        browserAssistedDiscoveries.add(item.id)
        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(item.id)
        pumpDiscoveryQueue()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:refresh',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item)
          throw new Error('The selected discovery queue item no longer exists.')
        if (item.status !== 'needs-review' && item.status !== 'ready') {
          throw new Error('Only reviewed discovery items can be refreshed.')
        }
        const previousUpdatedAt = item.updatedAt
        const previousStatus = item.status
        const previousExtractionMode = item.siteExtractionMode
        const settings = await readSettings(dataDirectory())
        item.siteExtractionMode = siteExtractionModeForUrl(
          item.sourceUrl,
          settings.siteExtractionPreferences
        )
        item.status = 'discovering'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueueOrRollback(() => {
          item.status = previousStatus
          item.siteExtractionMode = previousExtractionMode
          item.updatedAt = previousUpdatedAt
        })
        notifyDiscoveryQueueChanged()
        pendingDiscoveries.push(item.id)
        pumpDiscoveryQueue()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:accept-recommendations',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid recommendation settings.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (
          !item ||
          (item.status !== 'needs-review' && item.status !== 'ready')
        ) {
          throw new Error('The selected item is not ready for recommendations.')
        }
        await ensureQueueItemChapters(item)
        const libraryIndex = await readLibraryIndex(dataDirectory())
        const recommendation = recommendArchiveCoverage(
          item,
          libraryIndex?.files ?? []
        )
        item.chapters = recommendation.chapters.map((chapter) => ({
          ...chapter,
          selected: chapter.recommended
        }))
        markQueueItemChaptersDirty(item)
        item.recommendationSummary = recommendation.summary
        item.status = item.chapters.some((chapter) => chapter.selected)
          ? 'ready'
          : 'needs-review'
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
        releaseQueueItemChapters(item)
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:cancel',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || item.status !== 'discovering') {
          throw new Error('The selected discovery is no longer running.')
        }

        const controller = activeQueueDiscoveries.get(rawId)
        if (controller) {
          controller.abort()
          return { ok: true, value: undefined }
        }

        const pendingIndex = pendingDiscoveries.indexOf(rawId)
        if (pendingIndex < 0)
          throw new Error('The selected discovery is no longer running.')
        const wasBrowserAssisted = browserAssistedDiscoveries.delete(rawId)
        pendingDiscoveries.splice(pendingIndex, 1)
        const previousState = {
          status: item.status,
          error: item.error,
          progress: item.progress,
          updatedAt: item.updatedAt
        }
        item.status = 'cancelled'
        item.error = ''
        item.progress = null
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueueOrRollback(() => {
          item.status = previousState.status
          item.error = previousState.error
          item.progress = previousState.progress
          item.updatedAt = previousState.updatedAt
          pendingDiscoveries.splice(pendingIndex, 0, rawId)
          if (wasBrowserAssisted) browserAssistedDiscoveries.add(rawId)
        })
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:remove',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
        const index = discoveryQueue.findIndex(
          (candidate) => candidate.id === rawId
        )
        if (index < 0)
          throw new Error('The selected discovery queue item no longer exists.')
        if (
          ['discovering', 'queued', 'downloading', 'paused'].includes(
            discoveryQueue[index].status
          )
        ) {
          throw new Error(
            'Finish or cancel the active work before removing this item.'
          )
        }
        const [removedItem] = discoveryQueue.splice(index, 1)
        await persistDiscoveryQueueOrRollback(() => {
          discoveryQueue.splice(index, 0, removedItem)
        })
        dirtyQueueChapterIds.delete(removedItem.id)
        await removeChapterArtifacts(dataDirectory(), removedItem.id).catch(
          (error: unknown) => {
            console.warn(
              `Stored data for removed queue item ${removedItem.id} could not be removed:`,
              errorMessage(error)
            )
          }
        )
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc('discovery-queue:clear', z.tuple([]), async () => {
      if (
        discoveryQueue.some((item) =>
          ['discovering', 'queued', 'downloading', 'paused'].includes(
            item.status
          )
        )
      ) {
        throw new Error(
          'Finish or cancel active work before clearing the queue.'
        )
      }
      const previousQueue = discoveryQueue
      discoveryQueue = []
      await persistDiscoveryQueueOrRollback(() => {
        discoveryQueue = previousQueue
      })
      for (const item of previousQueue) {
        dirtyQueueChapterIds.delete(item.id)
        await removeChapterArtifacts(dataDirectory(), item.id).catch(
          (error: unknown) => {
            console.warn(
              `Stored data for cleared queue item ${item.id} could not be removed:`,
              errorMessage(error)
            )
          }
        )
      }
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
  })

  handleValidatedResultIpc(
    'discovery-queue:clear-completed',
    z.tuple([]),
    async () => {
        const completedItems = discoveryQueue.filter(
          (item) => item.status === 'completed'
        )
        if (completedItems.length === 0) return { ok: true, value: undefined }
        const previousQueue = discoveryQueue
        discoveryQueue = discoveryQueue.filter(
          (item) => item.status !== 'completed'
        )
        await persistDiscoveryQueueOrRollback(() => {
          discoveryQueue = previousQueue
        })
        for (const item of completedItems) {
          dirtyQueueChapterIds.delete(item.id)
          await removeChapterArtifacts(dataDirectory(), item.id).catch(
            (error: unknown) => {
              console.warn(
                `Stored data for completed queue item ${item.id} could not be removed:`,
                errorMessage(error)
              )
            }
          )
        }
        notifyDiscoveryQueueChanged()
        return { ok: true, value: undefined }
    }
  )

  handleResultIpc(
    'discovery-queue:update-selection',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid chapter selection update.'
      ),
      z.custom<string[]>(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length <= MAX_SELECTED_CHAPTERS &&
          value.every((url) => typeof url === 'string'),
        'Invalid chapter selection update.'
      )
    ]),
    async (_event, id, rawSelectedUrls) => {
      const selectedUrls = new Set(
        rawSelectedUrls.map((url) => validateHttpUrl(url))
      )
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      if (
        !item ||
        (item.status !== 'needs-review' && item.status !== 'ready')
      ) {
        throw new Error(
          'The selected discovery queue item is no longer ready for review.'
        )
      }
      await ensureQueueItemChapters(item)
      const availableUrls = new Set(item.chapters.map((chapter) => chapter.url))
      if ([...selectedUrls].some((url) => !availableUrls.has(url))) {
        throw new Error(
          'The chapter selection no longer matches the saved discovery snapshot.'
        )
      }
      for (const chapter of item.chapters)
        chapter.selected = selectedUrls.has(chapter.url)
      markQueueItemChaptersDirty(item)
      item.status = 'ready'
      item.updatedAt = new Date().toISOString()
      await persistDiscoveryQueue()
      releaseQueueItemChapters(item)
      notifyDiscoveryQueueChanged()
    }
  )

  handleValidatedResultIpc(
    'download-queue:enqueue',
    z.tuple([
      z.custom<GenerateEpubInput>(
        (value): value is GenerateEpubInput =>
          typeof value === 'object' && value !== null,
        'Invalid EPUB request.'
      ),
      z.custom<string | undefined>(
        (value): value is string | undefined =>
          value === undefined || typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawInput, rawQueueItemId) => {
      let previousItem: DiscoveryQueueItem | null = null
      let createdItemId = ''
      let queueMutated = false
      let historyEntry: DownloadHistoryEntry | null = null
      try {
        const input = parseGenerateInput(rawInput)
        const settings = await readSettings(dataDirectory())
        let item =
          rawQueueItemId !== undefined
            ? discoveryQueue.find(
                (candidate) => candidate.id === rawQueueItemId
              )
            : undefined
        if (rawQueueItemId !== undefined && !item) {
          throw new Error('The selected discovery queue item no longer exists.')
        }
        if (item && item.status !== 'needs-review' && item.status !== 'ready') {
          throw new Error(
            'This novel is not ready to be queued for EPUB creation.'
          )
        }
        if (item) await ensureQueueItemChapters(item)

        const sourceUrl =
          input.sourceUrl || item?.sourceUrl || input.chapters[0].url
        const outputPath = expectedOutputPath(
          input.outputDirectory,
          input.title,
          input.filename ?? '',
          input.chapters
        )
        assertOutputPathAvailable(outputPath, item?.id ?? '')
        if (!item) {
          const libraryIndex = await readLibraryIndex(dataDirectory())
          const duplicate = discoveryQueue.find(
            (candidate) =>
              candidate.sourceUrl === sourceUrl &&
              [
                'needs-review',
                'ready',
                'queued',
                'downloading',
                'paused'
              ].includes(candidate.status)
          )
          if (duplicate)
            throw new Error(
              'A job for this novel or source is already active in the queue.'
            )
          const now = new Date().toISOString()
          const createdItem = createQueueItem({
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
              recommended: true
            })),
            discoveredAt: now,
            updatedAt: now
          })
          item = createdItem
          discoveryQueue.push(createdItem)
          createdItemId = createdItem.id
          queueMutated = true
          const recommendation = recommendArchiveCoverage(
            createdItem,
            libraryIndex?.files ?? []
          )
          createdItem.chapters = recommendation.chapters
          markQueueItemChaptersDirty(createdItem)
          createdItem.recommendationSummary = recommendation.summary
        } else {
          const existingItem = item
          await ensureQueueItemChapters(existingItem)
          previousItem = copyQueueItem(existingItem)
          if (
            input.sourceUrl &&
            validateHttpUrl(input.sourceUrl) !== existingItem.sourceUrl
          ) {
            throw new Error(
              'The source URL does not match the selected queue item.'
            )
          }
          const duplicate = discoveryQueue.find(
            (candidate) =>
              candidate.id !== existingItem.id &&
              candidate.sourceUrl === sourceUrl &&
              ['queued', 'downloading', 'paused'].includes(candidate.status)
          )
          if (duplicate && !existingItem.separateJob) {
            throw new Error(
              'A job for this novel or source is already active in the queue.'
            )
          }
          const selectedUrls = new Set(
            input.chapters.map((chapter) => chapter.url)
          )
          const availableUrls = new Set(
            existingItem.chapters.map((chapter) => chapter.url)
          )
          if ([...selectedUrls].some((url) => !availableUrls.has(url))) {
            throw new Error(
              'The selected chapters no longer match the saved discovery snapshot.'
            )
          }
          queueMutated = true
          for (const chapter of existingItem.chapters)
            chapter.selected = selectedUrls.has(chapter.url)
          markQueueItemChaptersDirty(existingItem)
          existingItem.title = input.title
          existingItem.author = input.author
          existingItem.description =
            input.description ?? existingItem.description
          existingItem.coverUrl = input.coverUrl ?? existingItem.coverUrl
          existingItem.alternativeNames = [
            ...(input.alternativeNames ?? existingItem.alternativeNames)
          ]
          existingItem.genres = [...(input.genres ?? existingItem.genres)]
          existingItem.source = input.source ?? existingItem.source
          existingItem.novelStatus =
            input.novelStatus ?? existingItem.novelStatus
          existingItem.trackerRow = input.trackerRow ?? existingItem.trackerRow
        }

        const queueItem = item
        if (!queueItem)
          throw new Error('The EPUB job could not be added to the queue.')
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
          alternativeNames: [
            ...(input.alternativeNames ?? queueItem.alternativeNames)
          ],
          genres: [...(input.genres ?? queueItem.genres)],
          source: input.source ?? queueItem.source,
          novelStatus: input.novelStatus ?? queueItem.novelStatus,
          language: input.language,
          filename: input.filename ?? '',
          sourceUrl,
          outputDirectory: input.outputDirectory,
          epubCss: settings.epubCss
        }
        queueItem.targetOutputPath = outputPath
        queueItem.queuedAt = now
        queueItem.completedChapterUrls = []
        queueItem.failedChapters = []
        queueItem.outputPath = ''
        queueItem.downloadHistoryId = historyEntry.id
        queueItem.repackageOnly = false
        queueItem.saveAvailableChaptersOnly = false
        queueItem.progress = {
          current: 0,
          total: input.chapters.length,
          message: 'Queued for download'
        }
        queueItem.error = ''
        queueItem.updatedAt = now

        await persistHistoryEntry(historyEntry)
        try {
          await persistDiscoveryQueue()
          releaseQueueItemChapters(queueItem)
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
        return {
          ok: true,
          value: { queueItemId: queueItem.id, historyId: historyEntry.id }
        }
      } catch (error) {
        if (queueMutated) {
          if (createdItemId) {
            discoveryQueue = discoveryQueue.filter(
              (candidate) => candidate.id !== createdItemId
            )
            dirtyQueueChapterIds.delete(createdItemId)
            await removeChapterArtifacts(dataDirectory(), createdItemId).catch(
              (cleanupError: unknown) => {
                console.warn(
                  `Rolled-back queue item ${createdItemId} artifacts could not be removed:`,
                  errorMessage(cleanupError)
                )
              }
            )
          } else if (previousItem) {
            const index = discoveryQueue.findIndex(
              (candidate) => candidate.id === previousItem?.id
            )
            if (index >= 0) {
              discoveryQueue[index] = previousItem
              markQueueItemChaptersDirty(previousItem)
            }
          }
          await persistDiscoveryQueue().catch((saveError: unknown) => {
            console.error(
              'Failed queue submission rollback could not be saved:',
              saveError
            )
          })
          notifyDiscoveryQueueChanged()
        }
        if (historyEntry?.status === 'queued') {
          historyEntry.status = 'failed'
          historyEntry.error = errorMessage(error)
          await persistHistoryEntry(historyEntry).catch(
            (saveError: unknown) => {
              console.error(
                'Failed queue submission history could not be saved:',
                saveError
              )
            }
          )
        }
        console.error('EPUB queueing failed:', error)
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  handleValidatedResultIpc(
    'download-queue:retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || !item.downloadOptions || !item.downloadHistoryId) {
          throw new Error('This item has no saved EPUB job to retry.')
        }
        if (
          item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled'
        ) {
          throw new Error(
            'Only failed, partially completed, or cancelled jobs can be retried.'
          )
        }
        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (
          !discoveryQueue.includes(item) ||
          (item.status !== 'failed' &&
            item.status !== 'partially-completed' &&
            item.status !== 'cancelled')
        ) {
          throw new Error('The EPUB job changed before it could be retried.')
        }
        await ensureQueueItemChapters(item)
        const selectedChapters = item.chapters.filter(
          (chapter) => chapter.selected
        )
        if (selectedChapters.length === 0)
          throw new Error(
            'Select at least one chapter before retrying this EPUB.'
          )
        const outputPath = expectedOutputPath(
          item.downloadOptions.outputDirectory,
          item.downloadOptions.title,
          item.downloadOptions.filename,
          selectedChapters
        )
        assertOutputPathAvailable(outputPath, item.id)
        item.targetOutputPath = outputPath
        item.status = 'queued'
        item.repackageOnly = false
        item.saveAvailableChaptersOnly = false
        item.queuedAt = new Date().toISOString()
        item.error = ''
        item.progress = {
          current: historyEntry.completedChapters,
          total: item.chapterSummary.selected,
          message: 'Queued for retry'
        }
        historyEntry.status = 'queued'
        historyEntry.error = ''
        await persistDownloadState(item, historyEntry)
        releaseQueueItemChapters(item)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:recover',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || item.status !== 'failed') {
          throw new Error('Only failed queue items can be recovered.')
        }

        if (!item.downloadOptions) {
          if (!item.sourceUrl)
            throw new Error('This item has no saved source URL to rediscover.')
          const previousError = item.error
          item.status = 'discovering'
          item.error = ''
          item.progress = null
          item.updatedAt = new Date().toISOString()
          await persistDiscoveryQueueOrRollback(() => {
            item.status = 'failed'
            item.error = previousError
          })
          notifyDiscoveryQueueChanged()
          pendingDiscoveries.push(item.id)
          pumpDiscoveryQueue()
          return { ok: true, value: undefined }
        }

        await ensureQueueItemChapters(item)
        const selectedChapters = item.chapters.filter(
          (chapter) => chapter.selected
        )
        if (selectedChapters.length === 0)
          throw new Error(
            'Select at least one chapter before retrying this EPUB.'
          )
        const outputPath = expectedOutputPath(
          item.downloadOptions.outputDirectory,
          item.downloadOptions.title,
          item.downloadOptions.filename,
          selectedChapters
        )
        assertOutputPathAvailable(outputPath, item.id)
        item.targetOutputPath = outputPath
        const history = await readDownloadHistory(dataDirectory())
        const ensuredHistory = await ensureQueueItemHistoryEntry(item, history)
        const historyEntry = ensuredHistory?.entry ?? null
        if (!historyEntry)
          throw new Error('The saved EPUB job details could not be restored.')

        item.status = 'queued'
        item.repackageOnly = false
        item.saveAvailableChaptersOnly = false
        item.queuedAt ||= new Date().toISOString()
        item.error = ''
        item.progress = {
          current: historyEntry.completedChapters,
          total: historyEntry.selectedChapterCount,
          message: 'Recovered and queued for download'
        }
        historyEntry.status = 'queued'
        historyEntry.error = ''
        historyEntry.updatedAt = new Date().toISOString()
        await persistDownloadState(item, historyEntry)
        releaseQueueItemChapters(item)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:repackage',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || !item.downloadOptions || !item.downloadHistoryId) {
          throw new Error('This item has no saved EPUB job to repackage.')
        }
        if (
          item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled'
        ) {
          throw new Error(
            'Only failed, partially completed, or cancelled jobs can be repackaged.'
          )
        }
        await ensureQueueItemChapters(item)
        const selectedChapters = item.chapters.filter(
          (chapter) => chapter.selected
        )
        if (selectedChapters.length === 0)
          throw new Error(
            'Select at least one saved chapter before repackaging.'
          )
        const outputPath = expectedOutputPath(
          item.downloadOptions.outputDirectory,
          item.downloadOptions.title,
          item.downloadOptions.filename,
          selectedChapters
        )
        assertOutputPathAvailable(outputPath, item.id)
        for (const chapter of selectedChapters) {
          const content = await readChapterArtifact(
            dataDirectory(),
            item.id,
            chapter.url
          )
          if (!content || content.url !== chapter.url) {
            throw new Error(
              `Saved chapter content is missing or invalid for "${chapter.title}".`
            )
          }
        }
        if (
          item.downloadOptions.coverUrl &&
          !(await readCoverArtifact(dataDirectory(), item.id))
        ) {
          throw new Error(
            'Saved cover content is missing; retry this EPUB online before repackaging.'
          )
        }

        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (
          !discoveryQueue.includes(item) ||
          (item.status !== 'failed' &&
            item.status !== 'partially-completed' &&
            item.status !== 'cancelled')
        ) {
          throw new Error('The EPUB job changed before it could be repackaged.')
        }

        item.repackageOnly = true
        item.saveAvailableChaptersOnly = false
        item.targetOutputPath = outputPath
        item.status = 'queued'
        item.queuedAt = new Date().toISOString()
        item.error = ''
        item.failedChapters = []
        item.completedChapterUrls = []
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
        releaseQueueItemChapters(item)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:save-available',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || !item.downloadOptions || !item.downloadHistoryId) {
          throw new Error('This item has no saved EPUB job to partially save.')
        }
        if (
          item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled'
        ) {
          throw new Error(
            'Only failed, partially completed, or cancelled jobs can save available chapters.'
          )
        }
        await ensureQueueItemChapters(item)
        const selectedChapters = item.chapters.filter(
          (chapter) => chapter.selected
        )
        if (selectedChapters.length === 0)
          throw new Error(
            'Select at least one saved chapter before saving available chapters.'
          )
        const outputPath = expectedOutputPath(
          item.downloadOptions.outputDirectory,
          item.downloadOptions.title,
          item.downloadOptions.filename,
          selectedChapters
        )
        assertOutputPathAvailable(outputPath, item.id)

        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (
          !discoveryQueue.includes(item) ||
          (item.status !== 'failed' &&
            item.status !== 'partially-completed' &&
            item.status !== 'cancelled')
        ) {
          throw new Error(
            'The EPUB job changed before available chapters could be saved.'
          )
        }

        item.repackageOnly = true
        item.saveAvailableChaptersOnly = true
        item.targetOutputPath = outputPath
        item.status = 'queued'
        item.queuedAt = new Date().toISOString()
        item.error = ''
        item.completedChapterUrls = []
        item.progress = {
          current: Math.min(
            historyEntry.completedChapters,
            selectedChapters.length
          ),
          total: selectedChapters.length,
          message: 'Queued to save available chapters'
        }
        historyEntry.status = 'queued'
        historyEntry.selectedChapterCount = selectedChapters.length
        historyEntry.completedChapters = Math.min(
          historyEntry.completedChapters,
          selectedChapters.length
        )
        historyEntry.error = ''
        await persistDownloadState(item, historyEntry)
        releaseQueueItemChapters(item)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:move',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid queue reorder request.'
      ),
      z.custom<'up' | 'down' | 'top' | 'bottom'>(
        (value): value is 'up' | 'down' | 'top' | 'bottom' =>
          value === 'up' ||
          value === 'down' ||
          value === 'top' ||
          value === 'bottom',
        'Invalid queue reorder request.'
      )
    ]),
    async (_event, rawId, rawDirection) => {
        const queuedItems = discoveryQueue
          .filter((item) => item.status === 'queued' && item.downloadOptions)
          .sort(
            (left, right) =>
              left.queuedAt.localeCompare(right.queuedAt) ||
              left.id.localeCompare(right.id)
          )
        const index = queuedItems.findIndex((item) => item.id === rawId)
        if (index < 0)
          throw new Error('Only queued EPUB jobs can be reordered.')
        const targetIndex =
          rawDirection === 'top'
            ? 0
            : rawDirection === 'bottom'
              ? queuedItems.length - 1
              : index + (rawDirection === 'up' ? -1 : 1)
        if (
          targetIndex < 0 ||
          targetIndex >= queuedItems.length ||
          targetIndex === index
        ) {
          return { ok: true, value: undefined }
        }
        const oldTimes = new Map(
          queuedItems.map((item) => [
            item.id,
            { queuedAt: item.queuedAt, updatedAt: item.updatedAt }
          ])
        )
        const movingItem = queuedItems[index]
        if (!movingItem)
          throw new Error(
            'The queue order changed before the job could be moved.'
          )
        queuedItems.splice(index, 1)
        queuedItems.splice(targetIndex, 0, movingItem)
        const now = Date.now()
        queuedItems.forEach((item, position) => {
          item.queuedAt = new Date(now + position).toISOString()
          item.updatedAt = new Date().toISOString()
        })
        await persistDiscoveryQueueOrRollback(() => {
          for (const item of queuedItems) {
            const previous = oldTimes.get(item.id)
            if (previous) {
              item.queuedAt = previous.queuedAt
              item.updatedAt = previous.updatedAt
            }
          }
        })
        notifyDiscoveryQueueChanged()
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:pause',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || !item.downloadHistoryId)
          throw new Error('The selected item has no active EPUB job.')
        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (
          !discoveryQueue.includes(item) ||
          (item.status !== 'queued' && item.status !== 'downloading')
        ) {
          throw new Error('The EPUB job changed before it could be paused.')
        }
        if (item.status === 'queued') {
          item.status = 'paused'
          item.progress = {
            ...(item.progress ?? { current: 0, total: 0, message: '' }),
            message: 'Paused'
          }
          historyEntry.status = 'paused'
          await persistDownloadState(item, historyEntry)
          return { ok: true, value: undefined }
        }
        const active = activeDownloads.get(item.id)
        if (item.status !== 'downloading' || !active)
          throw new Error('Only queued or downloading jobs can be paused.')
        active.requestedAction = 'pause'
        active.controller.abort()
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:resume',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || item.status !== 'paused' || !item.downloadHistoryId) {
          throw new Error('Only paused EPUB jobs can be resumed.')
        }
        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (!discoveryQueue.includes(item) || item.status !== 'paused') {
          throw new Error('The EPUB job changed before it could be resumed.')
        }
        item.status = 'queued'
        item.queuedAt = new Date().toISOString()
        item.error = ''
        item.progress = {
          current: historyEntry.completedChapters,
          total: item.chapterSummary.selected,
          message: 'Queued to resume'
        }
        historyEntry.status = 'queued'
        await persistDownloadState(item, historyEntry)
        void pumpDownloadQueue().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:cancel',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
        const item = discoveryQueue.find((candidate) => candidate.id === rawId)
        if (!item || !item.downloadHistoryId)
          throw new Error('The selected item has no active EPUB job.')
        const history = await readDownloadHistory(dataDirectory())
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (!historyEntry)
          throw new Error('The saved job history entry is missing.')
        if (
          !discoveryQueue.includes(item) ||
          (item.status !== 'queued' &&
            item.status !== 'paused' &&
            item.status !== 'downloading')
        ) {
          throw new Error('The EPUB job changed before it could be cancelled.')
        }
        if (item.status === 'queued' || item.status === 'paused') {
          item.status = 'cancelled'
          item.progress = {
            ...(item.progress ?? { current: 0, total: 0, message: '' }),
            message: 'Cancelled'
          }
          historyEntry.status = 'cancelled'
          await persistDownloadState(item, historyEntry)
          return { ok: true, value: undefined }
        }
        const active = activeDownloads.get(item.id)
        if (item.status !== 'downloading' || !active) {
          throw new Error(
            'Only queued, paused, or downloading jobs can be cancelled.'
          )
        }
        active.requestedAction = 'cancel'
        active.controller.abort()
        return { ok: true, value: undefined }
    }
  )

  handleTypedIpc('library:index-summary', z.tuple([]), async () => {
    const index = await readLibraryIndex(dataDirectory())
    return index ? summarizeLibraryIndex(index) : null
  })

  handleValidatedResultIpc(
    'library:novel-files',
    z.tuple([
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 300,
        'Invalid library novel selection.'
      )
    ]),
    async (_event, rawNovelKey) => {
        const index = await readLibraryIndex(dataDirectory())
        if (!index)
          throw new Error('Scan the library before viewing its files.')
        return {
          ok: true,
          value: index.files.filter(
            (file) => normalizeNovelTitleForGrouping(file.novelTitle) === rawNovelKey
          )
        }
    }
  )

  handleTypedIpc('library:operations', z.tuple([]), () =>
    copyLibraryOperations()
  )

  handleTypedIpc('library:index-backup-date', z.tuple([]), async () =>
    readLibraryIndexBackupDate(dataDirectory())
  )

  handleValidatedResultIpc(
    'library:restore-index-backup',
    z.tuple([]),
    async () => {
      if (shuttingDown) return { ok: false, error: 'NovelTracker is closing.' }
      if (
        activeLibraryScan ||
        libraryIndexRestoreActive ||
        libraryCorrectionActive
      ) {
        return {
          ok: false,
          error:
            'Wait for the current library operation to finish before restoring its backup.'
        }
      }
      libraryIndexRestoreActive = true
      try {
        const backup = await readLibraryIndexBackup(dataDirectory())
        if (!backup) throw new Error('No library index backup is available.')
        const settings = await readSettings(dataDirectory())
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        const [configuredRoot, backupRoot] = await Promise.all([
          realpath(settings.libraryRoot),
          realpath(backup.libraryRoot)
        ])
        if (!samePath(configuredRoot, backupRoot)) {
          throw new Error(
            'The saved index backup belongs to a different library root.'
          )
        }
        await writeLibraryIndex(dataDirectory(), backup)
        return { ok: true, value: summarizeLibraryIndex(backup) }
      } catch (error) {
        console.error('Library index backup restore failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        libraryIndexRestoreActive = false
      }
    }
  )

  handleValidatedResultIpc(
    'library:scan',
    z.tuple([
      z
        .custom<boolean>(
          (value): value is boolean => typeof value === 'boolean',
          'Invalid library scan option.'
        )
        .optional()
    ]),
    async (event, rawForceRebuild = false) => {
      if (shuttingDown) return { ok: false, error: 'NovelTracker is closing.' }
      if (
        activeLibraryScan ||
        libraryIndexRestoreActive ||
        libraryCorrectionActive
      ) {
        return {
          ok: false,
          error: 'Another library operation is already running.'
        }
      }
      const scan: ActiveLibraryScan = { worker: null, cancelRequested: false }
      activeLibraryScan = scan
      try {
        const settings = await readSettings(dataDirectory())
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        if (scan.cancelRequested)
          throw new OperationCancelledError('Library scan cancelled.')
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'libraryScanWorker.js'), {
            workerData: {
              libraryRoot: settings.libraryRoot,
              dataDirectory: dataDirectory(),
              forceRebuild: rawForceRebuild,
              scanOldFolder: settings.scanOldFolder,
              scanOldCompletedFolder: settings.scanOldCompletedFolder
            },
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        scan.worker = worker
        if (scan.cancelRequested) worker.postMessage({ type: 'cancel' })
        await runLibraryScanWorker(worker, (progress) => {
          sendToCurrentFrame(
            event.sender,
            event.senderFrame,
            'library:progress',
            progress
          )
        })
        const index = await readLibraryIndex(dataDirectory())
        if (!index)
          throw new Error('The library scan completed without saving an index.')
        return { ok: true, value: summarizeLibraryIndex(index) }
      } catch (error) {
        if (!scan.cancelRequested) console.error('Library scan failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        if (activeLibraryScan === scan) activeLibraryScan = null
      }
    }
  )

  handleTypedIpc('library:cancel-scan', z.tuple([]), () => {
    if (!activeLibraryScan) return
    activeLibraryScan.cancelRequested = true
    activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  })

  handleValidatedResultIpc(
    'library:correct-file',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library correction.'
      ),
      z.custom<LibraryFileCorrection>(
        (value): value is LibraryFileCorrection =>
          typeof value === 'object' && value !== null,
        'Invalid library correction.'
      )
    ]),
    async (_event, rawFileId, rawCorrection) => {
      if (shuttingDown) return { ok: false, error: 'NovelTracker is closing.' }
      if (
        activeLibraryScan ||
        libraryIndexRestoreActive ||
        libraryCorrectionActive
      ) {
        return {
          ok: false,
          error:
            'Wait for the current library operation to finish before correcting files.'
        }
      }
      libraryCorrectionActive = true
      try {
        const novelTitle = rawCorrection.novelTitle
        const chapterNumbers = rawCorrection.chapterNumbers
        if (
          novelTitle !== undefined &&
          (typeof novelTitle !== 'string' || novelTitle.length > 300)
        ) {
          throw new Error('Novel title must be 300 characters or fewer.')
        }
        if (
          chapterNumbers !== undefined &&
          (!Array.isArray(chapterNumbers) ||
            chapterNumbers.length > MAX_SELECTED_CHAPTERS ||
            chapterNumbers.some(
              (number) =>
                typeof number !== 'number' ||
                !Number.isFinite(number) ||
                number < 0
            ))
        ) {
          throw new Error(
            'Chapter corrections must be a list of non-negative numbers.'
          )
        }
        const index = await writeLibraryCorrection(dataDirectory(), rawFileId, {
          novelTitle,
          chapterNumbers
        } satisfies LibraryFileCorrection)
        return { ok: true, value: summarizeLibraryIndex(index) }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      } finally {
        libraryCorrectionActive = false
      }
    }
  )

  handleValidatedResultIpc(
    'library:merge-epubs',
    z.tuple([
      z.custom<string[]>(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length >= 2 &&
          value.length <= 20 &&
          value.every((id) => typeof id === 'string') &&
          new Set(value).size === value.length,
        'Select between 2 and 20 distinct EPUB files to combine.'
      ),
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 200,
        'Enter an EPUB filename of 200 characters or fewer.'
      )
    ]),
    async (event, rawFileIds, rawFilename) => {
      if (shuttingDown) return { ok: false, error: 'NovelTracker is closing.' }
      let operationId: string | null = null
      activeLibraryOperationHandlers += 1
      try {
        if (
          activeLibraryScan ||
          libraryIndexRestoreActive ||
          libraryCorrectionActive
        ) {
          throw new Error(
            'Wait for the current library operation to finish before combining EPUBs.'
          )
        }
        const index = await readLibraryIndex(dataDirectory())
        if (!index)
          throw new Error('Scan the library before combining existing EPUBs.')
        const settings = await readSettings(dataDirectory())
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        if (!settings.outputDirectory)
          throw new Error(
            'Go to Configuration and choose an EPUB output folder first.'
          )
        const outputDirectory = await realpath(settings.outputDirectory)
        if (!(await stat(outputDirectory)).isDirectory())
          throw new Error('The configured EPUB output path is not a folder.')
        const filename = sanitizeEpubFilename(rawFilename)
        const outputPath = resolve(outputDirectory, filename)
        const sourceFiles = rawFileIds.map((id) => {
          const file = index.files.find((candidate) => candidate.id === id)
          if (!file || file.format !== 'EPUB')
            throw new Error('A selected source EPUB is no longer indexed.')
          return file
        })
        const novelKeys = new Set(
          sourceFiles.map((file) => normalizeNovelTitleForMatching(file.novelTitle))
        )
        if (novelKeys.size !== 1)
          throw new Error('Select EPUBs belonging to the same indexed novel.')

        const [configuredRoot, libraryRoot] = await Promise.all([
          realpath(settings.libraryRoot),
          realpath(index.libraryRoot)
        ])
        if (!samePath(configuredRoot, libraryRoot)) {
          throw new Error(
            'The saved library index belongs to a different root. Scan the configured library first.'
          )
        }
        let totalSourceBytes = 0
        for (const file of sourceFiles) {
          const [currentPath, details] = await Promise.all([
            realpath(file.path),
            lstat(file.path)
          ])
          const relativePath = relative(libraryRoot, currentPath)
          if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath) ||
            details.isSymbolicLink() ||
            !details.isFile()
          ) {
            throw new Error(
              `The selected source file is outside the configured library: ${file.filename}`
            )
          }
          if (
            details.size !== file.size ||
            details.mtime.toISOString() !== file.modifiedAt
          ) {
            throw new Error(
              `The source file changed since the last scan: ${file.filename}. Rescan and try again.`
            )
          }
          totalSourceBytes += details.size
          if (totalSourceBytes > MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES) {
            throw new Error(
              `Selected EPUBs exceed the ${MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES / (1024 * 1024)} MB combined input limit.`
            )
          }
        }
        if (sourceFiles.some((file) => samePath(file.path, outputPath))) {
          throw new Error(
            'The merged EPUB cannot overwrite one of its source files.'
          )
        }
        try {
          const target = await lstat(outputPath)
          if (target.isSymbolicLink() || !target.isFile()) {
            throw new Error(
              'The output filename is already used by a folder or symbolic link.'
            )
          }
          if (!mainWindow)
            throw new Error(
              'The app window is not available to confirm replacing the existing EPUB.'
            )
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
          if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
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
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'epubMergeWorker.js'), {
            workerData: input,
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        const result = await runEpubMergeWorker(worker, (progress) => {
          void updateLibraryOperation(
            trackedOperationId,
            {
              progress: progress.percentage,
              message: progress.message,
              status: progress.stage === 'failed' ? 'failed' : 'running',
              error: progress.stage === 'failed' ? progress.message : ''
            },
            progress.stage === 'failed'
          )
          sendToCurrentFrame(
            event.sender,
            event.senderFrame,
            'library:merge-progress',
            progress
          )
        })
        await updateLibraryOperation(
          operationId,
          {
            status: 'completed',
            outputPath: result.outputPath,
            progress: 100,
            message: 'Merged EPUB created and validated.',
            error: ''
          },
          true
        )
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(
            operationId,
            {
              status: 'failed',
              message: 'EPUB merge failed.',
              error: errorMessage(error)
            },
            true
          )
        }
        console.error('Existing EPUB merge failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        activeLibraryOperationHandlers -= 1
      }
    }
  )

  handleValidatedResultIpc(
    'library:repair-epub',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Select an indexed library file.'
      )
    ]),
    async (_event, rawFileId) => {
      if (shuttingDown) return { ok: false, error: 'NovelTracker is closing.' }
      let operationId: string | null = null
      activeLibraryOperationHandlers += 1
      try {
        const inputPath = await getIndexedLibraryFile(rawFileId)
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
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'epubRepairWorker.js'), {
            workerData: { inputPath, outputPath },
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        const result = await runEpubRepairWorker(worker, (progress) => {
          void updateLibraryOperation(trackedOperationId, {
            progress: progress.percentage,
            message: progress.message
          })
        })
        const summary =
          result.repairedWebpImages > 0
            ? `Converted ${result.repairedWebpImages.toLocaleString()} WebP image(s) to JPEG.`
            : 'No WebP images needed conversion.'
        const coverSummary = result.upscaledCover
          ? ' Upscaled the undersized cover to Kindle minimum dimensions.'
          : ''
        const mimetypeSummary = result.fixedMimetype
          ? ' Corrected EPUB mimetype and ZIP ordering.'
          : ''
        await updateLibraryOperation(
          operationId,
          {
            status: 'completed',
            outputPath: result.outputPath,
            progress: 100,
            message: `${summary}${coverSummary}${mimetypeSummary}`,
            error: ''
          },
          true
        )
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(
            operationId,
            {
              status: 'failed',
              message: 'EPUB check and repair failed.',
              error: errorMessage(error)
            },
            true
          )
        }
        console.error('EPUB repair failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        activeLibraryOperationHandlers -= 1
      }
    }
  )

  handleValidatedResultIpc(
    'library:open-path',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library path request.'
      ),
      z.custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'Invalid library path request.'
      )
    ]),
    async (_event, rawPath, reveal) => {
        const settings = await readSettings(dataDirectory())
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        const root = await realpath(settings.libraryRoot)
        const target = await realpath(rawPath)
        const relativePath = relative(root, target)
        if (
          !relativePath ||
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error(
            'The requested path is outside the configured library.'
          )
        }
        const targetDetails = await stat(target)
        if (
          !targetDetails.isDirectory() &&
          (!targetDetails.isFile() ||
            !['.epub', '.azw3'].includes(extname(target).toLowerCase()))
        ) {
          throw new Error(
            'Only folders and EPUB or AZW3 files can be opened from the library.'
          )
        }
        if (reveal) shell.showItemInFolder(target)
        else {
          const error = await shell.openPath(target)
          if (error) throw new Error(error)
        }
        return { ok: true, value: undefined }
    }
  )
}

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return
    initializeLocalLogger(dataDirectory(), app.getVersion())
    registerProcessErrorHandlers()
    await migrateSettings(dataDirectory())
    if (app.isPackaged) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.resourcesPath,
        'playwright-browsers'
      )
    }
    if (process.platform === 'win32')
      app.setAppUserModelId('com.brightfyre.noveltracker')
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
    const savedQueue = await readDiscoveryQueue(dataDirectory())
    discoveryQueue = savedQueue.map(hydrateQueueItem)
    let queueStorageMigrationNeeded = savedQueue.some((saved, index) => {
      const normalized = discoveryQueue[index]
      return (
        hasUnknownProperties(saved, normalized) ||
        hasUnknownProperties(saved.chapterSummary, normalized.chapterSummary) ||
        (saved.chapters ?? []).some((chapter, chapterIndex) => {
          const normalizedChapter = normalized.chapters[chapterIndex]
          return (
            normalizedChapter !== undefined &&
            hasUnknownProperties(chapter, normalizedChapter)
          )
        })
      )
    })
    for (const item of discoveryQueue) {
      if (item.chapters.length > 0) {
        if (item.status === 'completed') releaseQueueItemChapters(item)
        else markQueueItemChaptersDirty(item)
        queueStorageMigrationNeeded = true
      }
      if (
        item.downloadOptions &&
        item.status !== 'completed' &&
        !item.targetOutputPath &&
        item.chapters.length > 0
      ) {
        const selectedChapters = item.chapters.filter(
          (chapter) => chapter.selected
        )
        item.targetOutputPath = expectedOutputPath(
          item.downloadOptions.outputDirectory,
          item.downloadOptions.title,
          item.downloadOptions.filename,
          selectedChapters
        )
        queueStorageMigrationNeeded = true
      }
      if (item.completedChapterUrls.length > 0) {
        item.completedChapterUrls = []
        queueStorageMigrationNeeded = true
      }
    }
    if (queueStorageMigrationNeeded) await persistDiscoveryQueue()
    for (const item of discoveryQueue) releaseQueueItemChapters(item)
    const history = await readDownloadHistory(dataDirectory())
    let interruptedDownloads = false
    for (const item of discoveryQueue) {
      if (
        !item.downloadOptions ||
        history.some((entry) => entry.id === item.downloadHistoryId)
      )
        continue
      const restored = await ensureQueueItemHistoryEntry(item, history)
      if (!restored) continue
      const restoredHistory = restored.entry
      interruptedDownloads = true
      if (
        item.status === 'failed' &&
        restored.created
      ) {
        item.status = 'queued'
        item.error = ''
        item.queuedAt ||= item.updatedAt || new Date().toISOString()
        item.progress = {
          current: restoredHistory.completedChapters,
          total: restoredHistory.selectedChapterCount,
          message: 'Recovered saved download history'
        }
        restoredHistory.status = 'queued'
        restoredHistory.error = ''
        restoredHistory.updatedAt = new Date().toISOString()
        await persistHistoryEntry(restoredHistory)
      }
    }
    for (const item of discoveryQueue) {
      const historyEntry = history.find(
        (entry) => entry.id === item.downloadHistoryId
      )
      if (historyEntry && item.downloadOptions) {
        if (
          item.status === 'completed' &&
          historyEntry.status !== 'completed'
        ) {
          historyEntry.status = 'completed'
          historyEntry.outputPath = item.outputPath
          historyEntry.error = ''
          historyEntry.updatedAt = item.updatedAt
          interruptedDownloads = true
        } else if (
          item.status === 'partially-completed' &&
          historyEntry.status !== 'partially-completed'
        ) {
          historyEntry.status = 'partially-completed'
          historyEntry.error = item.error
          historyEntry.updatedAt = item.updatedAt
          interruptedDownloads = true
        } else if (
          item.status === 'failed' &&
          historyEntry.status !== 'failed'
        ) {
          historyEntry.status = 'failed'
          historyEntry.error = item.error
          historyEntry.updatedAt = item.updatedAt
          interruptedDownloads = true
        } else if (
          item.status === 'cancelled' &&
          historyEntry.status !== 'cancelled'
        ) {
          historyEntry.status = 'cancelled'
          historyEntry.error = ''
          historyEntry.updatedAt = item.updatedAt
          interruptedDownloads = true
        } else if (
          item.status === 'paused' &&
          historyEntry.status !== 'paused'
        ) {
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
        item.recoveryReason =
          item.downloadOptions && !historyEntry ? 'missing-history' : undefined
        item.updatedAt = new Date().toISOString()
        interruptedDownloads = true
        continue
      }
      if (
        item.status === 'downloading' ||
        historyEntry.status === 'running' ||
        historyEntry.status === 'interrupted'
      ) {
        item.status = 'queued'
        item.error = ''
        item.progress = {
          current: historyEntry.completedChapters,
          total: item.chapterSummary.selected,
          message: 'Resuming after app restart'
        }
        historyEntry.status = 'queued'
        historyEntry.error = ''
        historyEntry.updatedAt = new Date().toISOString()
        interruptedDownloads = true
      }
    }
    if (interruptedDownloads) {
      await persistDiscoveryQueue()
      for (const item of discoveryQueue) {
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
        if (historyEntry) await persistHistoryEntry(historyEntry)
      }
    }
    let interruptedDiscoveries = false
    for (const item of discoveryQueue) {
      if (item.status === 'discovering') {
        item.status = 'failed'
        item.error =
          'Discovery was interrupted when the app closed. Retry to refresh the chapter list.'
        item.updatedAt = new Date().toISOString()
        interruptedDiscoveries = true
        const historyEntry = history.find(
          (entry) => entry.id === item.downloadHistoryId
        )
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
    const storageRecoveryWarnings = takeStorageRecoveryWarnings()
    maxActiveDiscoveries = settings.maxSimultaneousDiscoveries
    setDomainRequestDelays(settings.domainRequestDelays)
    if (settings.outputDirectory) {
      try {
        const directory = await realpath(settings.outputDirectory)
        if ((await stat(directory)).isDirectory())
          approvedOutputDirectories.add(directory)
      } catch (error) {
        console.warn(
          'Saved EPUB output folder is unavailable:',
          errorMessage(error)
        )
      }
    }
    await createWindow()
    if (storageRecoveryWarnings.length > 0) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Saved data was recovered',
        message:
          'Some saved data could not be used. NovelTracker started with safe defaults.',
        detail: storageRecoveryWarnings.join('\n')
      })
    }
    void pumpDownloadQueue().catch((error: unknown) => {
      console.error('Download queue scheduler failed:', error)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          console.error('Failed to recreate application window:', error)
        })
      }
    })
  })
  .catch((error: unknown) => {
    console.error('Application startup failed:', error)
    dialog.showErrorBox('NovelTracker could not start', errorMessage(error))
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function sweepNovelTrackerTemporaryFiles(): Promise<void> {
  const directories = new Set([
    dataDirectory(),
    ...approvedOutputDirectories,
    ...libraryOperations
      .filter((operation) => operation.outputPath)
      .map((operation) => dirname(operation.outputPath))
  ])
  for (const directory of directories) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^\.novel-tracker-[\da-f-]+\.tmp$/i.test(entry.name)
      )
        continue
      const path = join(directory, entry.name)
      try {
        await rm(path, { force: true })
      } catch (error) {
        console.warn(
          `Temporary file ${path} could not be removed during shutdown:`,
          error
        )
      }
    }
  }
}

async function drainApplicationWork(): Promise<void> {
  shuttingDown = true
  pendingDiscoveries.length = 0
  browserAssistedDiscoveries.clear()
  if (discoveryQueueNotificationTimer) {
    clearTimeout(discoveryQueueNotificationTimer)
    discoveryQueueNotificationTimer = null
  }
  if (libraryOperationFlushTimer) {
    clearTimeout(libraryOperationFlushTimer)
    libraryOperationFlushTimer = null
  }

  for (const controller of activeQueueDiscoveries.values()) controller.abort()
  for (const controller of activeBrowserDiscoveries.values()) controller.abort()
  for (const active of activeDownloads.values()) {
    if (active.requestedAction === 'none') active.requestedAction = 'shutdown'
    active.controller.abort()
  }
  if (activeLibraryScan) {
    activeLibraryScan.cancelRequested = true
    activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  }

  const workerResults = await Promise.allSettled(
    [...activeLibraryWorkers].map((worker) => worker.terminate())
  )
  for (const result of workerResults) {
    if (result.status === 'rejected')
      console.error(
        'A worker could not be terminated during shutdown:',
        result.reason
      )
  }

  const deadline = Date.now() + 15_000
  while (
    (downloadPumpRunning ||
      activeDownloads.size > 0 ||
      activeBackgroundTasks.size > 0 ||
      activeQueueDiscoveries.size > 0 ||
      activeBrowserDiscoveries.size > 0 ||
      activeLibraryScan !== null ||
      activeLibraryWorkers.size > 0 ||
      activeLibraryOperationHandlers > 0 ||
      libraryIndexRestoreActive ||
      libraryCorrectionActive) &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  if (
    downloadPumpRunning ||
    activeDownloads.size > 0 ||
    activeBackgroundTasks.size > 0 ||
    activeQueueDiscoveries.size > 0 ||
    activeBrowserDiscoveries.size > 0 ||
    activeLibraryScan !== null ||
    activeLibraryWorkers.size > 0 ||
    activeLibraryOperationHandlers > 0 ||
    libraryIndexRestoreActive ||
    libraryCorrectionActive
  ) {
    console.warn(
      'Shutdown continued after the work-drain deadline; some operations did not settle.'
    )
  }

  try {
    await closeBrowserSession()
  } catch (error) {
    console.error('The browser session could not be closed cleanly:', error)
  }

  await Promise.all([
    settingsUpdateQueue.drain(),
    discoveryQueueWrites.drain(),
    historyWrites.drain(),
    libraryOperationWrites.drain()
  ])
  await flushLibraryOperations()
  if (discoveryQueueNotificationTimer) {
    clearTimeout(discoveryQueueNotificationTimer)
    discoveryQueueNotificationTimer = null
  }
  try {
    await sweepNovelTrackerTemporaryFiles()
  } catch (error) {
    console.error(
      'NovelTracker temporary files could not be swept during shutdown:',
      error
    )
  }
  await flushLocalLogger()
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = drainApplicationWork()
    .catch((error: unknown) => {
      console.error('Application shutdown did not complete cleanly:', error)
    })
    .finally(() => {
      shutdownComplete = true
      app.quit()
    })
})
