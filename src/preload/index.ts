import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryResult,
  AppSettings,
  EbookConversionResponse,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DownloadHistoryEntry,
  EpubMergeProgress,
  BrowserSessionInfo,
  GenerateEpubInput,
  QueuedEpubJob,
  LibraryFileCorrection,
  LibraryEpubMergeResult,
  LibraryIndex,
  LibraryOperation,
  LibraryProgress,
  EpubRepairResponse,
  NovelTrackerApi,
  Result,
  TrackerNovel
} from '../shared/contracts'

const api: NovelTrackerApi = {
  discover: (url) => ipcRenderer.invoke('chapter:discover', url) as Promise<Result<DiscoveryResult>>,
  openVerificationBrowser: (url) =>
    ipcRenderer.invoke('browser:open-verification', url) as Promise<Result<BrowserSessionInfo>>,
  discoverWithBrowser: (url) =>
    ipcRenderer.invoke('browser:discover', url) as Promise<Result<DiscoveryResult>>,
  cancelBrowserDiscovery: (queueItemId?: string) =>
    ipcRenderer.invoke('browser:cancel-discovery', queueItemId) as Promise<void>,
  clearBrowserSession: () => ipcRenderer.invoke('browser:clear-session') as Promise<Result<void>>,
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:choose-output-directory') as Promise<string | null>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateEpubCss: (css) => ipcRenderer.invoke('settings:epub-css', css) as Promise<Result<AppSettings>>,
  updateAppTheme: (theme) => ipcRenderer.invoke('settings:app-theme', theme) as Promise<Result<AppSettings>>,
  updateDiscoveryFreshnessHours: (hours) =>
    ipcRenderer.invoke('settings:discovery-freshness', hours) as Promise<Result<AppSettings>>,
  updateDownloadConcurrency: (maxSimultaneousDownloads: number) =>
    ipcRenderer.invoke('settings:download-concurrency', maxSimultaneousDownloads) as Promise<Result<AppSettings>>,
  updateLibraryScanOptions: (scanOldFolder: boolean, scanOldCompletedFolder: boolean) =>
    ipcRenderer.invoke('settings:library-scan-options', scanOldFolder, scanOldCompletedFolder) as Promise<Result<AppSettings>>,
  chooseLibraryRoot: () => ipcRenderer.invoke('dialog:choose-library-root') as Promise<string | null>,
  chooseTrackerCsv: () => ipcRenderer.invoke('dialog:choose-tracker-csv') as Promise<string | null>,
  getTrackerNovels: () => ipcRenderer.invoke('tracker:list') as Promise<Result<TrackerNovel[]>>,
  getDownloadHistory: () => ipcRenderer.invoke('download-history:list') as Promise<DownloadHistoryEntry[]>,
  getDiscoveryQueue: () => ipcRenderer.invoke('discovery-queue:list') as Promise<DiscoveryQueueItemSummary[]>,
  getDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:item', id) as Promise<Result<DiscoveryQueueItem>>,
  addDiscoveryQueueItems: (items: DiscoveryQueueInput[]) =>
    ipcRenderer.invoke('discovery-queue:add', items) as Promise<Result<DiscoveryQueueItem[]>>,
  retryDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:retry', id) as Promise<Result<void>>,
  retryDiscoveryQueueItemWithBrowser: (id: string) =>
    ipcRenderer.invoke('discovery-queue:retry-browser', id) as Promise<Result<void>>,
  refreshDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:refresh', id) as Promise<Result<void>>,
  acceptQueueRecommendations: (id: string, includeOverlap: boolean, overlapCount: number) =>
    ipcRenderer.invoke('discovery-queue:accept-recommendations', id, includeOverlap, overlapCount) as Promise<Result<void>>,
  enqueueEpub: (input: GenerateEpubInput, queueItemId?: string) =>
    ipcRenderer.invoke('download-queue:enqueue', input, queueItemId) as Promise<Result<QueuedEpubJob>>,
  retryEpub: (id: string) => ipcRenderer.invoke('download-queue:retry', id) as Promise<Result<void>>,
  repackageEpub: (id: string) => ipcRenderer.invoke('download-queue:repackage', id) as Promise<Result<void>>,
  pauseEpub: (id: string) => ipcRenderer.invoke('download-queue:pause', id) as Promise<Result<void>>,
  resumeEpub: (id: string) => ipcRenderer.invoke('download-queue:resume', id) as Promise<Result<void>>,
  cancelEpub: (id: string) => ipcRenderer.invoke('download-queue:cancel', id) as Promise<Result<void>>,
  moveQueuedEpub: (id: string, direction: 'up' | 'down') =>
    ipcRenderer.invoke('download-queue:move', id, direction) as Promise<Result<void>>,
  removeDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:remove', id) as Promise<Result<void>>,
  clearDiscoveryQueue: () =>
    ipcRenderer.invoke('discovery-queue:clear') as Promise<Result<void>>,
  clearCompletedDiscoveryQueueItems: () =>
    ipcRenderer.invoke('discovery-queue:clear-completed') as Promise<Result<void>>,
  updateDiscoveryQueueSelection: (id: string, selectedChapterUrls: string[]) =>
    ipcRenderer.invoke('discovery-queue:update-selection', id, selectedChapterUrls) as Promise<Result<void>>,
  onDiscoveryQueueUpdate: (listener: (items: DiscoveryQueueItemSummary[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: DiscoveryQueueItemSummary[]) => listener(items)
    ipcRenderer.on('discovery-queue:update', handler)
    return () => ipcRenderer.removeListener('discovery-queue:update', handler)
  },
  getLibraryIndex: () => ipcRenderer.invoke('library:index') as Promise<LibraryIndex | null>,
  getLibraryIndexBackup: () => ipcRenderer.invoke('library:index-backup') as Promise<LibraryIndex | null>,
  restoreLibraryIndexBackup: () =>
    ipcRenderer.invoke('library:restore-index-backup') as Promise<Result<LibraryIndex>>,
  convertEpubToAzw3: (inputPath: string) =>
    ipcRenderer.invoke('library:convert-azw3', inputPath) as Promise<EbookConversionResponse>,
  convertAzw3ToEpub: (fileId: string) =>
    ipcRenderer.invoke('library:convert-azw3-to-epub', fileId) as Promise<EbookConversionResponse>,
  repairEpub: (fileId: string) =>
    ipcRenderer.invoke('library:repair-epub', fileId) as Promise<EpubRepairResponse>,
  getLibraryOperations: () =>
    ipcRenderer.invoke('library:operations') as Promise<LibraryOperation[]>,
  onLibraryOperationsUpdate: (listener: (operations: LibraryOperation[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, operations: LibraryOperation[]) => listener(operations)
    ipcRenderer.on('library:operations:update', handler)
    return () => ipcRenderer.removeListener('library:operations:update', handler)
  },
  scanLibrary: (forceRebuild = false) =>
    ipcRenderer.invoke('library:scan', forceRebuild) as Promise<Result<LibraryIndex>>,
  cancelLibraryScan: () => ipcRenderer.invoke('library:cancel-scan') as Promise<void>,
  correctLibraryFile: (fileId: string, correction: LibraryFileCorrection) =>
    ipcRenderer.invoke('library:correct-file', fileId, correction) as Promise<Result<LibraryIndex>>,
  mergeLibraryEpubs: (fileIds: string[], filename: string) =>
    ipcRenderer.invoke('library:merge-epubs', fileIds, filename) as Promise<Result<LibraryEpubMergeResult>>,
  onLibraryEpubMergeProgress: (listener: (progress: EpubMergeProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: EpubMergeProgress) => listener(progress)
    ipcRenderer.on('library:merge-progress', handler)
    return () => ipcRenderer.removeListener('library:merge-progress', handler)
  },
  openLibraryPath: (path, reveal) => ipcRenderer.invoke('library:open-path', path, reveal),
  onLibraryProgress: (listener: (progress: LibraryProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: LibraryProgress) => listener(progress)
    ipcRenderer.on('library:progress', handler)
    return () => ipcRenderer.removeListener('library:progress', handler)
  },
}

contextBridge.exposeInMainWorld('novelTracker', api)
