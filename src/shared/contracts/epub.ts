import type { EpubImageMediaType } from '../constants'

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
