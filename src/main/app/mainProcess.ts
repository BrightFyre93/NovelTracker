import { app, BrowserWindow, dialog, nativeTheme } from 'electron'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { EpubMergeProgress } from '../../shared/contracts'
import {
  MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
  MAX_SELECTED_CHAPTERS
} from '../../shared/constants'
import { settingsUpdatePatchSchema } from '../../shared/settingsUpdatePatchSchema'
import { siteExtractionModeForUrl } from '../../shared/siteExtractionPreferences'
import {
  clearBrowserSession,
  closeBrowserSession,
  openVerificationBrowser,
  readBrowserPage
} from '../services/browserService'
import {
  readArchivedDownloadHistory,
  migrateSettings,
  removeChapterArtifacts
} from '../services/localStore'
import { readTrackerCsv } from '../services/trackerCsv'
import {
  discoverChapters,
  discoverChaptersUsingPageLoader,
  setDomainRequestDelays,
  setHttpTimeouts
} from '../services/scraper'
import { samePath } from '../services/pathUtils'
import { runWorker } from '../services/workerRunner'
import { SettingsService } from '../services/settingsService'
import { copyQueueItem, createQueueItem } from '../services/queueItem'
import { projectDownloadHistory } from '../services/queue/jobHistory'
import { recommendArchiveCoverage } from '../../shared/archiveRecommendation'
import {
  OperationCancelledError,
  isNodeError,
  toMessage
} from '../../shared/errors'
import {
  summarizeLibraryIndex,
  summarizeLibraryIndexOverview
} from '../../shared/libraryIndexSummary'
import { resolveChapterSelection } from '../../shared/chapterSelection'
import { normalizeNovelTitleForMatching } from '../../shared/novelTitle'
import { sanitizeEpubFilename } from '../../shared/epubFilename'
import {
  flushLocalLogger,
  initializeLocalLogger
} from '../services/localLogger'
import {
  assertOutputPathAvailable,
  expectedOutputPath,
  createQueueHelpers,
  hydrateQueueItem,
  updateQueueChapterSummary
} from '../services/queue/helpers'
import { recoverStartupState } from './startupRecovery'
import {
  sweepNovelTrackerTemporaryFiles,
  sweepStaleEpubTemporaryDirectories
} from './tempDirectoryCleanup'
import { registerProcessErrorHandlers } from './processErrorHandlers'
import { MainWindowManager } from './windowManager'
import { registerShutdownHandlers } from './shutdown'
import { MainProcessState } from './runtimeState'
import { createQueueRuntime } from '../services/queue/runtime'
import type {
  EpubPackagingInput,
  EpubPackagingProgress,
  EpubPackagingResult
} from '../services/epubPackaging'
import { QueueStore } from '../services/queue/store'
import { SqliteDatabase } from '../infra/sqliteDatabase'
import { createSqliteQueueRepository } from '../services/queue/sqliteRepository'
import { createSqliteLibraryIndexRepository } from '../services/library/sqliteLibraryIndexRepository'
import { createLibraryOperationsLog } from '../services/library/operationsLog'
import { createLibraryFileAccess } from '../services/library/fileAccess'
import { createQueueInputParser } from '../services/queue/inputParser'
import { IpcBroadcaster } from '../services/ipcBroadcaster'
import { transitionQueueItem } from '../services/queue/queueStateMachine'
import { createIpcHandlerFactory } from '../ipc/handlerFactory'
import { registerMainIpcHandlers } from './ipcRegistration'

const mainWindowManager = new MainWindowManager()
const runtimeState = new MainProcessState()
const {
  approvedOutputDirectories,
  reservedOutputPaths,
  browserAssistedDiscoveries,
  activeBrowserDiscoveries,
  activeQueueDiscoveries,
  activeDownloads,
  activeLibraryWorkers,
  activeBackgroundTasks
} = runtimeState

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (hasSingleInstanceLock) {
  app.on('second-instance', () => mainWindowManager.focusOrRemember())
} else {
  app.quit()
}

function dataDirectory(): string {
  return app.getPath('userData')
}

const ipcBroadcaster = new IpcBroadcaster(() => BrowserWindow.getAllWindows())
const { notifyDownloadHistoryChanged, sendToCurrentFrame } = ipcBroadcaster

const libraryOperationsLog = createLibraryOperationsLog(
  dataDirectory,
  (operations) => {
    ipcBroadcaster.sendToAll('library:operations:update', operations)
  }
)
const {
  copy: copyLibraryOperations,
  drain: drainLibraryOperationWrites,
  flush: flushLibraryOperations,
  outputPaths: libraryOperationOutputPaths,
  set: setLibraryOperations,
  start: startLibraryOperation,
  update: updateLibraryOperation
} = libraryOperationsLog

