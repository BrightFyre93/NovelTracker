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
  ChapterLink,
  DiscoveryQueueInput,
  DiscoveryQueueUpdate,
  DomainRequestDelayPreference,
  DownloadHistoryEntry,
  EpubMergeProgress,
  GenerateEpubInput,
  LibraryOperation,
  Result,
  SettingsUpdatePatch,
  SiteExtractionPreference
} from '../shared/contracts'
import {
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_DOWNLOAD_RETRY_ATTEMPTS,
  MAX_HTTP_CONNECT_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
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
  MIN_DOWNLOAD_RETRY_ATTEMPTS,
  MIN_HTTP_CONNECT_TIMEOUT_MS,
  MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DISCOVERIES,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../shared/constants'
import { siteExtractionModeForUrl } from '../shared/siteExtractionPreferences'
import {
  clearBrowserSession,
  closeBrowserSession,
  openVerificationBrowser,
  readBrowserPage
} from './services/browserService'
import {
  readCoverArtifact,
  readChapterArtifact,
  readArchivedDownloadHistory,
  readSettings,
  migrateSettings,
  removeChapterArtifacts,
  writeLibraryOperations,
} from './services/localStore'
import { readTrackerCsv } from './services/trackerCsv'
import {
  discoverChapters,
  discoverChaptersUsingPageLoader,
  setDomainRequestDelays,
  setHttpTimeouts,
  validateHttpUrl
} from './services/scraper'
import { SerialQueue } from './services/serialQueue'
import { samePath } from './services/pathUtils'
import { runWorker } from './services/workerRunner'
import { SettingsService } from './services/settingsService'
import {
  copyQueueItem,
  createQueueItem
} from './services/queueItem'
import { projectDownloadHistory } from './services/queue/jobHistory'
import { recommendArchiveCoverage } from '../shared/archiveRecommendation'
import {
  OperationCancelledError,
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
import {
  searchLibraryFileSummaries,
  searchLibraryNovelSummaries,
  summarizeLibraryIndex,
  summarizeLibraryIndexOverview
} from '../shared/libraryIndexSummary'
import { resolveChapterSelection } from '../shared/chapterSelection'
import {
  normalizeNovelTitleForGrouping,
  normalizeNovelTitleForMatching
} from '../shared/novelTitle'
import { z } from 'zod'
import { sanitizeEpubFilename } from '../shared/epubFilename'
import { flushLocalLogger, initializeLocalLogger } from './services/localLogger'
import {
  assertOutputPathAvailable,
  expectedOutputPath,
  createQueueHelpers,
  hydrateQueueItem,
  updateQueueChapterSummary
} from './services/queue/helpers'
import { recoverStartupState } from './app/startupRecovery'
import { createQueueRuntime } from './services/queue/runtime'
import type { ActiveDownload } from './services/queue/runtime'
import type {
  EpubPackagingInput,
  EpubPackagingProgress,
  EpubPackagingResult
} from './services/epubPackaging'
import { createJsonQueueRepository } from './services/queue/repository'
import { QueueStore } from './services/queue/store'
import { createJsonLibraryIndexRepository } from './services/library/libraryIndexRepository'
import { transitionQueueItem } from './services/queue/queueStateMachine'
import { registerSettingsIpcHandlers } from './ipc/settings'
import { registerQueueIpcHandlers } from './ipc/queue'
import { registerLibraryIpcHandlers } from './ipc/library'
import { registerBrowserIpcHandlers } from './ipc/browser'
import { registerDialogsIpcHandlers } from './ipc/dialogs'

let mainWindow: BrowserWindow | null = null
let mainWindowReady = false
let focusRequestedBeforeWindowReady = false
const approvedOutputDirectories = new Set<string>()
let discoveryQueueNotificationTimer: ReturnType<typeof setTimeout> | null = null
let libraryOperationFlushTimer: ReturnType<typeof setTimeout> | null = null
const libraryOperationWrites = new SerialQueue()
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
let discoveryQueueRevision = 0
const discoveryQueueBroadcastState = new Map<string, string>()
const reservedOutputPaths = new Set<string>()
const browserAssistedDiscoveries = new Set<string>()
const activeBrowserDiscoveries = new Map<string, AbortController>()
const activeQueueDiscoveries = new Map<string, AbortController>()
const activeDownloads = new Map<string, ActiveDownload>()
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

function packageEpubInWorker(
  input: EpubPackagingInput,
  signal: AbortSignal,
  onProgress: (progress: EpubPackagingProgress) => void
): Promise<EpubPackagingResult> {
  const worker = new Worker(join(__dirname, 'epubPackageWorker.js'), {
    workerData: input,
    resourceLimits: { maxOldGenerationSizeMb: 1024 }
  })
  return runWorker<EpubMergeProgress, EpubPackagingResult>(worker, {
    workerName: 'EPUB packaging',
    missingResultMessage: 'EPUB packaging worker exited without creating an EPUB.',
    onProgress,
    signal,
    onCancel: () => worker.postMessage({ type: 'cancel' })
  })
}

const queueRepository = createJsonQueueRepository(dataDirectory)
const queueStore = new QueueStore(queueRepository, hasUnknownProperties)
const discoveryQueue = queueStore.items
const libraryIndexRepository = createJsonLibraryIndexRepository(dataDirectory)
const queueHelpers = createQueueHelpers({
  dataDirectory,
  queueStore,
  notifyDownloadHistoryChanged
})
const {
  copyDiscoveryQueue,
  markQueueItemChaptersDirty,
  withChapters,
  mutateItem,
  clearDirtyChapterData,
  releaseQueueItemChapters,
  persistDiscoveryQueue,
  persistDiscoveryQueueOrRollback,
  archiveRemovedJobs
} = queueHelpers

const settingsService = new SettingsService(dataDirectory)
const queueRuntime = createQueueRuntime({
  discoveryQueue,
  browserAssistedDiscoveries,
  activeBrowserDiscoveries,
  activeQueueDiscoveries,
  activeDownloads,
  reservedOutputPaths,
  dataDirectory,
  settingsService,
  libraryIndexRepository,
  packageEpub: packageEpubInWorker,
  isShuttingDown: () => shuttingDown,
  queueHelpers,
  notifyDiscoveryQueueChanged,
  trackBackgroundTask,
  errorMessage
})
const {
  persistDownloadState,
  discoveryScheduler,
  downloadScheduler
} = queueRuntime

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

const settingsUpdatePatchSchema: z.ZodType<SettingsUpdatePatch> = z
  .object({
    epubCss: z
      .custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= MAX_EPUB_CSS_LENGTH,
        `EPUB CSS must be text of at most ${MAX_EPUB_CSS_LENGTH.toLocaleString()} characters.`
      )
      .optional(),
    appTheme: z
      .custom<AppSettings['appTheme']>(
        (value): value is AppSettings['appTheme'] =>
          value === 'light' || value === 'dark',
        'The app theme must be light or dark.'
      )
      .optional(),
    discoveryFreshnessHours: integerInRange(
      MIN_DISCOVERY_FRESHNESS_HOURS,
      MAX_DISCOVERY_FRESHNESS_HOURS,
      `The discovery freshness window must be a whole number from ${MIN_DISCOVERY_FRESHNESS_HOURS} to ${MAX_DISCOVERY_FRESHNESS_HOURS} hours.`
    ).optional(),
    maxSimultaneousDownloads: integerInRange(
      MIN_SIMULTANEOUS_DOWNLOADS,
      MAX_SIMULTANEOUS_DOWNLOADS,
      `Maximum simultaneous downloads must be a whole number from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
    ).optional(),
    maxDownloadRetryAttempts: integerInRange(
      MIN_DOWNLOAD_RETRY_ATTEMPTS,
      MAX_DOWNLOAD_RETRY_ATTEMPTS,
      `Maximum download attempts must be a whole number from ${MIN_DOWNLOAD_RETRY_ATTEMPTS} to ${MAX_DOWNLOAD_RETRY_ATTEMPTS}.`
    ).optional(),
    httpConnectTimeoutMs: integerInRange(
      MIN_HTTP_CONNECT_TIMEOUT_MS,
      MAX_HTTP_CONNECT_TIMEOUT_MS,
      `The connection timeout must be a whole number from ${MIN_HTTP_CONNECT_TIMEOUT_MS} to ${MAX_HTTP_CONNECT_TIMEOUT_MS} milliseconds.`
    ).optional(),
    httpResponseReadTimeoutMs: integerInRange(
      MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
      MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
      `The response timeout must be a whole number from ${MIN_HTTP_RESPONSE_READ_TIMEOUT_MS} to ${MAX_HTTP_RESPONSE_READ_TIMEOUT_MS} milliseconds.`
    ).optional(),
    maxSimultaneousDiscoveries: integerInRange(
      MIN_SIMULTANEOUS_DISCOVERIES,
      MAX_SIMULTANEOUS_DISCOVERIES,
      `Maximum simultaneous discoveries must be a whole number from ${MIN_SIMULTANEOUS_DISCOVERIES} to ${MAX_SIMULTANEOUS_DISCOVERIES}.`
    ).optional(),
    maxSimultaneousChaptersPerNovel: integerInRange(
      MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
      MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
      `Maximum chapter requests per novel must be a whole number from ${MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL} to ${MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL}.`
    ).optional(),
    domainRequestDelays: z
      .custom<DomainRequestDelayPreference[]>(
        (value): value is DomainRequestDelayPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_DOMAIN_REQUEST_PREFERENCES,
        `Configure no more than ${MAX_DOMAIN_REQUEST_PREFERENCES} domain request delays.`
      )
      .optional(),
    siteExtractionPreferences: z
      .custom<SiteExtractionPreference[]>(
        (value): value is SiteExtractionPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_SITE_EXTRACTION_PREFERENCES,
        `Configure no more than ${MAX_SITE_EXTRACTION_PREFERENCES} site extraction preferences.`
      )
      .optional(),
    scanOldFolder: z
      .custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old-folder scan option must be enabled or disabled.'
      )
      .optional(),
    scanOldCompletedFolder: z
      .custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old Completed-folder scan option must be enabled or disabled.'
      )
      .optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one setting to update.'
  })

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



function hasUnknownProperties(saved: object, normalized: object): boolean {
  const normalizedKeys = new Set(Object.keys(normalized))
  return Object.keys(saved).some((key) => !normalizedKeys.has(key))
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
    libraryIndexRepository.read(),
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
    const currentState = new Map(
      items.map((item) => [item.id, JSON.stringify(item)])
    )
    const upserted = items.filter(
      (item) => discoveryQueueBroadcastState.get(item.id) !== currentState.get(item.id)
    )
    const removedIds = [...discoveryQueueBroadcastState.keys()].filter(
      (id) => !currentState.has(id)
    )
    discoveryQueueBroadcastState.clear()
    for (const [id, snapshot] of currentState)
      discoveryQueueBroadcastState.set(id, snapshot)
    if (upserted.length === 0 && removedIds.length === 0) return
    const update: DiscoveryQueueUpdate = {
      revision: ++discoveryQueueRevision,
      upserted,
      removedIds,
      order: items.map((item) => item.id)
    }
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (webContents.isDestroyed() || webContents.isLoadingMainFrame())
        continue
      const frame = webContents.mainFrame
      if (frame.isDestroyed()) continue
      sendIpcEvent(frame, 'discovery-queue:update', update)
    }
  }, 1000)
}

function notifyDownloadHistoryChanged(
  history: DownloadHistoryEntry[]
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const webContents = window.webContents
    if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) continue
    const frame = webContents.mainFrame
    if (frame.isDestroyed()) continue
    sendIpcEvent(frame, 'download-history:update', history)
  }
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

export const ipcContext = {
  MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
  MAX_SELECTED_CHAPTERS,
  OperationCancelledError,
  Worker,
  activeBrowserDiscoveries,
  activeDownloads,
  activeQueueDiscoveries,
  approvedOutputDirectories,
  archiveRemovedJobs,
  assertOutputPathAvailable,
  browserAssistedDiscoveries,
  clearBrowserSession,
  clearDirtyChapterData,
  copyDiscoveryQueue,
  copyLibraryOperations,
  copyQueueItem,
  createQueueItem,
  dataDirectory,
  dialog,
  discoverChapters,
  discoverChaptersUsingPageLoader,
  discoveryQueue,
  discoveryScheduler,
  downloadScheduler,
  errorMessage,
  expectedOutputPath,
  extname,
  getIndexedLibraryFile,
  getSiblingOutputPath,
  handleResultIpc,
  handleTypedIpc,
  handleValidatedResultIpc,
  isAbsolute,
  isNodeError,
  join,
  libraryIndexRepository,
  lstat,
  markQueueItemChaptersDirty,
  mutateItem,
  normalizeNovelTitleForGrouping,
  normalizeNovelTitleForMatching,
  notifyDiscoveryQueueChanged,
  openVerificationBrowser,
  parseDiscoveryQueueInputs,
  parseGenerateInput,
  persistDiscoveryQueue,
  persistDiscoveryQueueOrRollback,
  persistDownloadState,
  projectDownloadHistory,
  queueStore,
  randomUUID,
  readArchivedDownloadHistory,
  readBrowserPage,
  readChapterArtifact,
  readCoverArtifact,
  readSettings,
  readTrackerCsv,
  realpath,
  recommendArchiveCoverage,
  relative,
  removeChapterArtifacts,
  resolve,
  resolveChapterSelection,
  runWorker,
  samePath,
  sanitizeEpubFilename,
  searchLibraryFileSummaries,
  searchLibraryNovelSummaries,
  sendToCurrentFrame,
  sep,
  settingsService,
  settingsUpdatePatchSchema,
  shell,
  siteExtractionModeForUrl,
  startLibraryOperation,
  stat,
  summarizeLibraryIndex,
  summarizeLibraryIndexOverview,
  trackLibraryWorker,
  transitionQueueItem,
  updateLibraryOperation,
  updateQueueChapterSummary,
  withChapters,
  z,
  get mainWindow(): BrowserWindow | null { return mainWindow },
  set mainWindow(value: BrowserWindow | null) { mainWindow = value },
  get activeLibraryScan(): ActiveLibraryScan | null { return activeLibraryScan },
  set activeLibraryScan(value: ActiveLibraryScan | null) { activeLibraryScan = value },
  get libraryIndexRestoreActive(): boolean { return libraryIndexRestoreActive },
  set libraryIndexRestoreActive(value: boolean) { libraryIndexRestoreActive = value },
  get libraryCorrectionActive(): boolean { return libraryCorrectionActive },
  set libraryCorrectionActive(value: boolean) { libraryCorrectionActive = value },
  get activeLibraryOperationHandlers(): number { return activeLibraryOperationHandlers },
  set activeLibraryOperationHandlers(value: number) { activeLibraryOperationHandlers = value },
  get shuttingDown(): boolean { return shuttingDown },
  set shuttingDown(value: boolean) { shuttingDown = value },
  get discoveryQueueRevision(): number { return discoveryQueueRevision },
  set discoveryQueueRevision(value: number) { discoveryQueueRevision = value },
}

function registerIpcHandlers(): void {
  registerSettingsIpcHandlers(ipcContext)
  registerQueueIpcHandlers(ipcContext)
  registerLibraryIpcHandlers(ipcContext)
  registerBrowserIpcHandlers(ipcContext)
  registerDialogsIpcHandlers(ipcContext)
}

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return
    initializeLocalLogger(dataDirectory(), app.getVersion())
    registerProcessErrorHandlers()
    await migrateSettings(dataDirectory())
    await settingsService.initialize()
    settingsService.onDidChange((current, patch) => {
      if ('domainRequestDelays' in patch)
        setDomainRequestDelays(current.domainRequestDelays)
      if ('httpConnectTimeoutMs' in patch || 'httpResponseReadTimeoutMs' in patch) {
        setHttpTimeouts(
          current.httpConnectTimeoutMs,
          current.httpResponseReadTimeoutMs
        )
      }
      if (
        'maxSimultaneousDownloads' in patch ||
        'maxSimultaneousChaptersPerNovel' in patch ||
        'discoveryFreshnessHours' in patch
      ) {
        void downloadScheduler.request().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
      }
      if ('maxSimultaneousDiscoveries' in patch)
        discoveryScheduler.schedule()
    })
    if (app.isPackaged) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.resourcesPath,
        'playwright-browsers'
      )
    }
    if (process.platform === 'win32')
      app.setAppUserModelId('com.brightfyre.noveltracker')
    registerIpcHandlers()
    const { settings, storageRecoveryWarnings } = await recoverStartupState({
      dataDirectory: dataDirectory(),
      setLibraryOperations: (operations) => {
        libraryOperations = operations
      },
      flushLibraryOperations,
      setDiscoveryQueue: (items) => {
        queueStore.replace(items)
      },
      queueRepository,
      hydrateQueueItem,
      hasUnknownProperties,
      releaseQueueItemChapters,
      markQueueItemChaptersDirty,
      expectedOutputPath,
      persistDiscoveryQueue,
      approvedOutputDirectories,
      errorMessage
    })
    setDomainRequestDelays(settings.domainRequestDelays)
    setHttpTimeouts(settings.httpConnectTimeoutMs, settings.httpResponseReadTimeoutMs)
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
    void downloadScheduler.request().catch((error: unknown) => {
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
  discoveryScheduler.clear()
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
    (downloadScheduler.isRunning() ||
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
    downloadScheduler.isRunning() ||
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
    settingsService.drain(),
    queueHelpers.drainWrites(),
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
