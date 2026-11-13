import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { load } from 'cheerio'
import { isIP } from 'node:net'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterImage,
  ChapterLink,
  DiscoveryResult,
  JobProgress
} from '../../shared/contracts'
import { EPUB_IMAGE_TYPES, MAX_CHAPTER_IMAGE_BYTES, MAX_CHAPTER_IMAGES, MAX_IMAGE_BYTES, type EpubImageMediaType } from '../../shared/epubImages'

const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const IMAGE_ACCEPT_HEADER = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
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

function responseRetryAfter(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  const retryDate = Date.parse(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000)) return seconds * 1000
  return Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : null
}

function imageMediaType(data: Uint8Array): EpubImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) return 'image/png'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp'
  throw new Error('An image is not a supported JPEG, PNG, GIF, or WebP file.')
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 4) {
    const [first, second, third] = normalized.split('.').map(Number)
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && third === 113)
    )
  }
  if (isIP(normalized) === 6) {
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('::ffff:') ||
      /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    )
  }
  return false
}

async function validateImageHost(value: string, pageOrigin: string): Promise<void> {
  const url = new URL(value)
  if (url.origin === pageOrigin) return
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('An image URL points to a non-public host.')
  }

  let addresses: { address: string }[]
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new Error(`The image host could not be verified: ${error instanceof Error ? error.message : String(error)}.`)
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('An image URL points to a non-public host.')
  }
}

export async function fetchImageResource(
  value: unknown,
  sourceUrl: string,
  operationSignal?: AbortSignal
): Promise<ChapterImage> {
  const pageOrigin = new URL(validateHttpUrl(sourceUrl)).origin
  let url = validateHttpUrl(value)

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await validateImageHost(url, pageOrigin)
    const releaseDomain = await acquireDomainSlot(url, operationSignal)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const abortOperation = () => controller.abort()
    operationSignal?.addEventListener('abort', abortOperation, { once: true })
    try {
      if (operationSignal?.aborted) throw new Error('EPUB creation was cancelled.')
      const response = await fetch(url, {
        headers: { Accept: IMAGE_ACCEPT_HEADER, 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: controller.signal
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('The image redirect did not include a destination.')
        const redirectedUrl = validateHttpUrl(new URL(location, url).href)
        await validateImageHost(redirectedUrl, pageOrigin)
        if (redirects === 5) throw new Error('The image redirected too many times.')
        url = redirectedUrl
        continue
      }
      if (!response.ok) throw new HttpStatusError(response.status, responseRetryAfter(response))
      const finalUrl = validateHttpUrl(response.url || url)
      await validateImageHost(finalUrl, pageOrigin)
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (declaredLength > MAX_IMAGE_BYTES) throw new Error('An image exceeds the 4 MB size limit.')
      if (!response.body) throw new Error('The image response had no readable content.')

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let totalLength = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalLength += value.byteLength
        if (totalLength > MAX_IMAGE_BYTES) {
          await reader.cancel()
          throw new Error('An image exceeds the 4 MB size limit.')
        }
        chunks.push(value)
      }

      const data = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalLength)
      const mediaType = imageMediaType(data)
      if (!Object.prototype.hasOwnProperty.call(EPUB_IMAGE_TYPES, mediaType)) {
        throw new Error('An image uses an unsupported format.')
      }
      return { sourceUrl: finalUrl, mediaType, dataBase64: data.toString('base64') }
    } catch (error) {
      if (operationSignal?.aborted) throw new Error('EPUB creation was cancelled.')
      if (error instanceof Error && error.name === 'AbortError') throw new Error('The image request timed out.')
      throw error
    } finally {
      clearTimeout(timeout)
      operationSignal?.removeEventListener('abort', abortOperation)
      releaseDomain()
    }
  }
  throw new Error('The image redirected too many times.')
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
  description: string
  coverUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  chapters: ChapterLink[]
  pageCount: number
}

interface NovelPageMetadata {
  author: string
  description: string
  coverUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
}

