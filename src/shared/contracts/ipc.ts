import type { Result } from './common'
import type { DiscoveryResult } from './epub'
import type {
  AppSettings,
  SettingsUpdatePatch,
  BrowserSessionInfo,
  SiteExtractionMode
} from './settings'
import type {
  DownloadHistoryEntry,
  TrackerNovel,
  QueuedEpubJob,
  QueueEpubOverrides,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  FailedQueueChapter,
  DiscoveryQueueSnapshot,
  DiscoveryQueueUpdate,
  ChapterSelectionUpdate,
  DiscoveryQueueInput
} from './queue'
import type {
  LibraryFileCorrection,
  LibraryFileCorrectionResult,
  LibraryFileSearchPage,
  LibraryFileRecord,
  LibraryIndexOverview,
  LibraryNovelSearchPage,
  LibraryProgress,
  EpubMergeProgress,
  LibraryEpubMergeResponse,
  LibraryOperation,
  EpubRepairResponse
} from './library'

export interface NovelTrackerApi {
  discover(url: string): Promise<Result<DiscoveryResult>>
  openVerificationBrowser(url: string): Promise<Result<BrowserSessionInfo>>
  discoverWithBrowser(url: string): Promise<Result<DiscoveryResult>>
  cancelBrowserDiscovery(queueItemId?: string): Promise<void>
  cancelDiscoveryQueueItem(id: string): Promise<Result<void>>
  clearBrowserSession(): Promise<Result<void>>
  chooseOutputDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsUpdatePatch): Promise<Result<AppSettings>>
  chooseLibraryRoot(): Promise<string | null>
  chooseTrackerCsv(): Promise<string | null>
  getTrackerNovels(): Promise<Result<TrackerNovel[]>>
  getDownloadHistory(): Promise<DownloadHistoryEntry[]>
  onDownloadHistoryUpdate(
    listener: (history: DownloadHistoryEntry[]) => void
  ): () => void
  getDiscoveryQueue(): Promise<DiscoveryQueueItemSummary[]>
  getDiscoveryQueueSnapshot(): Promise<DiscoveryQueueSnapshot>
  getDiscoveryQueueItem(id: string): Promise<Result<DiscoveryQueueItem>>
  getFailedQueueChapters(id: string): Promise<Result<FailedQueueChapter[]>>
  addDiscoveryQueueItems(
    items: DiscoveryQueueInput[]
  ): Promise<Result<DiscoveryQueueItem[]>>
  retryDiscoveryQueueItem(id: string): Promise<Result<void>>
  retryAllFailedDiscoveries(): Promise<Result<number>>
  forceRetryDiscoveryQueueItem(id: string): Promise<Result<void>>
  retryDiscoveryQueueItemWithBrowser(id: string): Promise<Result<void>>
  refreshDiscoveryQueueItem(
    id: string,
    parserMode?: SiteExtractionMode
  ): Promise<Result<void>>
  acceptQueueRecommendations(id: string): Promise<Result<void>>
  enqueueEpubFromSnapshot(
    queueItemId: string,
    overrides: QueueEpubOverrides
  ): Promise<Result<QueuedEpubJob>>
  retryEpub(id: string): Promise<Result<void>>
  recoverEpubQueueItem(id: string): Promise<Result<void>>
  pauseEpub(id: string): Promise<Result<void>>
  resumeEpub(id: string): Promise<Result<void>>
  cancelEpub(id: string): Promise<Result<void>>
  moveQueuedEpub(
    id: string,
    direction: 'up' | 'down' | 'top' | 'bottom'
  ): Promise<Result<void>>
  removeDiscoveryQueueItem(id: string): Promise<Result<void>>
  clearDiscoveryQueue(): Promise<Result<void>>
  clearCompletedDiscoveryQueueItems(): Promise<Result<void>>
  updateDiscoveryQueueSelection(
    id: string,
    selection: ChapterSelectionUpdate
  ): Promise<Result<void>>
  repackageEpub(id: string): Promise<Result<void>>
  saveAvailableChaptersEpub(id: string): Promise<Result<void>>
  onDiscoveryQueueUpdate(
    listener: (update: DiscoveryQueueUpdate) => void
  ): () => void
  getLibraryIndexSummary(): Promise<LibraryIndexOverview | null>
  searchLibraryNovels(
    query: string,
    multipleFilesOnly: boolean,
    offset: number,
    limit: number,
    selectedNovelKey?: string
  ): Promise<Result<LibraryNovelSearchPage>>
  searchLibraryNovelFiles(
    novelKey: string,
    query: string,
    offset: number,
    limit: number
  ): Promise<Result<LibraryFileSearchPage>>
  getLibraryNovelFiles(novelKey: string): Promise<Result<LibraryFileRecord[]>>
  getLibraryFileChapterTitles(fileId: string): Promise<Result<string[]>>
  getLibraryIndexBackupDate(): Promise<string | null>
  restoreLibraryIndexBackup(): Promise<Result<LibraryIndexOverview>>
  scanLibrary(forceRebuild?: boolean): Promise<Result<LibraryIndexOverview>>
  cancelLibraryScan(): Promise<void>
  correctLibraryFile(
    fileId: string,
    correction: LibraryFileCorrection
  ): Promise<Result<LibraryFileCorrectionResult>>
  mergeLibraryEpubs(
    fileIds: string[],
    filename: string
  ): Promise<LibraryEpubMergeResponse>
  repairEpub(fileId: string): Promise<EpubRepairResponse>
  getLibraryOperations(): Promise<LibraryOperation[]>
  onLibraryOperationsUpdate(
    listener: (operations: LibraryOperation[]) => void
  ): () => void
  onLibraryEpubMergeProgress(
    listener: (progress: EpubMergeProgress) => void
  ): () => void
  openLibraryPath(path: string, reveal: boolean): Promise<Result<void>>
  onLibraryProgress(listener: (progress: LibraryProgress) => void): () => void
}
