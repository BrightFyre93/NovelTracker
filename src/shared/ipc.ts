import type {
  BrowserSessionInfo,
  DiscoveryResult,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DiscoveryQueueSnapshot,
  DiscoveryQueueUpdate,
  FailedQueueChapter,
  ChapterSelectionUpdate,
  AppSettings,
  SettingsUpdatePatch,
  SiteExtractionMode,
  DownloadHistoryEntry,
  EpubMergeProgress,
  EpubRepairResponse,
  LibraryEpubMergeResponse,
  LibraryFileCorrection,
  LibraryFileCorrectionResult,
  LibraryFileSearchPage,
  LibraryFileRecord,
  LibraryIndexOverview,
  LibraryNovelSearchPage,
  LibraryOperation,
  LibraryProgress,
  QueuedEpubJob,
  QueueEpubOverrides,
  Result,
  TrackerNovel
} from './contracts'

export interface IpcMap {
  'chapter:discover': {
    args: [url: string]
    result: Result<DiscoveryResult>
  }
  'browser:open-verification': {
    args: [url: string]
    result: Result<BrowserSessionInfo>
  }
  'browser:discover': {
    args: [url: string]
    result: Result<DiscoveryResult>
  }
  'browser:cancel-discovery': {
    args: [queueItemId?: string]
    result: void
  }
  'browser:clear-session': {
    args: []
    result: Result<void>
  }
  'library:index-summary': {
    args: []
    result: LibraryIndexOverview | null
  }
  'library:search-novels': {
    args: [
      query: string,
      multipleFilesOnly: boolean,
      offset: number,
      limit: number,
      selectedNovelKey?: string
    ]
    result: Result<LibraryNovelSearchPage>
  }
  'library:search-novel-files': {
    args: [novelKey: string, query: string, offset: number, limit: number]
    result: Result<LibraryFileSearchPage>
  }
  'library:novel-files': {
    args: [novelKey: string]
    result: Result<LibraryFileRecord[]>
  }
  'library:file-chapter-titles': {
    args: [fileId: string]
    result: Result<string[]>
  }
  'library:index-backup-date': {
    args: []
    result: string | null
  }
  'library:restore-index-backup': {
    args: []
    result: Result<LibraryIndexOverview>
  }
  'library:repair-epub': {
    args: [fileId: string]
    result: EpubRepairResponse
  }
  'library:operations': {
    args: []
    result: LibraryOperation[]
  }
  'library:scan': {
    args: [forceRebuild?: boolean]
    result: Result<LibraryIndexOverview>
  }
  'library:cancel-scan': {
    args: []
    result: void
  }
  'library:correct-file': {
    args: [fileId: string, correction: LibraryFileCorrection]
    result: Result<LibraryFileCorrectionResult>
  }
  'library:merge-epubs': {
    args: [fileIds: string[], filename: string]
    result: LibraryEpubMergeResponse
  }
  'library:open-path': {
    args: [path: string, reveal: boolean]
    result: Result<void>
  }
  'tracker:list': {
    args: []
    result: Result<TrackerNovel[]>
  }
  'download-history:list': {
    args: []
    result: DownloadHistoryEntry[]
  }
  'download-queue:enqueue-from-snapshot': {
    args: [queueItemId: string, overrides: QueueEpubOverrides]
    result: Result<QueuedEpubJob>
  }
  'download-queue:retry': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:recover': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:repackage': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:save-available': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:pause': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:resume': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:cancel': {
    args: [id: string]
    result: Result<void>
  }
  'download-queue:move': {
    args: [id: string, direction: 'up' | 'down' | 'top' | 'bottom']
    result: Result<void>
  }
  'dialog:choose-output-directory': {
    args: []
    result: string | null
  }
  'dialog:choose-library-root': {
    args: []
    result: string | null
  }
  'dialog:choose-tracker-csv': {
    args: []
    result: string | null
  }
  'settings:get': {
    args: []
    result: AppSettings
  }
  'settings:update': {
    args: [patch: SettingsUpdatePatch]
    result: Result<AppSettings>
  }
  'discovery-queue:list': {
    args: []
    result: DiscoveryQueueItemSummary[]
  }
  'discovery-queue:snapshot': {
    args: []
    result: DiscoveryQueueSnapshot
  }
  'discovery-queue:item': {
    args: [id: string]
    result: Result<DiscoveryQueueItem>
  }
  'discovery-queue:failed-chapters': {
    args: [id: string]
    result: Result<FailedQueueChapter[]>
  }
  'discovery-queue:add': {
    args: [items: DiscoveryQueueInput[]]
    result: Result<DiscoveryQueueItem[]>
  }
  'discovery-queue:cancel': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:retry': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:retry-failed': {
    args: []
    result: Result<number>
  }
  'discovery-queue:force-retry': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:retry-browser': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:refresh': {
    args: [id: string, parserMode?: SiteExtractionMode]
    result: Result<void>
  }
  'discovery-queue:accept-recommendations': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:remove': {
    args: [id: string]
    result: Result<void>
  }
  'discovery-queue:clear': {
    args: []
    result: Result<void>
  }
  'discovery-queue:clear-completed': {
    args: []
    result: Result<void>
  }
  'discovery-queue:update-selection': {
    args: [id: string, selection: ChapterSelectionUpdate]
    result: Result<void>
  }
}

export type IpcChannel = keyof IpcMap

export interface IpcEventMap {
  'discovery-queue:update': DiscoveryQueueUpdate
  'download-history:update': DownloadHistoryEntry[]
  'library:operations:update': LibraryOperation[]
  'library:merge-progress': EpubMergeProgress
  'library:progress': LibraryProgress
}

export type IpcEventChannel = keyof IpcEventMap