function genericNovelMetadata($: ReturnType<typeof load>, pageUrl: string): NovelPageMetadata {
  const contentRoot = $('main, article, .novel-info, .book-info, .book-detail').first()
  const root = contentRoot.length ? contentRoot : $('body')
  const labeledField = (labels: string[]): string => {
    const pattern = new RegExp(`^(${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:?\\s*(.*)$`, 'i')
    for (const element of root.find('p, li, dt, dd, tr, .item').toArray()) {
      const text = normalizedText($(element).text())
      const match = pattern.exec(text)
      if (match?.[2]) return match[2]
      if (match && $(element).is('dt')) {
        const next = normalizedText($(element).next().text())
        if (next) return next
      }
    }
    return ''
  }
  const coverValue =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[name="image"]').attr('content') ||
    root.find('img[itemprop="image"], .cover img, .book-cover img').first().attr('src') ||
    ''
  let coverUrl = ''
  if (coverValue) {
    try {
      coverUrl = validateHttpUrl(new URL(coverValue, pageUrl).href)
    } catch {
      coverUrl = ''
    }
  }
  const genres = [
    ...root.find('[itemprop="genre"], .genre a, .genres a, a[rel="tag"], a[href*="/genre/"], a[href*="/genres/"]')
      .toArray()
      .map((element) => $(element).text()),
    ...$('meta[property="article:tag"], meta[name="genre"], meta[name="book:genre"]')
      .toArray()
      .map((element) => $(element).attr('content') ?? '')
  ]
  const description =
    $('.books .desc-text, [itemprop="description"], .description, .desc-text, .book-summary, .summary').first().text() ||
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    labeledField(['Description', 'Summary', 'Synopsis'])
  const author =
    $('meta[name="author"]').attr('content') ||
    root.find('[itemprop="author"], .author a, .author').first().text() ||
    labeledField(['Authors?', 'Writers?'])
  const alternativeNames = uniqueText(
    [
      ...root.find('[itemprop="alternativeName"], .alternative-names, .alternate-names, .alternative-name, .alt-names')
        .toArray()
        .map((element) => $(element).text()),
      labeledField(['Alternative names?', 'Also known as', 'Other names', 'Aliases'])
    ]
  )

  return {
    author: normalizedText(author),
    description: normalizedText(description).slice(0, 20_000),
    coverUrl,
    alternativeNames,
    genres: uniqueText([...genres, labeledField(['Genres?'])]),
    source: (
      normalizedText(root.find('[itemprop="publisher"], .source').first().text()) ||
      labeledField(['Source', 'Publisher', 'Origin']) ||
      new URL(pageUrl).hostname
    ).slice(0, 300),
    novelStatus: (
      normalizedText(root.find('[itemprop="bookStatus"], .novel-status, .book-status, .status').first().text()) ||
      labeledField(['Status', 'Novel status', 'State'])
    ).slice(0, 300)
  }
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function uniqueText(values: string[], limit = 100): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const text = normalizedText(value)
    if (text && text.length <= 300) unique.add(text)
    if (unique.size >= limit) break
  }
  return [...unique]
}

function novelFullInfoRow($: ReturnType<typeof load>, labels: string[]) {
  const expected = new Set(labels.map((label) => label.toLowerCase()))
  const rows = $('.m-imgtxt .txt .item, .info-holder .info > div')
  return rows
    .filter((_, element) => {
      const label =
        $(element).find('[title]').first().attr('title')?.trim().replace(/:$/, '').toLowerCase() ||
        $(element).children('h3').first().text().trim().replace(/:$/, '').toLowerCase()
      return expected.has(label)
    })
    .first()
}

