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
