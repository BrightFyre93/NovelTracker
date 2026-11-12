import { load } from 'cheerio'
import type { ChapterContent, ChapterLink, DiscoveryResult, JobProgress } from '../../shared/contracts'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_NOVELFULL_CATALOG_PAGES = 200
const USER_AGENT = 'NovelTrackerEPUB/0.1'
const CHAPTER_LABEL = /\b(chapter|episode|part|prologue|epilogue|volume)\b|^\s*#?\s*\d+(?:\.\d+)?\s*$/i
const CHAPTER_URL = /(?:chapter|episode|part|prologue|epilogue)(?:[-_./]|%20)/i
const BLOCKED_PAGE = /\b(captcha|verify you are human|access denied|403 forbidden|checking your browser)\b/i
const NOVELFULL_HOSTS = new Set(['novelfull.com', 'novelfull.net'])
const DEFAULT_DOMAIN_REQUEST_DELAY_MS = 250
const DOMAIN_REQUEST_DELAYS_MS: Readonly<Record<string, number>> = {
  'novelfull.com': 250,
  'novelfull.net': 500
}
const domainTails = new Map<string, Promise<void>>()
const domainNextRequestAt = new Map<string, number>()

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(`The page returned HTTP ${status}.`)
    this.name = 'HttpStatusError'
  }
}

export function validateHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS URLs without embedded credentials are supported.')
  }

  url.hash = ''
  return url.href
}

async function acquireDomainSlot(url: string, signal?: AbortSignal): Promise<() => void> {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  const requestDelayMs = DOMAIN_REQUEST_DELAYS_MS[hostname] ?? DEFAULT_DOMAIN_REQUEST_DELAY_MS
  const previous = domainTails.get(hostname) ?? Promise.resolve()
  let release!: () => void
  const hold = new Promise<void>((resolveHold) => {
    release = resolveHold
  })
  const tail = previous.then(() => hold)
  domainTails.set(hostname, tail)
  const removeTailWhenSettled = (): void => {
    if (domainTails.get(hostname) === tail) domainTails.delete(hostname)
  }
  void tail.then(removeTailWhenSettled, removeTailWhenSettled)

  let requestStarted = false
  try {
    if (signal) {
      await new Promise<void>((resolveTurn, rejectTurn) => {
        const abort = (): void => {
          signal.removeEventListener('abort', abort)
          rejectTurn(new Error('EPUB creation was cancelled.'))
        }
        signal.addEventListener('abort', abort, { once: true })
        previous.then(() => {
          signal.removeEventListener('abort', abort)
          resolveTurn()
        }, (error: unknown) => {
          signal.removeEventListener('abort', abort)
          rejectTurn(error)
        })
        if (signal.aborted) abort()
      })
    } else {
      await previous
    }
    const wait = Math.max(0, (domainNextRequestAt.get(hostname) ?? 0) - Date.now())
    if (wait > 0) {
      await new Promise<void>((resolveWait, rejectWait) => {
        let timer: ReturnType<typeof setTimeout>
        const abort = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          rejectWait(new Error('EPUB creation was cancelled.'))
        }
        timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolveWait()
        }, wait)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
    if (signal?.aborted) throw new Error('EPUB creation was cancelled.')
    requestStarted = true
    return () => {
      if (requestStarted) domainNextRequestAt.set(hostname, Date.now() + requestDelayMs)
      release()
    }
  } catch (error) {
    release()
    throw error
  }
}

