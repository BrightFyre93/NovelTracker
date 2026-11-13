import type { EpubImageMediaType } from './constants'

export interface ChapterLink {
  id: string
  title: string
  url: string
}

export interface DiscoveryResult {
  sourceUrl: string
  title: string
  author: string
  description: string
  coverUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  parserName: string
  chapters: ChapterLink[]
}

export interface ChapterImage {
  sourceUrl: string
  mediaType: EpubImageMediaType
  dataBase64: string
}

export interface EpubNovelMetadata {
  description: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  sourceUrl: string
  cover?: ChapterImage
}

export type ChapterContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'image'; imageIndex: number; alt: string }

export interface ChapterContent {
  title: string
  url: string
  paragraphs: string[]
  images?: ChapterImage[]
  blocks?: ChapterContentBlock[]
}

export interface GenerateEpubInput {
  title: string
  author: string
  description?: string
  coverUrl?: string
  alternativeNames?: string[]
  genres?: string[]
  source?: string
  novelStatus?: string
  language: string
  filename?: string
  sourceUrl?: string
  outputDirectory: string
  chapters: ChapterLink[]
  trackerRow?: {
    stableId: string
    rowNumber: number
    title: string
    alternativeNames?: string
    csvPath: string
  }
}

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

export interface AppSettings {
  libraryRoot: string
  trackerCsvPath: string
  outputDirectory: string
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
  maxSimultaneousDownloads: number
  maxSimultaneousChaptersPerNovel: number
  discoveryFreshnessHours: number
  siteExtractionPreferences: SiteExtractionPreference[]
  epubCss: string
  appTheme: 'light' | 'dark'
}

export type SiteExtractionMode = 'automatic' | 'generic-html'

export interface SiteExtractionPreference {
  hostname: string
  mode: SiteExtractionMode
}

