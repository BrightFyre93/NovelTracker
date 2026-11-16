import type {
  BrowserSessionInfo,
  DiscoveryResult,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  AppSettings,
  DownloadHistoryEntry,
  DomainRequestDelayPreference,
  EpubMergeProgress,
  EpubRepairResponse,
  GenerateEpubInput,
  LibraryEpubMergeResponse,
  LibraryFileCorrection,
  LibraryFileRecord,
  LibraryIndexSummary,
  LibraryOperation,
  LibraryProgress,
  QueuedEpubJob,
  Result,
  SiteExtractionPreference,
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
    result: LibraryIndexSummary | null
  }
  'library:novel-files': {
    args: [novelKey: string]
    result: Result<LibraryFileRecord[]>
  }
  'library:index-backup-date': {
    args: []
    result: string | null
  }
  'library:restore-index-backup': {
    args: []
    result: Result<LibraryIndexSummary>
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
    result: Result<LibraryIndexSummary>
  }
  'library:cancel-scan': {
    args: []
    result: void
  }
  'library:correct-file': {
    args: [fileId: string, correction: LibraryFileCorrection]
    result: Result<LibraryIndexSummary>
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
  'download-queue:enqueue': {
    args: [input: GenerateEpubInput, queueItemId?: string]
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
  'settings:epub-css': {
    args: [css: string]
    result: Result<AppSettings>
  }
  'settings:app-theme': {
    args: [theme: AppSettings['appTheme']]
    result: Result<AppSettings>
  }
  'settings:discovery-freshness': {
    args: [hours: number]
    result: Result<AppSettings>
  }
  'settings:download-concurrency': {
    args: [maxSimultaneousDownloads: number]
    result: Result<AppSettings>
  }
  'settings:discovery-concurrency': {
    args: [maxSimultaneousDiscoveries: number]
    result: Result<AppSettings>
  }
  'settings:chapter-concurrency': {
    args: [maxSimultaneousChaptersPerNovel: number]
    result: Result<AppSettings>
  }
  'settings:domain-request-delays': {
    args: [preferences: DomainRequestDelayPreference[]]
    result: Result<AppSettings>
  }
  'settings:site-extraction-preferences': {
    args: [preferences: SiteExtractionPreference[]]
    result: Result<AppSettings>
  }
  'settings:library-scan-options': {
    args: [scanOldFolder: boolean, scanOldCompletedFolder: boolean]
    result: Result<AppSettings>
  }
  'discovery-queue:list': {
    args: []
    result: DiscoveryQueueItemSummary[]
  }
  'discovery-queue:item': {
    args: [id: string]
    result: Result<DiscoveryQueueItem>
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
    args: [id: string]
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
    args: [id: string, selectedChapterUrls: string[]]
    result: Result<void>
  }
}

export type IpcChannel = keyof IpcMap

export interface IpcEventMap {
  'discovery-queue:update': DiscoveryQueueItemSummary[]
  'library:operations:update': LibraryOperation[]
  'library:merge-progress': EpubMergeProgress
  'library:progress': LibraryProgress
}

export type IpcEventChannel = keyof IpcEventMap