async function fetchHtml(url: string, operationSignal?: AbortSignal): Promise<{ html: string; finalUrl: string }> {
  const releaseDomain = await acquireDomainSlot(url, operationSignal)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abortOperation = () => controller.abort()
  operationSignal?.addEventListener('abort', abortOperation, { once: true })

  try {
    if (operationSignal?.aborted) throw new Error('EPUB creation was cancelled.')
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT
      },
      redirect: 'follow',
      signal: controller.signal
    })

    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after')
      let retryAfterMs: number | null = null
      if (retryAfter) {
        const seconds = Number(retryAfter)
        const retryDate = Date.parse(retryAfter)
        if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000)) {
          retryAfterMs = seconds * 1000
        }
        else if (Number.isFinite(retryDate)) retryAfterMs = Math.max(0, retryDate - Date.now())
      }
      throw new HttpStatusError(response.status, retryAfterMs)
    }

    const finalUrl = validateHttpUrl(response.url)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !/html|xhtml/i.test(contentType)) {
      throw new Error('The URL did not return an HTML page.')
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('The page is too large to process safely.')
    }

    if (!response.body) {
      throw new Error('The page response had no readable content.')
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalLength = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalLength += value.byteLength
      if (totalLength > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('The page is too large to process safely.')
      }
      chunks.push(value)
    }

    const bytes = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return { html: new TextDecoder().decode(bytes), finalUrl }
  } catch (error) {
    if (operationSignal?.aborted) throw new Error('EPUB creation was cancelled.')
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('The page request timed out.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    operationSignal?.removeEventListener('abort', abortOperation)
    releaseDomain()
  }
}

function documentTitle($: ReturnType<typeof load>): string {
  return (
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim() ||
    $('title').first().text().trim() ||
    ''
  )
}

function isNovelFullUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '')
    return NOVELFULL_HOSTS.has(hostname)
  } catch {
    return false
  }
}

interface NovelFullCatalogPage {
  title: string
  author: string
  chapters: ChapterLink[]
  pageCount: number
}

export function parseNovelFullCatalogPage(html: string, pageUrl: string): NovelFullCatalogPage {
  const url = validateHttpUrl(pageUrl)
  const $ = load(html)
  const pageText = $('body').text().replace(/\s+/g, ' ').trim()
  if (BLOCKED_PAGE.test(`${documentTitle($)} ${pageText.slice(0, 1000)}`)) {
    throw new Error('The source requires manual verification; discovery was not continued.')
  }
  const title =
    $('.books .desc h3.title, .m-desc h1.tit').first().text().replace(/\s+/g, ' ').trim() ||
    $('h3.title, h1.tit').first().text().replace(/\s+/g, ' ').trim()
  const authorHeading = $('h3').filter((_, element) => /^author\s*:?$/i.test($(element).text().trim())).first()
  const authorLinks = authorHeading.length
    ? authorHeading.parent().find('a[href*="/author/"]')
    : $('a[href*="/author/"]')
  const authors = new Set<string>()
  authorLinks.each((_, element) => {
    const author = $(element).text().replace(/\s+/g, ' ').trim()
    if (author) authors.add(author)
  })

  const chaptersByUrl = new Map<string, ChapterLink>()
  $('ul.list-chapter, #list-chapter ul#idData, #list-chapter ul.ul-list5').each((listIndex, list) => {
    if ($(list).closest('.l-chapters').length > 0) return
    $(list).find('a[href]').each((linkIndex, element) => {
      const label = $(element).text().replace(/\s+/g, ' ').trim()
      const href = $(element).attr('href')
      if (!href || !label) return

      try {
        const chapterUrl = new URL(href, url)
        chapterUrl.hash = ''
        const normalizedUrl = validateHttpUrl(chapterUrl.href)
        if (!chaptersByUrl.has(normalizedUrl)) {
          chaptersByUrl.set(normalizedUrl, {
            id: `chapter-${listIndex}-${linkIndex}`,
            title: label,
            url: normalizedUrl
          })
        }
      } catch {
        return
      }
    })
  })

  const base = new URL(url)
  let pageCount = 1
  $('.pagination-sm a[href], #list-chapter .page a[href]').each((_, element) => {
    try {
      const link = new URL($(element).attr('href')!, url)
      const page = Number(link.searchParams.get('page') ?? 1)
      if (link.origin === base.origin && link.pathname === base.pathname && Number.isInteger(page) && page > pageCount) {
        pageCount = page
      }
    } catch {
      return
    }
  })

  return { title, author: [...authors].join(', '), chapters: [...chaptersByUrl.values()], pageCount }
}