export interface BrowserSessionInfo {
  title: string
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
  | 'failed'
  | 'cancelled'

export type ChapterArchiveStatus = 'confirmed' | 'probable' | 'uncertain' | 'missing'

export interface QueueChapter extends ChapterLink {
  selected: boolean
  archiveStatus: ChapterArchiveStatus
  archiveSources: string[]
  chapterNumber: number | null
  archiveGap: boolean
  recommended: boolean
  deliberateOverlap: boolean
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

export interface FailedQueueChapter {
  url: string
  title: string
  error: string
}

export interface QueueChapterSummary {
  total: number
  selected: number
  recommended: number
  deliberateOverlap: number
  hasUncertainArchiveChapters: boolean
  latestTitle: string
}

export interface DiscoveryQueueItem {
  id: string
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
  trackerRow: GenerateEpubInput['trackerRow'] | null
  status: DiscoveryQueueStatus
  parserName: string
  siteExtractionMode?: SiteExtractionMode
  chapters: QueueChapter[]
  chapterSummary: QueueChapterSummary
  targetOutputPath: string
  discoveryChanges: string
  recommendationSummary: string
  overlapAllowed: boolean
  includeOverlap: boolean
  overlapCount: number
  repackageOnly: boolean
  downloadOptions: QueueDownloadOptions | null
  queuedAt: string
  completedChapterUrls: string[]
  failedChapters: FailedQueueChapter[]
  outputPath: string
  downloadHistoryId: string
  progress: JobProgress | null
  error: string
  discoveredAt: string
  updatedAt: string
}

export type DiscoveryQueueItemSummary = Omit<DiscoveryQueueItem, 'chapters' | 'completedChapterUrls'> & {
  failedChapterCount: number
}

export interface DiscoveryQueueInput {
  title: string
  author: string
  sourceUrl: string
  origin: DiscoveryQueueItem['origin']
  trackerRow?: GenerateEpubInput['trackerRow']
}

export type LibraryFolderState = 'Completed' | 'Downloaded' | 'Sent' | 'Old' | 'Old Completed'
export type LibraryFileFormat = 'EPUB' | 'AZW3'
export type CoverageConfidence = 'extracted-toc' | 'filename' | 'user-corrected' | 'unknown'

export interface LibraryFileCorrection {
  novelTitle?: string
  chapterNumbers?: number[]
}

export interface LibraryFileRecord {
  id: string
  path: string
  relativePath: string
  filename: string
  format: LibraryFileFormat
  folderState: LibraryFolderState
  size: number
  modifiedAt: string
  novelTitle: string
  author: string
  language: string
  chapterTitles: string[]
  chapterNumbers: number[]
  filenameRange: { start: number; end: number } | null
  coverageConfidence: CoverageConfidence
  coverPath: string | null
  inspectionError: string
}

export interface LibraryIndex {
  schemaVersion: 1
  libraryRoot: string
  scannedAt: string
  files: LibraryFileRecord[]
  corrections: Record<string, LibraryFileCorrection>
  scanErrors: number
  scanSummary?: {
    reusedFiles: number
    inspectedFiles: number
  }
}

export interface LibraryFileSummary {
  id: string
  filename: string
}

export interface LibraryNovelSummary {
  key: string
  title: string
  files: LibraryFileSummary[]
  stateCounts: Record<LibraryFolderState, number>
  coverage: {
    gapCount: number
    overlapNumberCount: number
    unverifiedCount: number
    rangeMismatchCount: number
  }
}

export interface LibraryIndexSummary {
  libraryRoot: string
  scannedAt: string
  fileCount: number
  scanErrors: number
  scanSummary?: LibraryIndex['scanSummary']
  novels: LibraryNovelSummary[]
}

export interface LibraryProgress {
  stage: 'scan' | 'inspect' | 'save'
  current: number
  total: number
  discoveredFiles: number
  indexedFiles: number
  totalFiles: number
  message: string
}

export interface LibraryEpubMergeResult {
  outputPath: string
  chapterCount: number
  duplicateChapterCount: number
  conflictingChapterCount: number
  firstChapter: number | null
  lastChapter: number | null
}

export interface EbookConversionResult {
  outputPath: string
  outputBytes: number
}

export interface EpubRepairResult {
  outputPath: string
  outputBytes: number
  repairedWebpImages: number
  upscaledCover: boolean
  fixedMimetype: boolean
}

export interface EpubRepairProgress {
  stage: 'checking' | 'converting-images' | 'rewriting' | 'validating' | 'saving' | 'complete'
  percentage: number
  message: string
}

export interface EpubMergeProgress {
  stage: 'reading' | 'extracting' | 'merging' | 'packaging' | 'validating' | 'saving' | 'complete' | 'cancelled' | 'failed'
  percentage: number
  message: string
}

export interface JobProgress {
  current: number
  total: number
  message: string
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export type LibraryEpubMergeResponse =
  | Result<LibraryEpubMergeResult>
  | { ok: false; cancelled: true }

export type LibraryOperationKind = 'merge-epubs' | 'epub-to-azw3' | 'azw3-to-epub' | 'repair-epub'
export type LibraryOperationStatus = 'running' | 'completed' | 'failed' | 'interrupted'

export interface LibraryOperation {
  id: string
  kind: LibraryOperationKind
  status: LibraryOperationStatus
  inputFiles: string[]
  outputPath: string
  progress: number | null
  message: string
  error: string
  startedAt: string
  updatedAt: string
}

export type EbookConversionResponse =
  | Result<EbookConversionResult>
  | { ok: false; cancelled: true }

export type EpubRepairResponse =
  | Result<EpubRepairResult>
  | { ok: false; cancelled: true }

export interface NovelTrackerApi {
  discover(url: string): Promise<Result<DiscoveryResult>>
  openVerificationBrowser(url: string): Promise<Result<BrowserSessionInfo>>
  discoverWithBrowser(url: string): Promise<Result<DiscoveryResult>>
  cancelBrowserDiscovery(queueItemId?: string): Promise<void>
  clearBrowserSession(): Promise<Result<void>>
  chooseOutputDirectory(): Promise<string | null>
  getSettings(): Promise<AppSettings>
  updateEpubCss(css: string): Promise<Result<AppSettings>>
  updateAppTheme(theme: AppSettings['appTheme']): Promise<Result<AppSettings>>
  updateDiscoveryFreshnessHours(hours: number): Promise<Result<AppSettings>>
  chooseLibraryRoot(): Promise<string | null>
  chooseTrackerCsv(): Promise<string | null>
  getTrackerNovels(): Promise<Result<TrackerNovel[]>>
  getDownloadHistory(): Promise<DownloadHistoryEntry[]>
  getDiscoveryQueue(): Promise<DiscoveryQueueItemSummary[]>
  getDiscoveryQueueItem(id: string): Promise<Result<DiscoveryQueueItem>>
  addDiscoveryQueueItems(items: DiscoveryQueueInput[]): Promise<Result<DiscoveryQueueItem[]>>
  retryDiscoveryQueueItem(id: string): Promise<Result<void>>
  forceRetryDiscoveryQueueItem(id: string): Promise<Result<void>>
  retryDiscoveryQueueItemWithBrowser(id: string): Promise<Result<void>>
  refreshDiscoveryQueueItem(id: string): Promise<Result<void>>
  acceptQueueRecommendations(id: string, includeOverlap: boolean, overlapCount: number): Promise<Result<void>>
  enqueueEpub(input: GenerateEpubInput, queueItemId?: string): Promise<Result<QueuedEpubJob>>
  retryEpub(id: string): Promise<Result<void>>
  recoverEpubQueueItem(id: string): Promise<Result<void>>
  pauseEpub(id: string): Promise<Result<void>>
  resumeEpub(id: string): Promise<Result<void>>
  cancelEpub(id: string): Promise<Result<void>>
  moveQueuedEpub(id: string, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<Result<void>>
  removeDiscoveryQueueItem(id: string): Promise<Result<void>>
  clearDiscoveryQueue(): Promise<Result<void>>
  clearCompletedDiscoveryQueueItems(): Promise<Result<void>>
  updateDiscoveryQueueSelection(id: string, selectedChapterUrls: string[]): Promise<Result<void>>
  updateDownloadConcurrency(maxSimultaneousDownloads: number): Promise<Result<AppSettings>>
  updateChapterConcurrency(maxSimultaneousChaptersPerNovel: number): Promise<Result<AppSettings>>
  updateSiteExtractionPreferences(preferences: SiteExtractionPreference[]): Promise<Result<AppSettings>>
  updateLibraryScanOptions(scanOldFolder: boolean, scanOldCompletedFolder: boolean): Promise<Result<AppSettings>>
  repackageEpub(id: string): Promise<Result<void>>
  onDiscoveryQueueUpdate(listener: (items: DiscoveryQueueItemSummary[]) => void): () => void
  getLibraryIndexSummary(): Promise<LibraryIndexSummary | null>
  getLibraryNovelFiles(novelKey: string): Promise<Result<LibraryFileRecord[]>>
  getLibraryIndexBackupDate(): Promise<string | null>
  restoreLibraryIndexBackup(): Promise<Result<LibraryIndexSummary>>
  scanLibrary(forceRebuild?: boolean): Promise<Result<LibraryIndexSummary>>
  cancelLibraryScan(): Promise<void>
  correctLibraryFile(fileId: string, correction: LibraryFileCorrection): Promise<Result<LibraryIndexSummary>>
  mergeLibraryEpubs(fileIds: string[], filename: string): Promise<LibraryEpubMergeResponse>
  convertEpubToAzw3(inputPath: string): Promise<EbookConversionResponse>
  convertAzw3ToEpub(fileId: string): Promise<EbookConversionResponse>
  repairEpub(fileId: string): Promise<EpubRepairResponse>
  getLibraryOperations(): Promise<LibraryOperation[]>
  onLibraryOperationsUpdate(listener: (operations: LibraryOperation[]) => void): () => void
  onLibraryEpubMergeProgress(listener: (progress: EpubMergeProgress) => void): () => void
  openLibraryPath(path: string, reveal: boolean): Promise<Result<void>>
  onLibraryProgress(listener: (progress: LibraryProgress) => void): () => void
}
