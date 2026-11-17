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
  detectedLanguage?: string
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

export type EpubImageOutputFormat = 'jpeg' | 'png' | 'original'

export interface EpubOutputOptions {
  css: string
  language: string
  filenameTemplate: string
  identifierSeed: string
  includeNovelInfoPage: boolean
  includeChapterListPage: boolean
  skipImages: boolean
  compressImages: boolean
  maxImageDimension: number
  imageFormat: EpubImageOutputFormat
  coverJpegOnly: boolean
  flattenAnimatedImages: boolean
  includeImageAttribution: boolean
  maxChaptersPerEpub: number
}

export type EpubOutputPreferences = Omit<
  EpubOutputOptions,
  'css' | 'language' | 'identifierSeed'
>

export type ChapterInlineNode =
  | { type: 'text'; text: string }
  | { type: 'emphasis'; children: ChapterInlineNode[] }
  | { type: 'strong'; children: ChapterInlineNode[] }
  | { type: 'link'; href: string; children: ChapterInlineNode[] }
  | { type: 'break' }

export type ChapterContentBlock =
  | { type: 'paragraph'; text: string; inline?: ChapterInlineNode[] }
  | { type: 'heading'; level: 2 | 3 | 4; text: string; inline?: ChapterInlineNode[] }
  | { type: 'blockquote'; text: string; inline?: ChapterInlineNode[] }
  | {
      type: 'list'
      ordered: boolean
      items: Array<{ text: string; inline?: ChapterInlineNode[] }>
    }
  | { type: 'scene-break' }
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