function chapterLinksFromHtml(html: string, pageUrl: string): ChapterLink[] {
  const $ = load(html)
  const baseUrl = $('base[href]').attr('href')
    ? new URL($('base[href]').attr('href')!, pageUrl).href
    : pageUrl
  const byUrl = new Map<string, ChapterLink>()

  $('a[href]').each((index, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim()
    const href = $(element).attr('href')
    if (
      !href ||
      !label ||
      !CHAPTER_LABEL.test(label) ||
      /^(?:previous|next)(?:\s+chapter)?\b|^(?:first|last)\s+chapter\b/i.test(label)
    ) return

    let url: string
    try {
      const resolved = new URL(href, baseUrl)
      resolved.hash = ''
      url = validateHttpUrl(resolved.href)
    } catch {
      return
    }

    if (url === pageUrl || byUrl.has(url)) return
    byUrl.set(url, {
      id: `chapter-${index + 1}`,
      title: label,
      url
    })
  })

  return [...byUrl.values()]
}

export function discoverFromHtml(html: string, pageUrl: string): DiscoveryResult {
  const url = validateHttpUrl(pageUrl)
  const $ = load(html)
  const title = documentTitle($)
  const author = $('meta[name="author"]').attr('content')?.trim() ?? ''
  const pageText = $('body').text().replace(/\s+/g, ' ').trim()
  if (BLOCKED_PAGE.test(`${title} ${pageText.slice(0, 1000)}`)) {
    throw new Error('The source requires manual verification; discovery was not continued.')
  }
  const chapters = chapterLinksFromHtml(html, url)

  if (chapters.length > 0) {
    return { sourceUrl: url, title, author, parserName: 'Generic HTML', chapters }
  }

  const novelFullChapterTitle = isNovelFullUrl(url)
    ? $('.chapter-title').first().text().replace(/\s+/g, ' ').trim() ||
      $('h1, h2, h3')
        .toArray()
        .map((element) => $(element).text().replace(/\s+/g, ' ').trim())
        .find((heading) => CHAPTER_LABEL.test(heading))
    : ''
  const heading = novelFullChapterTitle || $('h1, h2').first().text().trim()
  const chapterPage =
    CHAPTER_LABEL.test(heading) ||
    CHAPTER_LABEL.test(title) ||
    CHAPTER_URL.test(new URL(url).pathname)

  if (pageText.length >= 200 && chapterPage) {
    const directTitle = heading || title || 'Chapter 1'
    return {
      sourceUrl: url,
      title,
      author,
      parserName: 'Generic HTML',
      chapters: [{ id: 'chapter-1', title: directTitle, url }]
    }
  }

  throw new Error('No chapter links were found. Use a chapter-list page or a chapter page with a detectable chapter title.')
}

async function discoverNovelFullChapters(
  value: string,
  onProgress?: (progress: JobProgress) => void
): Promise<DiscoveryResult> {
  const firstPageUrl = new URL(value)
  firstPageUrl.searchParams.delete('page')
  const catalogUrl = validateHttpUrl(firstPageUrl.href)
  onProgress?.({ current: 0, total: 0, message: 'Loading NovelFull chapter index…' })

  const firstResponse = await fetchHtml(catalogUrl)
  const firstPage = parseNovelFullCatalogPage(firstResponse.html, firstResponse.finalUrl)
  if (firstPage.chapters.length === 0) {
    throw new Error('No chapters were found in NovelFull’s chapter list.')
  }
  if (firstPage.pageCount > MAX_NOVELFULL_CATALOG_PAGES) {
    throw new Error(`NovelFull reported more than ${MAX_NOVELFULL_CATALOG_PAGES} chapter-list pages.`)
  }

  const chaptersByUrl = new Map<string, ChapterLink>()
  for (const chapter of firstPage.chapters) chaptersByUrl.set(chapter.url, chapter)
  onProgress?.({
    current: 1,
    total: firstPage.pageCount,
    message: `Reading NovelFull chapter list page 1 of ${firstPage.pageCount}…`
  })

  for (let pageNumber = 2; pageNumber <= firstPage.pageCount; pageNumber += 1) {
    const pageUrl = new URL(catalogUrl)
    pageUrl.searchParams.set('page', String(pageNumber))
    const response = await fetchHtml(pageUrl.href)
    const page = parseNovelFullCatalogPage(response.html, response.finalUrl)
    if (page.chapters.length === 0) {
      throw new Error(`No chapters were found on NovelFull chapter-list page ${pageNumber}.`)
    }
    for (const chapter of page.chapters) {
      if (!chaptersByUrl.has(chapter.url)) chaptersByUrl.set(chapter.url, chapter)
    }
    onProgress?.({
      current: pageNumber,
      total: firstPage.pageCount,
      message: `Reading NovelFull chapter list page ${pageNumber} of ${firstPage.pageCount}…`
    })
  }

  const chapters = [...chaptersByUrl.values()].map((chapter, index) => ({
    ...chapter,
    id: `chapter-${index + 1}`
  }))
  const sourceUrl = new URL(firstResponse.finalUrl)
  sourceUrl.searchParams.delete('page')
  return {
    sourceUrl: sourceUrl.href,
    title: firstPage.title,
    author: firstPage.author,
    parserName: 'NovelFull',
    chapters
  }
}