function novelFullMetadata($: ReturnType<typeof load>, pageUrl: string): NovelPageMetadata {
  const generic = genericNovelMetadata($, pageUrl)
  const infoRow = (labels: string[]) => novelFullInfoRow($, labels)
  const infoValue = (labels: string[]): string => {
    const row = infoRow(labels)
    if (!row.length) return ''
    const value = row.clone()
    value.children('h3').remove()
    value.find('span[title]').remove()
    return normalizedText(value.text())
  }
  const summary = $('.m-desc .txt').first()
  const classicDescription = $('.col-info-desc .desc-text, .desc-text').first().text()
  const coverValue =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[name="image"]').attr('content') ||
    $('.info-holder .book img').first().attr('src') ||
    $('.m-imgtxt img, .books .cover img, .book-cover img').first().attr('src') ||
    ''
  let coverUrl = ''
  if (coverValue) {
    try {
      coverUrl = validateHttpUrl(new URL(coverValue, pageUrl).href)
    } catch {
      coverUrl = ''
    }
  }

  const alternativeNames = uniqueText([
    ...$('[itemprop="alternativeName"], .alternative-names, .alternate-names, .alternative-name, .alt-names')
      .toArray()
      .map((element) => $(element).text()),
    ...infoValue([
      'Alternative names',
      'Alternative name',
      'Alternative titles',
      'Also known as',
      'Other names',
      'Aliases'
    ]).split(/\s*,\s*/)
  ])
  const author = infoValue(['Author', 'Authors', 'Writer']) || generic.author
  const genres = uniqueText(
    infoRow(['Genre', 'Genres', 'Genre(s)', 'Category', 'Categories'])
      .find('a')
      .toArray()
      .map((element) => $(element).text())
  )

  return {
    author,
    description: normalizedText(
      classicDescription ||
      summary.text() ||
      $('meta[property="og:description"]').attr('content') ||
      ''
    ).slice(0, 20_000) || generic.description,
    coverUrl: coverUrl || generic.coverUrl,
    alternativeNames,
    genres: genres.length > 0 ? genres : generic.genres,
    source: (
      infoValue(['Source', 'Origin', 'Publisher', 'Original source']) || generic.source
    ).slice(0, 300),
    novelStatus: (
      infoValue(['Status', 'State', 'Novel status', 'Translation status']) ||
      generic.novelStatus
    ).slice(0, 300)
  }
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
  const metadata = novelFullMetadata($, url)

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

  return {
    ...metadata,
    title,
    author: [...authors].join(', ') || metadata.author,
    chapters: [...chaptersByUrl.values()],
    pageCount
  }
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
  const metadata = genericNovelMetadata($, url)
  const title = $('h1').first().text().trim() || documentTitle($)
  const pageText = $('body').text().replace(/\s+/g, ' ').trim()
  if (BLOCKED_PAGE.test(`${title} ${pageText.slice(0, 1000)}`)) {
    throw new Error('The source requires manual verification; discovery was not continued.')
  }
  const chapters = chapterLinksFromHtml(html, url)

  if (chapters.length > 0) {
    return {
      sourceUrl: url,
      title,
      ...metadata,
      parserName: 'Generic HTML',
      chapters
    }
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
      ...metadata,
      parserName: 'Generic HTML',
      chapters: [{ id: 'chapter-1', title: directTitle, url }]
    }
  }

  throw new Error('No chapter links were found. Use a chapter-list page or a chapter page with a detectable chapter title.')
}

type HtmlPageLoader = (url: string, signal?: AbortSignal) => Promise<{ html: string; finalUrl: string }>

async function discoverNovelFullChapters(
  value: string,
  loadPage: HtmlPageLoader,
  onProgress?: (progress: JobProgress) => void,
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  const firstPageUrl = new URL(value)
  firstPageUrl.searchParams.delete('page')
  const catalogUrl = validateHttpUrl(firstPageUrl.href)
  onProgress?.({ current: 0, total: 0, message: 'Loading NovelFull chapter index…' })

  const firstResponse = await loadPage(catalogUrl, signal)
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
    if (signal?.aborted) throw new Error('Browser-assisted discovery was cancelled.')
    const pageUrl = new URL(catalogUrl)
    pageUrl.searchParams.set('page', String(pageNumber))
    const response = await loadPage(pageUrl.href, signal)
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
    description: firstPage.description,
    coverUrl: firstPage.coverUrl,
    alternativeNames: firstPage.alternativeNames,
    genres: firstPage.genres,
    source: firstPage.source,
    novelStatus: firstPage.novelStatus,
    parserName: 'NovelFull',
    chapters
  }
}

export async function discoverChapters(
  value: unknown,
  onProgress?: (progress: JobProgress) => void
): Promise<DiscoveryResult> {
  return discoverChaptersUsingPageLoader(value, fetchHtml, onProgress)
}

