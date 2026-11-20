import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryQueueInput,
  DiscoveryQueueUpdate,
  ChapterSelectionUpdate,
  DownloadHistoryEntry,
  EpubMergeProgress,
  LibraryFileCorrection,
  LibraryOperation,
  LibraryProgress,
  NovelTrackerApi,
  SiteExtractionMode
} from '../shared/contracts'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventMap,
  IpcMap
} from '../shared/ipc'

function invokeIpc<Channel extends IpcChannel>(
  channel: Channel,
  ...args: IpcMap[Channel]['args']
): Promise<IpcMap[Channel]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<
    IpcMap[Channel]['result']
  >
}

function onIpcEvent<Channel extends IpcEventChannel>(
  channel: Channel,
  listener: (value: IpcEventMap[Channel]) => void
): () => void {
  const handler = (
    _event: Electron.IpcRendererEvent,
    value: IpcEventMap[Channel]
  ): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NovelTrackerApi = {
  discover: (url) => invokeIpc('chapter:discover', url),
  openVerificationBrowser: (url) => invokeIpc('browser:open-verification', url),
  discoverWithBrowser: (url) => invokeIpc('browser:discover', url),
  cancelBrowserDiscovery: (queueItemId?: string) =>
    invokeIpc('browser:cancel-discovery', queueItemId),
  cancelDiscoveryQueueItem: (id) => invokeIpc('discovery-queue:cancel', id),
  clearBrowserSession: () => invokeIpc('browser:clear-session'),
  chooseOutputDirectory: () => invokeIpc('dialog:choose-output-directory'),
  getSettings: () => invokeIpc('settings:get'),
  updateSettings: (patch) => invokeIpc('settings:update', patch),
  chooseLibraryRoot: () => invokeIpc('dialog:choose-library-root'),
  chooseTrackerCsv: () => invokeIpc('dialog:choose-tracker-csv'),
  getTrackerNovels: () => invokeIpc('tracker:list'),
  getDownloadHistory: () => invokeIpc('download-history:list'),
  onDownloadHistoryUpdate: (listener: (history: DownloadHistoryEntry[]) => void) =>
    onIpcEvent('download-history:update', listener),
  getDiscoveryQueue: () => invokeIpc('discovery-queue:list'),
  getDiscoveryQueueSnapshot: () => invokeIpc('discovery-queue:snapshot'),
  getDiscoveryQueueItem: (id: string) => invokeIpc('discovery-queue:item', id),
  getFailedQueueChapters: (id: string) =>
    invokeIpc('discovery-queue:failed-chapters', id),
  addDiscoveryQueueItems: (items: DiscoveryQueueInput[]) =>
    invokeIpc('discovery-queue:add', items),
  retryDiscoveryQueueItem: (id: string) =>
    invokeIpc('discovery-queue:retry', id),
  retryAllFailedDiscoveries: () => invokeIpc('discovery-queue:retry-failed'),
  forceRetryDiscoveryQueueItem: (id: string) =>
    invokeIpc('discovery-queue:force-retry', id),
  retryDiscoveryQueueItemWithBrowser: (id: string) =>
    invokeIpc('discovery-queue:retry-browser', id),
  refreshDiscoveryQueueItem: (id: string, parserMode?: SiteExtractionMode) =>
    invokeIpc('discovery-queue:refresh', id, parserMode),
  acceptQueueRecommendations: (id: string) =>
    invokeIpc('discovery-queue:accept-recommendations', id),
  enqueueEpubFromSnapshot: (queueItemId, overrides) =>
    invokeIpc('download-queue:enqueue-from-snapshot', queueItemId, overrides),
  retryEpub: (id: string) => invokeIpc('download-queue:retry', id),
  recoverEpubQueueItem: (id: string) => invokeIpc('download-queue:recover', id),
  repackageEpub: (id: string) => invokeIpc('download-queue:repackage', id),
  saveAvailableChaptersEpub: (id: string) =>
    invokeIpc('download-queue:save-available', id),
  pauseEpub: (id: string) => invokeIpc('download-queue:pause', id),
  resumeEpub: (id: string) => invokeIpc('download-queue:resume', id),
  cancelEpub: (id: string) => invokeIpc('download-queue:cancel', id),
  moveQueuedEpub: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') =>
    invokeIpc('download-queue:move', id, direction),
  removeDiscoveryQueueItem: (id: string) =>
    invokeIpc('discovery-queue:remove', id),
  clearDiscoveryQueue: () => invokeIpc('discovery-queue:clear'),
  clearCompletedDiscoveryQueueItems: () =>
    invokeIpc('discovery-queue:clear-completed'),
  updateDiscoveryQueueSelection: (id: string, selection: ChapterSelectionUpdate) =>
    invokeIpc('discovery-queue:update-selection', id, selection),
  reverseDiscoveryQueueChapters: (id: string) =>
    invokeIpc('discovery-queue:reverse-chapters', id),
  updateDiscoveryQueueChapterUrl: (id: string, chapterId: string, url: string) =>
    invokeIpc('discovery-queue:update-chapter-url', id, chapterId, url),
  onDiscoveryQueueUpdate: (
    listener: (update: DiscoveryQueueUpdate) => void
  ) => onIpcEvent('discovery-queue:update', listener),
  getLibraryIndexSummary: () => invokeIpc('library:index-summary'),
  lookupDownloadedNovels: (urls: string[]) =>
    invokeIpc('library:lookup-downloaded-novels', urls),
  searchLibraryNovels: (
    query: string,
    multipleFilesOnly: boolean,
    offset: number,
    limit: number,
    selectedNovelKey?: string
  ) =>
    invokeIpc(
      'library:search-novels',
      query,
      multipleFilesOnly,
      offset,
      limit,
      selectedNovelKey
    ),
  searchLibraryNovelFiles: (
    novelKey: string,
    query: string,
    offset: number,
    limit: number
  ) =>
    invokeIpc(
      'library:search-novel-files',
      novelKey,
      query,
      offset,
      limit
    ),
  getLibraryNovelFiles: (novelKey: string) =>
    invokeIpc('library:novel-files', novelKey),
  getLibraryFileChapterTitles: (fileId: string) =>
    invokeIpc('library:file-chapter-titles', fileId),
  getLibraryIndexBackupDate: () => invokeIpc('library:index-backup-date'),
  restoreLibraryIndexBackup: () => invokeIpc('library:restore-index-backup'),
  repairEpub: (fileId: string) => invokeIpc('library:repair-epub', fileId),
  getLibraryOperations: () => invokeIpc('library:operations'),
  onLibraryOperationsUpdate: (
    listener: (operations: LibraryOperation[]) => void
  ) => onIpcEvent('library:operations:update', listener),
  scanLibrary: (forceRebuild = false) =>
    invokeIpc('library:scan', forceRebuild),
  cancelLibraryScan: () => invokeIpc('library:cancel-scan'),
  correctLibraryFile: (fileId: string, correction: LibraryFileCorrection) =>
    invokeIpc('library:correct-file', fileId, correction),
  mergeLibraryEpubs: (fileIds: string[], filename: string) =>
    invokeIpc('library:merge-epubs', fileIds, filename),
  onLibraryEpubMergeProgress: (
    listener: (progress: EpubMergeProgress) => void
  ) => onIpcEvent('library:merge-progress', listener),
  openLibraryPath: (path, reveal) =>
    invokeIpc('library:open-path', path, reveal),
  onLibraryProgress: (listener: (progress: LibraryProgress) => void) =>
    onIpcEvent('library:progress', listener)
}

contextBridge.exposeInMainWorld('novelTracker', api)
