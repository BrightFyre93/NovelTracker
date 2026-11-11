export interface ChapterLink {
  id: string
  title: string
  url: string
}

export interface DiscoveryResult {
  sourceUrl: string
  title: string
  author: string
  parserName: string
  chapters: ChapterLink[]
}

export interface ChapterContent {
  title: string
  url: string
  paragraphs: string[]
}

export interface GenerateEpubInput {
  title: string
  author: string
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

export type DownloadJobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface DownloadHistoryEntry {
  id: string
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

export interface GenerateEpubResult {
  outputPath: string
  overwroteExistingFile: boolean
}

export interface NovelTrackerApi {
  discover(url: string): Promise<Result<DiscoveryResult>>
  chooseOutputDirectory(): Promise<string | null>
  generateEpub(input: GenerateEpubInput): Promise<Result<GenerateEpubResult>>
  getSettings(): Promise<AppSettings>
  chooseLibraryRoot(): Promise<string | null>
  chooseTrackerCsv(): Promise<string | null>
  getTrackerNovels(): Promise<Result<TrackerNovel[]>>
  getDownloadHistory(): Promise<DownloadHistoryEntry[]>
  getLibraryIndex(): Promise<LibraryIndex | null>
  scanLibrary(): Promise<Result<LibraryIndex>>
  cancelLibraryScan(): Promise<void>
  cancelEpubGeneration(): Promise<void>
  correctLibraryFile(fileId: string, correction: LibraryFileCorrection): Promise<Result<LibraryIndex>>
  openLibraryPath(path: string, reveal: boolean): Promise<Result<void>>
  onLibraryProgress(listener: (progress: LibraryProgress) => void): () => void
  onProgress(listener: (progress: JobProgress) => void): () => void
}