export async function discoverChaptersUsingPageLoader(
  value: unknown,
  loadPage: HtmlPageLoader,
  onProgress?: (progress: JobProgress) => void,
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  const url = validateHttpUrl(value)
  if (isNovelFullUrl(url) && !CHAPTER_URL.test(new URL(url).pathname)) {
    return discoverNovelFullChapters(url, loadPage, onProgress, signal)
  }
  const { html, finalUrl } = await loadPage(url, signal)
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

interface ExtractedChapter {
  content: ChapterContent
  imageReferences: { key: string; url?: string; inline?: ChapterImage }[]
}

function inlineImageResource(value: string, pageUrl: string): ChapterImage {
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(value)
  if (!match) throw new Error('A chapter contains an unsupported inline image.')
  const data = Buffer.from(match[2], 'base64')
  if (
    data.length === 0 ||
    data.length > MAX_IMAGE_BYTES ||
    data.toString('base64') !== match[2]
  ) {
    throw new Error('An inline chapter image exceeds the 4 MB size limit or is malformed.')
  }
  const mediaType = imageMediaType(data)
  if (mediaType !== match[1].toLowerCase()) {
    throw new Error('An inline chapter image has mismatched image data.')
  }
  return { sourceUrl: pageUrl, mediaType, dataBase64: data.toString('base64') }
}

function extractChapterStructure(html: string, pageUrl: string, fallbackTitle: string): ExtractedChapter {
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

  const paragraphs: string[] = []
  const blocks: ChapterContentBlock[] = []
  const imageReferences: ExtractedChapter['imageReferences'] = []
  const imageIndexes = new Map<string, number>()

  for (const element of root.find('p, img').toArray()) {
    const tagName = element.tagName?.toLowerCase()
    if (tagName === 'p') {
      const paragraph = normalizeParagraph($(element).text())
      if (paragraph) {
        paragraphs.push(paragraph)
        blocks.push({ type: 'paragraph', text: paragraph })
      }
      continue
    }

    if (tagName !== 'img') continue
    const source =
      $(element).attr('data-original') ||
      $(element).attr('data-lazy-src') ||
      $(element).attr('data-src') ||
      $(element).attr('data-srcset')?.split(',')[0].trim().split(/\s+/)[0] ||
      $(element).attr('src') ||
      $(element).attr('srcset')?.split(',')[0].trim().split(/\s+/)[0] ||
      ''
    if (!source) continue

    let key: string
    let urlValue: string | undefined
    let inline: ChapterImage | undefined
    if (source.startsWith('data:')) {
      inline = inlineImageResource(source, url)
      key = `data:${createHash('sha256').update(inline.dataBase64).digest('hex')}`
    } else {
      urlValue = validateHttpUrl(new URL(source, url).href)
      key = urlValue
    }
    let imageIndex = imageIndexes.get(key)
    if (imageIndex === undefined) {
      if (imageReferences.length >= MAX_CHAPTER_IMAGES) {
        throw new Error(`A chapter contains more than ${MAX_CHAPTER_IMAGES} images.`)
      }
      imageIndex = imageReferences.length
      imageIndexes.set(key, imageIndex)
      imageReferences.push({ key, url: urlValue, inline })
    }
    blocks.push({
      type: 'image',
      imageIndex,
      alt: normalizeParagraph($(element).attr('alt') ?? '').slice(0, 1000)
    })
  }

  const readableParagraphs = paragraphs.length > 0 ? paragraphs : [text]
  if (paragraphs.length === 0) blocks.unshift({ type: 'paragraph', text })
  const novelFullChapterTitle = isNovelFullUrl(url)
    ? $('.chapter-title').first().text().replace(/\s+/g, ' ').trim() ||
      $('h1, h2, h3')
        .toArray()
        .map((heading) => $(heading).text().replace(/\s+/g, ' ').trim())
        .find((heading) => CHAPTER_LABEL.test(heading))
    : ''
  return {
    content: {
      title: novelFullChapterTitle || $('h1').first().text().trim() || pageTitle || fallbackTitle,
      url,
      paragraphs: readableParagraphs,
      blocks
    },
    imageReferences
  }
}

export function extractChapterFromHtml(html: string, pageUrl: string, fallbackTitle: string): ChapterContent {
  const { content } = extractChapterStructure(html, pageUrl, fallbackTitle)
  return { title: content.title, url: content.url, paragraphs: content.paragraphs }
}

export async function fetchChapterContentFromHtml(
  chapter: ChapterLink,
  html: string,
  pageUrl = chapter.url,
  signal?: AbortSignal
): Promise<ChapterContent> {
  const finalUrl = validateHttpUrl(pageUrl)
  const { content, imageReferences } = extractChapterStructure(html, finalUrl, chapter.title)
  const images: ChapterImage[] = []
  let totalImageBytes = 0
  for (const image of imageReferences) {
    const resource = image.inline ?? await fetchImageResource(image.url, content.url, signal)
    const imageBytes = Buffer.byteLength(resource.dataBase64, 'base64')
    totalImageBytes += imageBytes
    if (totalImageBytes > MAX_CHAPTER_IMAGE_BYTES) {
      throw new Error(`A chapter contains more than ${MAX_CHAPTER_IMAGE_BYTES / 1024 / 1024} MB of images.`)
    }
    images.push(resource)
  }
  return { ...content, images }
}

export async function fetchChapterContent(chapter: ChapterLink, signal?: AbortSignal): Promise<ChapterContent> {
  const url = validateHttpUrl(chapter.url)
  const { html, finalUrl } = await fetchHtml(url, signal)
  return fetchChapterContentFromHtml(chapter, html, finalUrl, signal)
}
