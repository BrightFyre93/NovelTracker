import type { ChapterLink, GenerateEpubInput } from './epub'
import type { SiteExtractionMode } from './settings'

export type DownloadJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'partially-completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface DownloadHistoryEntry {
  id: string
  queueItemId?: string
  title: string
  author: string
  sourceUrl: string
  trackerRow: GenerateEpubInput['trackerRow'] | null
  selectedChapterCount: number
  status: DownloadJobStatus
  completedChapters: number
  outputPath: string
  error: string
  startedAt: string
  updatedAt: string
}

export interface TrackerSource {
  label: string
  url: string
  valid: boolean
}

export interface TrackerNovel {
  stableId: string
  rowNumber: number
  title: string
  siteTitle: string
  author: string
  alternativeNames: string
  sources: TrackerSource[]
}

export type DiscoveryQueueStatus =
  | 'discovering'
  | 'needs-review'
  | 'ready'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'partially-completed'
  | 'packaging-failed'
  | 'failed'
  | 'cancelled'

export type ChapterArchiveStatus =
  'confirmed' | 'probable' | 'uncertain' | 'missing'

export interface QueueChapter extends ChapterLink {
  selected: boolean
  archiveStatus: ChapterArchiveStatus
  archiveSources: string[]
  chapterNumber: number | null
  archiveGap: boolean
  recommended: boolean
}

export interface QueueDownloadOptions {
  title: string
  author: string
  description: string
  coverUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  language: string
  filename: string
  sourceUrl: string
  outputDirectory: string
  epubCss: string
}

export interface QueuedEpubJob {
  queueItemId: string
  historyId: string
}

export interface QueueEpubOverrides {
  title?: string
  author?: string
  description?: string
  coverUrl?: string
  alternativeNames?: string[]
  genres?: string[]
  source?: string
  novelStatus?: string
  language?: string
  filename?: string
  outputDirectory: string
}

export interface FailedQueueChapter {
  url: string
  title: string
  error: string
}

export interface QueueChapterSummary {
  total: number
  selected: number
  recommended: number
  hasUncertainArchiveChapters: boolean
  latestTitle: string
}

export interface DiscoveryQueueItem {
  id: string
  sequence: number
  title: string
  author: string
  description: string
  coverUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  sourceUrl: string
  origin: 'tracker' | 'manual'
  separateJob?: boolean
  trackerRow: GenerateEpubInput['trackerRow'] | null
  status: DiscoveryQueueStatus
  parserName: string
  siteExtractionMode?: SiteExtractionMode
  chapters: QueueChapter[]
  chapterSummary: QueueChapterSummary
  targetOutputPath: string
  discoveryChanges: string
  recommendationSummary: string
  repackageOnly: boolean
  saveAvailableChaptersOnly?: boolean
  downloadOptions: QueueDownloadOptions | null
  downloadStartedAt: string
  queuedAt: string
  completedChapterUrls: string[]
  failedChapters: FailedQueueChapter[]
  outputPath: string
  downloadHistoryId: string
  progress: JobProgress | null
  error: string
  recoveryReason?: 'missing-history'
  discoveredAt: string
  updatedAt: string
}

export type DiscoveryQueueItemSummary = Omit<
  DiscoveryQueueItem,
  'chapters' | 'completedChapterUrls'
> & {
  failedChapterCount: number
}

export interface DiscoveryQueueSnapshot {
  revision: number
  items: DiscoveryQueueItemSummary[]
}

export interface DiscoveryQueueUpdate {
  revision: number
  upserted: DiscoveryQueueItemSummary[]
  removedIds: string[]
  order: string[]
}

export interface ChapterSelectionRange {
  start: number
  end: number
}

export type ChapterSelectionUpdate =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'ranges'; ranges: ChapterSelectionRange[] }

export interface DiscoveryQueueInput {
  title: string
  author: string
  sourceUrl: string
  origin: DiscoveryQueueItem['origin']
  separateJob?: boolean
  trackerRow?: GenerateEpubInput['trackerRow']
}

export interface JobProgress {
  current: number
  total: number
  message: string
}