function packageEpubInWorker(
  input: EpubPackagingInput,
  signal: AbortSignal,
  onProgress: (progress: EpubPackagingProgress) => void
): Promise<EpubPackagingResult> {
  const worker = new Worker(join(__dirname, 'epubPackageWorker.js'), {
    workerData: { ...input, appVersion: app.getVersion() },
    resourceLimits: { maxOldGenerationSizeMb: 1024 }
  })
  return runWorker<EpubMergeProgress, EpubPackagingResult>(worker, {
    workerName: 'EPUB packaging',
    missingResultMessage:
      'EPUB packaging worker exited without creating an EPUB.',
    onProgress,
    signal,
    onCancel: () => worker.postMessage({ type: 'cancel' })
  })
}

const sqliteDatabase = new SqliteDatabase(dataDirectory)
const queueRepository = createSqliteQueueRepository(
  sqliteDatabase,
  dataDirectory
)
const queueStore = new QueueStore(queueRepository, hasUnknownProperties)
const discoveryQueue = queueStore.items
const libraryIndexRepository = createSqliteLibraryIndexRepository(
  sqliteDatabase,
  dataDirectory
)
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
const notifyDiscoveryQueueChanged = () =>
  ipcBroadcaster.notifyDiscoveryQueueChanged(copyDiscoveryQueue)

const settingsService = new SettingsService(dataDirectory)
const libraryFileAccess = createLibraryFileAccess({
  libraryIndexRepository,
  getSettings: () => settingsService.get(),
  getMainWindow: () => mainWindowManager.current,
  samePath
})
const { getIndexedLibraryFile, getSiblingOutputPath } = libraryFileAccess
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
  chapterStateRepository: queueRepository,
  packageEpub: packageEpubInWorker,
  isShuttingDown: () => runtimeState.shuttingDown,
  queueHelpers,
  notifyDiscoveryQueueChanged,
  trackBackgroundTask,
  errorMessage
})
const { persistDownloadState, discoveryScheduler, downloadScheduler } =
  queueRuntime

function errorMessage(error: unknown): string {
  return toMessage(error)
}

const { handle } = createIpcHandlerFactory(() =>
  mainWindowManager.current && !mainWindowManager.current.isDestroyed()
    ? mainWindowManager.current.webContents
    : null
)

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

function hasUnknownProperties(saved: object, normalized: object): boolean {
  const normalizedKeys = new Set(Object.keys(normalized))
  return Object.keys(saved).some((key) => !normalizedKeys.has(key))
}

const { parseDiscoveryQueueInputs, parseGenerateInput } =
  createQueueInputParser(approvedOutputDirectories)

const mainIpcDependencies = {
  MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
  MAX_SELECTED_CHAPTERS,
  OperationCancelledError,
  activeBrowserDiscoveries,
  activeDownloads,
  activeQueueDiscoveries,
  approvedOutputDirectories,
  archiveRemovedJobs,
  assertOutputPathAvailable,
  browserAssistedDiscoveries,
  chapterStateRepository: queueRepository,
  clearBrowserSession,
  clearDirtyChapterData,
  copyDiscoveryQueue,
  copyLibraryOperations,
  copyQueueItem,
  createQueueItem,
  dataDirectory,
  discoverChapters,
  discoverChaptersUsingPageLoader,
  discoveryQueue,
  discoveryScheduler,
  downloadScheduler,
  errorMessage,
  expectedOutputPath,
  getIndexedLibraryFile,
  getSiblingOutputPath,
  handle,
  isNodeError,
  libraryIndexRepository,
  markQueueItemChaptersDirty,
  mutateItem,
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
  readArchivedDownloadHistory,
  readBrowserPage,
  readTrackerCsv,
  recommendArchiveCoverage,
  removeChapterArtifacts,
  resolveChapterSelection,
  runWorker,
  samePath,
  sanitizeEpubFilename,
  sendToCurrentFrame,
  settingsService,
  settingsUpdatePatchSchema,
  siteExtractionModeForUrl,
  startLibraryOperation,
  summarizeLibraryIndex,
  summarizeLibraryIndexOverview,
  trackLibraryWorker,
  transitionQueueItem,
  updateLibraryOperation,
  updateQueueChapterSummary,
  withChapters,
  get mainWindow(): BrowserWindow | null {
    return mainWindowManager.current
  },
  get activeLibraryScan() {
    return runtimeState.activeLibraryScan
  },
  set activeLibraryScan(value) {
    runtimeState.activeLibraryScan = value
  },
  get libraryIndexRestoreActive() {
    return runtimeState.libraryIndexRestoreActive
  },
  set libraryIndexRestoreActive(value) {
    runtimeState.libraryIndexRestoreActive = value
  },
  get libraryCorrectionActive() {
    return runtimeState.libraryCorrectionActive
  },
  set libraryCorrectionActive(value) {
    runtimeState.libraryCorrectionActive = value
  },
  get activeLibraryOperationHandlers() {
    return runtimeState.activeLibraryOperationHandlers
  },
  set activeLibraryOperationHandlers(value) {
    runtimeState.activeLibraryOperationHandlers = value
  },
  get shuttingDown() {
    return runtimeState.shuttingDown
  },
  set shuttingDown(value) {
    runtimeState.shuttingDown = value
  },
  get discoveryQueueRevision(): number {
    return ipcBroadcaster.discoveryQueueRevision
  }
}

