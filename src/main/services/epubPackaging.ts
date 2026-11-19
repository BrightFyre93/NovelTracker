import type {
  ChapterLink,
  EpubOutputOptions,
  EpubMergeProgress,
  EpubNovelMetadata,
  EpubOutputRecord
} from '../../shared/contracts'

export interface EpubPackagingInput {
  dataDirectory: string
  queueItemId: string
  chapters: Array<Pick<ChapterLink, 'title' | 'url'>>
  outputDirectory: string
  title: string
  author: string
  filename: string
  outputOptions: EpubOutputOptions
  completedOutputs?: EpubOutputRecord[]
  includeCover: boolean
  metadata: EpubNovelMetadata
  appVersion?: string
  volumeIndex?: number
  volumeCount?: number
  /** Overrides the novel id derived from outputOptions.identifierSeed. */
  novelId?: string
  /** Overrides the key (default: first chapter number) of the file id. */
  fileIdKey?: string
  /** When false, the chapters are always written to exactly one EPUB. */
  allowVolumeSplit?: boolean
}

export interface EpubPackagingResult {
  outputPath: string
  outputPaths: EpubOutputRecord[]
  overwroteExistingFile: boolean
}

export type EpubPackagingProgress = EpubMergeProgress & {
  publishedOutput?: EpubOutputRecord
}
