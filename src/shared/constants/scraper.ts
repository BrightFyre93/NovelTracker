export const MAX_NOVEL_DESCRIPTION_LENGTH = 20_000

export const HTTP_REQUEST_TIMEOUT_MS = 20_000

export const BROWSER_NAVIGATION_TIMEOUT_MS = 45_000

export const HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export const MAX_NOVELFULL_CATALOG_PAGES = 200

export const MAX_TIMER_DELAY_MS = 2_147_483_647

export const MAX_GENERIC_DISCOVERY_PAGES = 100

export const MAX_ACTIVE_REQUESTS_PER_DOMAIN = 2

export const DEFAULT_HTTP_429_RETRY_DELAY_MS = 30_000

export const HTTP_IMAGE_ACCEPT_HEADER =
  'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'

export const APP_USER_AGENT = 'NovelTrackerEPUB/1.0'

export const NOVELFULL_HOSTS = new Set(['novelfull.com', 'novelfull.net'])

export const CHAPTER_LABEL_PATTERN =
  /\b(chapter|episode|part|prologue|epilogue|volume)\b|^\s*#?\s*\d+(?:\.\d+)?\s*$/i

export const CHAPTER_URL_PATTERN =
  /(?:chapter|episode|part|prologue|epilogue)(?:[-_./]|%20)/i

export const BLOCKED_PAGE_PATTERN =
  /\b(captcha|verify you are human|access denied|403 forbidden|checking your browser)\b/i

export const BROWSER_PROFILE_DIRECTORY_NAME = 'browser-session'
