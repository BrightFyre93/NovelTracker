import { DEFAULT_EPUB_CSS } from './defaultEpubCss'

export { DEFAULT_EPUB_CSS }

export const DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS = 2
export const MIN_SIMULTANEOUS_DOWNLOADS = 1
export const MAX_SIMULTANEOUS_DOWNLOADS = 5

export const DEFAULT_DISCOVERY_FRESHNESS_HOURS = 24
export const MIN_DISCOVERY_FRESHNESS_HOURS = 1
export const MAX_DISCOVERY_FRESHNESS_HOURS = 720

export const MAX_NOVEL_DESCRIPTION_LENGTH = 20_000
export const MAX_SELECTED_CHAPTERS = 10_000
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

export const LIBRARY_FOLDERS = ['Completed', 'Downloaded', 'Sent', 'Old'] as const

export const MAX_ACTIVE_DISCOVERIES = 2
export const HTTP_REQUEST_TIMEOUT_MS = 20_000
export const BROWSER_NAVIGATION_TIMEOUT_MS = 45_000
export const HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_NOVELFULL_CATALOG_PAGES = 200
export const MAX_TIMER_DELAY_MS = 2_147_483_647
export const DEFAULT_DOMAIN_REQUEST_DELAY_MS = 250
export const DOMAIN_REQUEST_DELAYS_MS: Readonly<Record<string, number>> = {
  'novelfull.com': 250,
  'novelfull.net': 500
}
export const HTTP_IMAGE_ACCEPT_HEADER = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
export const APP_USER_AGENT = 'NovelTrackerEPUB/1.0'
export const NOVELFULL_HOSTS = new Set(['novelfull.com', 'novelfull.net'])
export const CHAPTER_LABEL_PATTERN = /\b(chapter|episode|part|prologue|epilogue|volume)\b|^\s*#?\s*\d+(?:\.\d+)?\s*$/i
export const CHAPTER_URL_PATTERN = /(?:chapter|episode|part|prologue|epilogue)(?:[-_./]|%20)/i
export const BLOCKED_PAGE_PATTERN = /\b(captcha|verify you are human|access denied|403 forbidden|checking your browser)\b/i
export const BROWSER_PROFILE_DIRECTORY_NAME = 'browser-session'
export const EPUB_MIMETYPE = 'application/epub+zip'
export const QUEUE_SELECTION_SAVE_DEBOUNCE_MS = 250

export const VERIFIED_COVERAGE = new Set(['extracted-toc', 'user-corrected'])
