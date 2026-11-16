export { DEFAULT_EPUB_CSS } from '../defaultEpubCss'

export const MAX_EPUB_CSS_LENGTH = 100_000

export const MAX_EPUB_INPUT_BYTES = 256 * 1024 * 1024

export const MAX_EPUB_MERGE_ENTRY_BYTES = 16 * 1024 * 1024

export const MAX_EPUB_MERGE_TEXT_BYTES = 128 * 1024 * 1024

export const MAX_EPUB_MERGED_CHAPTERS = 20_000

export const MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024

export const MAX_EPUB_ZIP_ENTRIES = 50_000

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export const MAX_CHAPTER_IMAGE_BYTES = 16 * 1024 * 1024

export const MAX_CHAPTER_IMAGES = 24

export const MAX_TOTAL_EPUB_IMAGE_BYTES = 128 * 1024 * 1024

export const EPUB_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
} as const

export type EpubImageMediaType = keyof typeof EPUB_IMAGE_TYPES

export const EPUB_MIMETYPE = 'application/epub+zip'
