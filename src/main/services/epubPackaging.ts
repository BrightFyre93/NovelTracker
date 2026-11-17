import type {
  ChapterLink,
  EpubOutputOptions,
  EpubMergeProgress,
  EpubNovelMetadata
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
  includeCover: boolean
  metadata: EpubNovelMetadata
}

export interface EpubPackagingResult {
  outputPath: string
  overwroteExistingFile: boolean
}

export type EpubPackagingProgress = EpubMergeProgress
