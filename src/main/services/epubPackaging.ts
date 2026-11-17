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
}

export interface EpubPackagingResult {
  outputPath: string
  outputPaths: EpubOutputRecord[]
  overwroteExistingFile: boolean
}

export type EpubPackagingProgress = EpubMergeProgress & {
  publishedOutput?: EpubOutputRecord
}
