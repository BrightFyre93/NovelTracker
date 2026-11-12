import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryResult,
  AppSettings,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DownloadHistoryEntry,
  GenerateEpubInput,
  QueuedEpubJob,
  LibraryFileCorrection,
  LibraryIndex,
  LibraryProgress,
  NovelTrackerApi,
  Result,
  TrackerNovel
} from '../shared/contracts'

const api: NovelTrackerApi = {
  discover: (url) => ipcRenderer.invoke('chapter:discover', url) as Promise<Result<DiscoveryResult>>,
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:choose-output-directory') as Promise<string | null>,
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateEpubCss: (css) => ipcRenderer.invoke('settings:epub-css', css) as Promise<Result<AppSettings>>,
  updateDownloadConcurrency: (maxSimultaneousDownloads: number) =>
    ipcRenderer.invoke('settings:download-concurrency', maxSimultaneousDownloads) as Promise<Result<AppSettings>>,
  chooseLibraryRoot: () => ipcRenderer.invoke('dialog:choose-library-root') as Promise<string | null>,
  chooseTrackerCsv: () => ipcRenderer.invoke('dialog:choose-tracker-csv') as Promise<string | null>,
  getTrackerNovels: () => ipcRenderer.invoke('tracker:list') as Promise<Result<TrackerNovel[]>>,
  getDownloadHistory: () => ipcRenderer.invoke('download-history:list') as Promise<DownloadHistoryEntry[]>,
  getDiscoveryQueue: () => ipcRenderer.invoke('discovery-queue:list') as Promise<DiscoveryQueueItem[]>,
  addDiscoveryQueueItems: (items: DiscoveryQueueInput[]) =>
    ipcRenderer.invoke('discovery-queue:add', items) as Promise<Result<DiscoveryQueueItem[]>>,
  retryDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:retry', id) as Promise<Result<void>>,
  refreshDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:refresh', id) as Promise<Result<void>>,
  acceptQueueRecommendations: (id: string, includeOverlap: boolean, overlapCount: number) =>
    ipcRenderer.invoke('discovery-queue:accept-recommendations', id, includeOverlap, overlapCount) as Promise<Result<void>>,
  enqueueEpub: (input: GenerateEpubInput, queueItemId?: string) =>
    ipcRenderer.invoke('download-queue:enqueue', input, queueItemId) as Promise<Result<QueuedEpubJob>>,
  retryEpub: (id: string) => ipcRenderer.invoke('download-queue:retry', id) as Promise<Result<void>>,
  pauseEpub: (id: string) => ipcRenderer.invoke('download-queue:pause', id) as Promise<Result<void>>,
  resumeEpub: (id: string) => ipcRenderer.invoke('download-queue:resume', id) as Promise<Result<void>>,
  cancelEpub: (id: string) => ipcRenderer.invoke('download-queue:cancel', id) as Promise<Result<void>>,
  moveQueuedEpub: (id: string, direction: 'up' | 'down') =>
    ipcRenderer.invoke('download-queue:move', id, direction) as Promise<Result<void>>,
  removeDiscoveryQueueItem: (id: string) =>
    ipcRenderer.invoke('discovery-queue:remove', id) as Promise<Result<void>>,
  clearDiscoveryQueue: () =>
    ipcRenderer.invoke('discovery-queue:clear') as Promise<Result<void>>,
  updateDiscoveryQueueSelection: (id: string, selectedChapterUrls: string[]) =>
    ipcRenderer.invoke('discovery-queue:update-selection', id, selectedChapterUrls) as Promise<Result<void>>,
  onDiscoveryQueueUpdate: (listener: (items: DiscoveryQueueItem[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: DiscoveryQueueItem[]) => listener(items)
    ipcRenderer.on('discovery-queue:update', handler)
    return () => ipcRenderer.removeListener('discovery-queue:update', handler)
  },
  getLibraryIndex: () => ipcRenderer.invoke('library:index') as Promise<LibraryIndex | null>,
  scanLibrary: () => ipcRenderer.invoke('library:scan') as Promise<Result<LibraryIndex>>,
  cancelLibraryScan: () => ipcRenderer.invoke('library:cancel-scan') as Promise<void>,
  correctLibraryFile: (fileId: string, correction: LibraryFileCorrection) =>
    ipcRenderer.invoke('library:correct-file', fileId, correction) as Promise<Result<LibraryIndex>>,
  openLibraryPath: (path, reveal) => ipcRenderer.invoke('library:open-path', path, reveal),
  onLibraryProgress: (listener: (progress: LibraryProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: LibraryProgress) => listener(progress)
    ipcRenderer.on('library:progress', handler)
    return () => ipcRenderer.removeListener('library:progress', handler)
  },
}

contextBridge.exposeInMainWorld('novelTracker', api)
