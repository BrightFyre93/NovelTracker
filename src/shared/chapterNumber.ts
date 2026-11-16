const CHAPTER_NUMBER_PATTERN =
  /\b(?:chapter|ch\.?|episode|part)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i
const LEADING_CHAPTER_NUMBER_PATTERN = /^\s*#?\s*(\d+(?:\.\d+)?)(?=\s|$|[:.-])/
const URL_CHAPTER_NUMBER_PATTERN = /(?:chapter|ch|episode|part)[-_/ ]*(\d+(?:\.\d+)?)/i

export function parseChapterNumber(value: string, source: 'title' | 'url' = 'title'): number | null {
  const candidate = source === 'url' ? urlPath(value) : value
  const match = source === 'url'
    ? candidate.match(URL_CHAPTER_NUMBER_PATTERN)
    : candidate.match(CHAPTER_NUMBER_PATTERN) ?? candidate.match(LEADING_CHAPTER_NUMBER_PATTERN)
  if (match) return Number(match[1])
  if (source === 'title' && /\bprologue\b/i.test(candidate)) return 0
  return null
}

function urlPath(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return value
  }
}
