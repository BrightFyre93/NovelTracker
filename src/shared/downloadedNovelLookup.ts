import { normalizeNovelTitleForMatching } from './novelTitle'

const GENERIC_PATH_SEGMENTS = new Set([
  'novel', 'novels', 'book', 'books', 'story', 'stories', 'read', 'chapter',
  'chapters', 'chapter-list', 'index', 'index.html', 'index.php'
])

export function normalizeNovelSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null
    }
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
    url.hostname = url.hostname.toLocaleLowerCase()
    return url.href
  } catch {
    return null
  }
}

export function extractNovelNameFromUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    const segments = url.pathname.split('/').filter(Boolean).reverse()
    let slug = segments.find((segment) => {
      let decoded = segment
      try { decoded = decodeURIComponent(segment) } catch { /* retain encoded text */ }
      return !GENERIC_PATH_SEGMENTS.has(decoded.toLocaleLowerCase()) &&
        !/^\d+$/.test(decoded) &&
        !/^(?:chapter|chap|ch)[-_ ]*\d+(?:[-_ ].*)?$/i.test(decoded)
    })
    if (!slug) {
      for (const key of ['novel', 'book', 'title', 'name', 'slug']) {
        const candidate = url.searchParams.get(key)
        if (candidate) {
          slug = candidate
          break
        }
      }
    }
    if (!slug) return ''
    let decoded = slug
    try { decoded = decodeURIComponent(slug) } catch { /* retain encoded text */ }
    const name = decoded
      .replace(/\.(?:html?|php)$/i, '')
      .replace(/(?:[-_ ]+(?:chapter|chapters|read))[-_ ]*\d*$/i, '')
      .replace(/[-_+]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return name ? name.replace(/\b\w/g, (letter) => letter.toLocaleUpperCase()) : ''
  } catch {
    return ''
  }
}

export function normalizeNovelLookupName(value: string): string {
  return normalizeNovelTitleForMatching(value)
}