export type MainIpcDependencies = typeof mainIpcDependencies

app
  .whenReady()
  .then(async () => {
    if (!hasSingleInstanceLock) return
    initializeLocalLogger(dataDirectory(), app.getVersion())
    registerProcessErrorHandlers()
    await sweepStaleEpubTemporaryDirectories().catch((error: unknown) => {
      console.warn(
        'Stale EPUB temporary directories could not be swept:',
        error
      )
    })
    await migrateSettings(dataDirectory())
    await settingsService.initialize()
    nativeTheme.themeSource = settingsService.current.appTheme
    settingsService.onDidChange((current, patch) => {
      if ('appTheme' in patch) nativeTheme.themeSource = current.appTheme
      if ('domainRequestDelays' in patch)
        setDomainRequestDelays(current.domainRequestDelays)
      if (
        'httpConnectTimeoutMs' in patch ||
        'httpResponseReadTimeoutMs' in patch
      ) {
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
      if ('maxSimultaneousDiscoveries' in patch) discoveryScheduler.schedule()
    })
    if (app.isPackaged) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = join(
        process.resourcesPath,
        'playwright-browsers'
      )
    }
    if (process.platform === 'win32')
      app.setAppUserModelId('com.brightfyre.noveltracker')
    registerMainIpcHandlers(mainIpcDependencies)
    const { settings, storageRecoveryWarnings } = await recoverStartupState({
      dataDirectory: dataDirectory(),
      setLibraryOperations,
      flushLibraryOperations,
      setDiscoveryQueue: (items) => {
        queueStore.replace(items)
      },
      queueRepository,
      chapterStateRepository: queueRepository,
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
    setHttpTimeouts(
      settings.httpConnectTimeoutMs,
      settings.httpResponseReadTimeoutMs
    )
    await mainWindowManager.create()
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
        void mainWindowManager.create().catch((error: unknown) => {
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

registerShutdownHandlers(app, {
  setShuttingDown: () => {
    runtimeState.shuttingDown = true
  },
  clearDiscoveryQueueNotifications: () =>
    ipcBroadcaster.clearDiscoveryQueueNotification(),
  clearDiscoveryScheduler: () => discoveryScheduler.clear(),
  browserAssistedDiscoveries,
  activeQueueDiscoveries,
  activeBrowserDiscoveries,
  activeDownloads,
  cancelLibraryScan: () => {
    if (!runtimeState.activeLibraryScan) return
    runtimeState.activeLibraryScan.cancelRequested = true
    runtimeState.activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  },
  activeLibraryWorkers,
  isWorkActive: () =>
    downloadScheduler.isRunning() ||
    activeDownloads.size > 0 ||
    activeBackgroundTasks.size > 0 ||
    activeQueueDiscoveries.size > 0 ||
    activeBrowserDiscoveries.size > 0 ||
    runtimeState.activeLibraryScan !== null ||
    activeLibraryWorkers.size > 0 ||
    runtimeState.activeLibraryOperationHandlers > 0 ||
    runtimeState.libraryIndexRestoreActive ||
    runtimeState.libraryCorrectionActive,
  closeBrowserSession,
  drainWrites: async () => {
    await Promise.all([
      settingsService.drain(),
      queueHelpers.drainWrites(),
      drainLibraryOperationWrites()
    ])
  },
  flushLibraryOperations,
  closeDatabase: () => sqliteDatabase.close(),
  temporaryDirectories: () => [
    dataDirectory(),
    ...approvedOutputDirectories,
    ...libraryOperationOutputPaths().map(dirname)
  ],
  sweepTemporaryFiles: sweepNovelTrackerTemporaryFiles,
  flushLogger: flushLocalLogger
})
