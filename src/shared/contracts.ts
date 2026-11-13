import type { EpubImageMediaType } from './epubImages'

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
  maxSimultaneousDownloads: number
  epubCss: string
  appTheme: 'light' | 'dark'
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
  chapters: QueueChapter[]
  discoveryChanges: string
  recommendationSummary: string
  overlapAllowed: boolean
  includeOverlap: boolean
  overlapCount: number
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

export interface DiscoveryQueueInput {
  title: string
  author: string
  sourceUrl: string
  origin: DiscoveryQueueItem['origin']
  trackerRow?: GenerateEpubInput['trackerRow']
}

export type LibraryFolderState = 'Completed' | 'Downloaded' | 'Sent' | 'Old'
export type LibraryFileFormat = 'EPUB' | 'PDF'
export type PdfClassification = 'individual-chapter' | 'compiled-candidate' | 'unknown'
export type CoverageConfidence = 'extracted-toc' | 'extracted-text' | 'filename' | 'user-corrected' | 'unknown'

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
  pageCount: number | null
  chapterTitles: string[]
  chapterNumbers: number[]
  chapterLocations: Array<{ chapter: number; page: number; title: string }>
  filenameRange: { start: number; end: number } | null
  coverageConfidence: CoverageConfidence
  pdfClassification: PdfClassification | null
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

export interface JobProgress {
  current: number
  total: number
  message: string
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

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
  chooseLibraryRoot(): Promise<string | null>
  chooseTrackerCsv(): Promise<string | null>
  getTrackerNovels(): Promise<Result<TrackerNovel[]>>
  getDownloadHistory(): Promise<DownloadHistoryEntry[]>
  getDiscoveryQueue(): Promise<DiscoveryQueueItem[]>
  addDiscoveryQueueItems(items: DiscoveryQueueInput[]): Promise<Result<DiscoveryQueueItem[]>>
  retryDiscoveryQueueItem(id: string): Promise<Result<void>>
  retryDiscoveryQueueItemWithBrowser(id: string): Promise<Result<void>>
  refreshDiscoveryQueueItem(id: string): Promise<Result<void>>
  acceptQueueRecommendations(id: string, includeOverlap: boolean, overlapCount: number): Promise<Result<void>>
  enqueueEpub(input: GenerateEpubInput, queueItemId?: string): Promise<Result<QueuedEpubJob>>
  retryEpub(id: string): Promise<Result<void>>
  pauseEpub(id: string): Promise<Result<void>>
  resumeEpub(id: string): Promise<Result<void>>
  cancelEpub(id: string): Promise<Result<void>>
  moveQueuedEpub(id: string, direction: 'up' | 'down'): Promise<Result<void>>
  removeDiscoveryQueueItem(id: string): Promise<Result<void>>
  clearDiscoveryQueue(): Promise<Result<void>>
  updateDiscoveryQueueSelection(id: string, selectedChapterUrls: string[]): Promise<Result<void>>
  updateDownloadConcurrency(maxSimultaneousDownloads: number): Promise<Result<AppSettings>>
  onDiscoveryQueueUpdate(listener: (items: DiscoveryQueueItem[]) => void): () => void
  getLibraryIndex(): Promise<LibraryIndex | null>
  scanLibrary(): Promise<Result<LibraryIndex>>
  cancelLibraryScan(): Promise<void>
  correctLibraryFile(fileId: string, correction: LibraryFileCorrection): Promise<Result<LibraryIndex>>
  openLibraryPath(path: string, reveal: boolean): Promise<Result<void>>
  onLibraryProgress(listener: (progress: LibraryProgress) => void): () => void
}