export async function discoverChapters(
  value: unknown,
  onProgress?: (progress: JobProgress) => void
): Promise<DiscoveryResult> {
  const url = validateHttpUrl(value)
  if (isNovelFullUrl(url) && !CHAPTER_URL.test(new URL(url).pathname)) {
    return discoverNovelFullChapters(url, onProgress)
  }
  const { html, finalUrl } = await fetchHtml(url)
  return discoverFromHtml(html, finalUrl)
}

function chapterRoot($: ReturnType<typeof load>) {
  const selectors = [
    '.chapter-c',
    '.chapter-content',
    '#chapter-content',
    '.reading-content',
    '.entry-content',
    '.text-left',
    'article',
    'main',
    '#content',
    '.content'
  ]

  for (const selector of selectors) {
    const candidate = $(selector).first()
    if (candidate.text().trim().length >= 40) return candidate
  }

  return $('body')
}

function normalizeParagraph(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function extractChapterFromHtml(html: string, pageUrl: string, fallbackTitle: string): ChapterContent {
  const url = validateHttpUrl(pageUrl)
  const $ = load(html)
  const root = chapterRoot($)
  root.find('script, style, noscript, nav, header, footer, aside, iframe, form, .ads, .ad, .advertisement').remove()

  const text = root.text().replace(/\s+/g, ' ').trim()
  const pageTitle = documentTitle($)
  if (BLOCKED_PAGE.test(`${pageTitle} ${text.slice(0, 1000)}`)) {
    throw new Error('The source requires manual verification; this page was not saved as chapter content.')
  }
  if (text.length < 40) {
    throw new Error('No readable chapter content was found on this page.')
  }

  const paragraphs = root
    .find('p')
    .toArray()
    .map((paragraph) => normalizeParagraph($(paragraph).text()))
    .filter((paragraph) => paragraph.length > 0)

  const readableParagraphs = paragraphs.length > 0 ? paragraphs : [text]
  const novelFullChapterTitle = isNovelFullUrl(url)
    ? $('.chapter-title').first().text().replace(/\s+/g, ' ').trim() ||
      $('h1, h2, h3')
        .toArray()
        .map((heading) => $(heading).text().replace(/\s+/g, ' ').trim())
        .find((heading) => CHAPTER_LABEL.test(heading))
    : ''
  return {
    title: novelFullChapterTitle || $('h1').first().text().trim() || pageTitle || fallbackTitle,
    url,
    paragraphs: readableParagraphs
  }
}

export async function fetchChapterContent(chapter: ChapterLink, signal?: AbortSignal): Promise<ChapterContent> {
  const url = validateHttpUrl(chapter.url)
  const { html, finalUrl } = await fetchHtml(url, signal)
  return extractChapterFromHtml(html, finalUrl, chapter.title)
}
