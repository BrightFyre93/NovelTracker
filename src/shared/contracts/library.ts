import type { Result } from './common'

export type LibraryFolderState =
  'Completed' | 'Downloaded' | 'Sent' | 'Old' | 'Old Completed'

export type LibraryFileFormat = 'EPUB' | 'AZW3'

export type CoverageConfidence =
  'extracted-toc' | 'filename' | 'user-corrected' | 'unknown'

export interface LibraryFileCorrection {
  novelTitle?: string
  chapterNumbers?: number[]
}

export interface LibraryPossibleMove {
  newFilename: string
  newFileId: string
  candidates: Array<{
    previousFilename: string
    correction: LibraryFileCorrection
  }>
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
  sourceUrl?: string
  /** Stable id of this EPUB file (the sidecar file id), used with volumeIndex to follow moves. */
  stableBookId?: string
  volumeIndex?: number
  author: string
  language: string
  chapterTitles: string[]
  chapterTitleKeys?: string[]
  chapterNumbers: number[]
  filenameRange: { start: number; end: number } | null
  coverageConfidence: CoverageConfidence
  coverPath: string | null
  inspectionError: string
}

export interface DownloadedNovelMatch {
  novelName: string
  sourceUrl: string
  localPaths: string[]
}

export interface DownloadedNovelLookupResult {
  url: string
  extractedName: string
  matchType: 'url' | 'name' | null
  matches: DownloadedNovelMatch[]
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
    reusedFileIds?: string[]
    scannedFolders?: LibraryFolderState[]
    contentChanged?: boolean
    possibleMoves?: LibraryPossibleMove[]
    scanStartedAt?: string
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
    duplicateNumberCount: number
    unverifiedCount: number
    rangeMismatchCount: number
  }
}

export interface LibraryNovelSearchPage {
  total: number
  offset: number
  items: LibraryNovelSummary[]
  selectedNovel: LibraryNovelSummary | null
}

export interface LibraryFileListItem {
  id: string
  filename: string
  folderState: LibraryFolderState
  format: LibraryFileFormat
  coverage: string
}

export interface LibraryFileSearchPage {
  total: number
  offset: number
  items: LibraryFileListItem[]
}

export interface LibraryIndexOverview {
  libraryRoot: string
  scannedAt: string
  fileCount: number
  scanErrors: number
  scanSummary?: LibraryIndex['scanSummary']
  possibleMoves?: LibraryPossibleMove[]
}

export interface LibraryIndexSummary extends LibraryIndexOverview {
  novels: LibraryNovelSummary[]
}

export interface LibraryFileCorrectionResult {
  index: LibraryIndexOverview
  novel: LibraryNovelSummary
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
  conflictingChapterTitles: string[]
  firstChapter: number | null
  lastChapter: number | null
}

export interface EpubRepairResult {
  outputPath: string
  outputBytes: number
  repairedWebpImages: number
  upscaledCover: boolean
  fixedMimetype: boolean
}

export interface EpubRepairProgress {
  stage:
    | 'checking'
    | 'converting-images'
    | 'rewriting'
    | 'validating'
    | 'saving'
    | 'complete'
  percentage: number
  message: string
}

export interface EpubMergeProgress {
  stage:
    | 'reading'
    | 'extracting'
    | 'merging'
    | 'packaging'
    | 'validating'
    | 'saving'
    | 'complete'
    | 'cancelled'
    | 'failed'
  percentage: number
  message: string
}

export type LibraryEpubMergeResponse =
  Result<LibraryEpubMergeResult> | { ok: false; cancelled: true }

export type LibraryOperationKind = 'merge-epubs' | 'repair-epub'

export type LibraryOperationStatus =
  'running' | 'completed' | 'failed' | 'interrupted'

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

export type EpubRepairResponse =
  Result<EpubRepairResult> | { ok: false; cancelled: true }
