import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { load } from 'cheerio'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterImage,
  EpubMergeProgress,
  EpubNovelMetadata
} from '../../shared/contracts'
import {
  MAX_EPUB_INPUT_BYTES,
  MAX_EPUB_MERGE_ENTRY_BYTES,
  MAX_EPUB_MERGE_TEXT_BYTES,
  MAX_EPUB_MERGED_CHAPTERS,
  MAX_EPUB_ZIP_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_EPUB_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../shared/constants'
import { writeEpub } from './epub'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true
})

export interface EpubMergeSource {
  path: string
  filename: string
  chapterNumbers: number[]
  filenameRange: { start: number; end: number } | null
}

export interface EpubMergeInput {
  title: string
  filename: string
  outputDirectory: string
  language: string
  epubCss: string
  sources: EpubMergeSource[]
}

export interface EpubMergeResult {
  outputPath: string
  chapterCount: number
  duplicateChapterCount: number
  conflictingChapterCount: number
  firstChapter: number | null
  lastChapter: number | null
}

interface XmlObject {
  [key: string]: unknown
}

interface ParsedChapter {
  content: ChapterContent
  number: number | null
}

interface ParsedEpub {
  chapters: ParsedChapter[]
  author: string
  language: string
  metadata: EpubNovelMetadata
}

function object(value: unknown): XmlObject {
  return typeof value === 'object' && value !== null ? value as XmlObject : {}
}

function entries(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return typeof value === 'object' && value !== null ? text(object(value)['#text']) : ''
}

function resolveArchivePath(base: string, href: string): string | null {
  const pathPart = href.split(/[?#]/, 1)[0]
  if (!pathPart || pathPart.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(pathPart)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    throw new Error('An EPUB contains a malformed internal path.')
  }
  const path = posix.normalize(posix.join(posix.dirname(base), decoded.replace(/\\/g, '/')))
  if (path === '..' || path.startsWith('../')) throw new Error('An EPUB contains an unsafe internal path.')
  return path
}

async function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & {
    destroy(error?: Error): void
  }
  return new Promise<Buffer>((resolveEntry, rejectEntry) => {
    const chunks: Buffer[] = []
    let length = 0
    stream.on('data', (value: Buffer | Uint8Array) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      length += chunk.byteLength
      if (length > limit) {
        stream.destroy(new Error(`An EPUB resource exceeds the ${limit.toLocaleString()} byte safety limit.`))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', rejectEntry)
    stream.once('end', () => resolveEntry(Buffer.concat(chunks, length)))
  })
}

function parseChapterNumber(value: string): number | null {
  const match =
    value.match(/\b(?:chapter|ch\.?|episode|part)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i) ??
    value.match(/^\s*#?\s*(\d+(?:\.\d+)?)(?=\s|$|[:.-])/)
  return match ? Number(match[1]) : null
}

function collectNcx(value: unknown, base: string, labels: Map<string, string>): void {
  for (const candidate of entries(value)) {
    const node = object(candidate)
    const title = text(object(node.navLabel).text)
    const path = resolveArchivePath(base, text(object(node.content)['@_src']))
    if (title && path) labels.set(path, title)
    collectNcx(node.navPoint, base, labels)
  }
}

async function readNavigation(
  archive: JSZip,
  packagePath: string,
  spine: XmlObject,
  manifest: XmlObject[],
  manifestById: Map<string, XmlObject>
): Promise<Map<string, string>> {
  const nav = manifestById.get(text(spine['@_toc'])) ??
    manifest.find((item) => text(item['@_properties']).split(/\s+/).includes('nav'))
  if (!nav) return new Map()
  const navPath = resolveArchivePath(packagePath, text(nav['@_href']))
  const navFile = navPath ? archive.file(navPath) : null
  if (!navFile || navFile.dir) return new Map()
  const xml = (await readEntry(navFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  const labels = new Map<string, string>()
  if (text(nav['@_media-type']) === 'application/x-dtbncx+xml') {
    const parsed = object(xmlParser.parse(xml))
    collectNcx(object(object(parsed.ncx).navMap).navPoint, navPath!, labels)
  } else {
    const $ = load(xml)
    $('nav a[href]').each((_, element) => {
      const path = resolveArchivePath(navPath!, $(element).attr('href') ?? '')
      const label = $(element).text().replace(/\s+/g, ' ').trim()
      if (path && label) labels.set(path, label)
    })
  }
  return labels
}

function mediaTypeFor(path: string): EpubImageMediaType | null {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.png': return 'image/png'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    default: return null
  }
}

function isFrontMatter(path: string, title: string): boolean {
  const basename = posix.basename(path).toLowerCase().replace(/\.[^.]+$/, '')
  return /^(?:cover|titlepage|title-page|copyright|dedication|contents|toc|nav|novel-info|colophon)$/.test(basename) ||
    /^(?:novel information|table of contents|contents|cover|title page)$/i.test(title.trim())
}

async function parseEpub(
  source: EpubMergeSource,
  imageCache: Map<string, ChapterImage>,
  imageBytes: { value: number },
  onProgress: (completed: number, total: number) => void
): Promise<ParsedEpub> {
  const buffer = await readFile(source.path)
  if (buffer.byteLength > MAX_EPUB_INPUT_BYTES) {
    throw new Error(`${source.filename} exceeds the ${MAX_EPUB_INPUT_BYTES / (1024 * 1024)} MB source limit.`)
  }
  const archive = await JSZip.loadAsync(buffer)
  if (Object.keys(archive.files).length > MAX_EPUB_ZIP_ENTRIES) {
    throw new Error(`${source.filename} has too many ZIP entries.`)
  }

  const containerFile = archive.file('META-INF/container.xml')
  if (!containerFile) throw new Error(`${source.filename} is missing its EPUB container document.`)
  const container = object(xmlParser.parse((await readEntry(containerFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')))
  const rootfile = entries(object(object(container.container).rootfiles).rootfile)[0]
  const packagePath = text(object(rootfile)['@_full-path'])
  if (!packagePath) throw new Error(`${source.filename} has no package document.`)
  const normalizedPackagePath = posix.normalize(packagePath.replace(/\\/g, '/'))
  if (normalizedPackagePath.startsWith('../') || normalizedPackagePath.startsWith('/')) {
    throw new Error(`${source.filename} has an unsafe package path.`)
  }
  const packageFile = archive.file(normalizedPackagePath)
  if (!packageFile || packageFile.dir) throw new Error(`${source.filename} has no readable package document.`)

  const parsedPackage = object(xmlParser.parse((await readEntry(packageFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')))
  const packageData = object(parsedPackage.package)
  const metadata = object(packageData.metadata)
  const manifest = entries(object(packageData.manifest).item).map(object)
  const manifestById = new Map(manifest.map((item) => [text(item['@_id']), item]))
  const spine = object(packageData.spine)
  const labels = await readNavigation(archive, normalizedPackagePath, spine, manifest, manifestById)

  let cover: ChapterImage | undefined
  const coverId = text(entries(metadata.meta).map(object).find((item) => text(item['@_name']) === 'cover')?.['@_content'])
  const coverItem = manifestById.get(coverId) ??
    manifest.find((item) => text(item['@_properties']).split(/\s+/).includes('cover-image'))
  if (coverItem) {
    const coverPath = resolveArchivePath(normalizedPackagePath, text(coverItem['@_href']))
    const coverEntry = coverPath ? archive.file(coverPath) : null
    const mediaType = coverPath ? mediaTypeFor(coverPath) : null
    if (coverPath && coverEntry && !coverEntry.dir && mediaType) {
      const data = await readEntry(coverEntry, MAX_IMAGE_BYTES)
      const hash = createHash('sha256').update(data).digest('hex')
      cover = imageCache.get(hash)
      if (!cover) {
        imageBytes.value += data.byteLength
        if (imageBytes.value > MAX_TOTAL_EPUB_IMAGE_BYTES) {
          throw new Error('The selected EPUBs contain more than 128 MB of images.')
        }
        cover = {
          sourceUrl: `https://offline.invalid/${hash}`,
          mediaType,
          dataBase64: data.toString('base64')
        }
        imageCache.set(hash, cover)
      }
    }
  }

  const chapters: ParsedChapter[] = []
  const sourceId = createHash('sha256').update(source.path).digest('hex')
  let textBytes = 0
  const spineItems = entries(spine.itemref)
  const updateInterval = Math.max(1, Math.ceil(spineItems.length / 100))
  for (const [ordinal, rawSpineItem] of spineItems.entries()) {
    if ((ordinal + 1) % updateInterval === 0 || ordinal + 1 === spineItems.length) {
      onProgress(ordinal + 1, spineItems.length)
    }
    const item = object(rawSpineItem)
    const manifestItem = manifestById.get(text(item['@_idref']))
    if (!manifestItem || text(manifestItem['@_properties']).split(/\s+/).includes('nav')) continue
    const chapterPath = resolveArchivePath(normalizedPackagePath, text(manifestItem['@_href']))
    const chapterFile = chapterPath ? archive.file(chapterPath) : null
    if (!chapterPath || !chapterFile || chapterFile.dir) continue
    const markup = (await readEntry(chapterFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
    const $ = load(markup)
    const body = $('body').first()
    const root = body.length ? body : $('html').first()
    root.find('script, style, nav, noscript').remove()
    const heading = root.find('h1, h2, h3').first().text().replace(/\s+/g, ' ').trim()
    const title = labels.get(chapterPath) || heading || $('title').first().text().replace(/\s+/g, ' ').trim() ||
      posix.basename(chapterPath).replace(/\.[^.]+$/, '')
    if (isFrontMatter(chapterPath, title)) continue

    const paragraphs = root.find('p').toArray()
      .map((element) => $(element).clone().find('img').remove().end().text().replace(/\s+/g, ' ').trim())
      .filter((paragraph) => paragraph.length > 0)
    if (paragraphs.length === 0) {
      const bodyText = root.text().replace(/\s+/g, ' ').trim()
      if (bodyText && bodyText !== title) paragraphs.push(bodyText)
    }

    const images: ChapterImage[] = []
    const imageBlocks: ChapterContentBlock[] = []
    for (const element of root.find('img[src]').toArray()) {
      if (images.length >= 24) break
      const imagePath = resolveArchivePath(chapterPath, $(element).attr('src') ?? '')
      const entry = imagePath ? archive.file(imagePath) : null
      const mediaType = imagePath ? mediaTypeFor(imagePath) : null
      if (!imagePath || !entry || entry.dir || !mediaType) continue
      const data = await readEntry(entry, MAX_IMAGE_BYTES)
      const hash = createHash('sha256').update(data).digest('hex')
      let image = imageCache.get(hash)
      if (!image) {
        imageBytes.value += data.byteLength
        if (imageBytes.value > MAX_TOTAL_EPUB_IMAGE_BYTES) {
          throw new Error('The selected EPUBs contain more than 128 MB of images.')
        }
        image = {
          sourceUrl: `https://offline.invalid/${hash}`,
          mediaType,
          dataBase64: data.toString('base64')
        }
        imageCache.set(hash, image)
      }
      const imageIndex = images.length
      images.push(image)
      imageBlocks.push({ type: 'image', imageIndex, alt: ($(element).attr('alt') ?? '').slice(0, 1000) })
    }
    if (paragraphs.length === 0 && images.length === 0) continue

    textBytes += Buffer.byteLength(paragraphs.join('\n'), 'utf8')
    if (textBytes > MAX_EPUB_MERGE_TEXT_BYTES) {
      throw new Error(
        `${source.filename} contains more than ${MAX_EPUB_MERGE_TEXT_BYTES / (1024 * 1024)} MB of chapter text.`
      )
    }
    const number = parseChapterNumber(title) ??
      parseChapterNumber(chapterPath) ??
      source.chapterNumbers[chapters.length] ??
      (source.filenameRange && source.filenameRange.start + chapters.length <= source.filenameRange.end
        ? source.filenameRange.start + chapters.length
        : null)
    const content: ChapterContent = {
      title,
      url: `https://offline.invalid/${sourceId}/${ordinal}`,
      paragraphs,
      images,
      blocks: [
        ...paragraphs.map((paragraph) => ({ type: 'paragraph' as const, text: paragraph })),
        ...imageBlocks
      ]
    }
    chapters.push({ content, number })
  }
  if (spineItems.length === 0) onProgress(0, 0)

  const metadataResult: EpubNovelMetadata = {
    description: text(metadata.description),
    alternativeNames: [],
    genres: [],
    source: '',
    novelStatus: '',
    sourceUrl: '',
    cover
  }
  return {
    chapters,
    author: text(metadata.creator),
    language: text(metadata.language) || 'en',
    metadata: metadataResult
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export async function mergeEpubFiles(
  input: EpubMergeInput,
  onProgress: (progress: EpubMergeProgress) => void = () => undefined
): Promise<EpubMergeResult> {
  if (input.sources.length < 2) throw new Error('Select at least two EPUB files to combine.')
  const sources = [...input.sources].sort((left, right) =>
    (left.chapterNumbers[0] ?? left.filenameRange?.start ?? Number.MAX_SAFE_INTEGER) -
      (right.chapterNumbers[0] ?? right.filenameRange?.start ?? Number.MAX_SAFE_INTEGER) ||
    left.filename.localeCompare(right.filename)
  )
  const images = new Map<string, ChapterImage>()
  const imageBytes = { value: 0 }
  const chaptersByIdentity = new Map<string, { content: ChapterContent; textHash: string; number: number | null }>()
  let duplicates = 0
  let conflicts = 0
  let totalTextBytes = 0
  let primary: Pick<ParsedEpub, 'author' | 'language' | 'metadata'> | null = null
  let lastProgressPercentage = 0

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex]
    if (!source) continue
    const sourceStartPercentage = (sourceIndex / sources.length) * 75
    const sourceSlicePercentage = 75 / sources.length
    onProgress({
      stage: 'reading',
      percentage: Math.round(sourceStartPercentage),
      message: `Opening source ${sourceIndex + 1} of ${sources.length}: ${source.filename}`
    })
    const parsed = await parseEpub(source, images, imageBytes, (completed, total) => {
      const sourceFraction = total > 0 ? completed / total : 1
      const progress: EpubMergeProgress = {
        stage: 'extracting',
        percentage: Math.round(sourceStartPercentage + (sourceFraction * sourceSlicePercentage * 0.8)),
        message: `Extracting content from ${source.filename} · processing document ${completed.toLocaleString()} of ${total.toLocaleString()}`
      }
      if (progress.percentage > lastProgressPercentage) {
        lastProgressPercentage = progress.percentage
        onProgress(progress)
      }
    })
    if (!primary) {
      primary = {
        author: parsed.author,
        language: parsed.language,
        metadata: parsed.metadata
      }
    }
    totalTextBytes += parsed.chapters.reduce(
      (sum, chapter) => sum + Buffer.byteLength(chapter.content.paragraphs.join('\n'), 'utf8'),
      0
    )
    if (totalTextBytes > MAX_EPUB_MERGE_TEXT_BYTES) {
      throw new Error(
        `The selected EPUBs contain more than ${MAX_EPUB_MERGE_TEXT_BYTES / (1024 * 1024)} MB of chapter text.`
      )
    }

    const mergeInterval = Math.max(1, Math.ceil(parsed.chapters.length / 100))
    for (const [chapterIndex, chapter] of parsed.chapters.entries()) {
      const identity = chapter.number === null
        ? `title:${normalizedText(chapter.content.title)}`
        : `number:${chapter.number}`
      const chapterText = normalizedText(`${chapter.content.title}\n${chapter.content.paragraphs.join('\n')}`)
      const textHash = createHash('sha256').update(chapterText).digest('hex')
      const previous = chaptersByIdentity.get(identity)
      if (previous) {
        duplicates += 1
        if (previous.textHash !== textHash) conflicts += 1
      } else {
        if (chaptersByIdentity.size >= MAX_EPUB_MERGED_CHAPTERS) {
          throw new Error('The combined EPUB exceeds the 20,000 chapter safety limit.')
        }
        chaptersByIdentity.set(identity, { ...chapter, textHash })
      }
      if ((chapterIndex + 1) % mergeInterval === 0 || chapterIndex + 1 === parsed.chapters.length) {
        const sourceFraction = parsed.chapters.length > 0 ? (chapterIndex + 1) / parsed.chapters.length : 1
        const progress: EpubMergeProgress = {
          stage: 'merging',
          percentage: Math.round(
            sourceStartPercentage + sourceSlicePercentage * (0.8 + sourceFraction * 0.2)
          ),
          message: `Combining chapters from ${source.filename} · ${chapterIndex + 1} of ${parsed.chapters.length}`
        }
        if (progress.percentage > lastProgressPercentage) {
          lastProgressPercentage = progress.percentage
          onProgress(progress)
        }
      }
    }
  }

  const merged = [...chaptersByIdentity.values()]
  if (!primary || merged.length === 0) throw new Error('No readable chapter content was found in the selected EPUBs.')
  if (merged.every((chapter) => chapter.number !== null)) {
    merged.sort((left, right) => (left.number ?? 0) - (right.number ?? 0))
  }
  const firstChapter = merged[0]?.number ?? null
  const lastChapter = merged[merged.length - 1]?.number ?? null
  const filename = input.filename.trim() ||
    `${input.title} ${firstChapter ?? ''}-${lastChapter ?? ''}.epub`
  onProgress({
    stage: 'packaging',
    percentage: 75,
    message: `Preparing EPUB package with ${merged.length.toLocaleString()} unique chapters…`
  })
  const result = await writeEpub(
    input.outputDirectory,
    input.title,
    primary.author,
    input.language || primary.language,
    merged.map(({ content }) => content),
    filename,
    undefined,
    input.epubCss,
    primary.metadata,
    (progress) => {
      if (progress.stage === 'packaging') {
        const percentage = 75 + (progress.percentage * 0.19)
        const rounded = Math.round(percentage)
        if (rounded > lastProgressPercentage) {
          lastProgressPercentage = rounded
          onProgress({ ...progress, percentage: rounded })
        }
      } else if (progress.stage === 'validating') {
        const percentage = Math.min(99, 94 + progress.percentage * 0.05)
        if (percentage > lastProgressPercentage) lastProgressPercentage = percentage
        onProgress({ ...progress, percentage })
      } else {
        onProgress({ ...progress, percentage: progress.stage === 'complete' ? 100 : 99 })
      }
    }
  )
  onProgress({ stage: 'complete', percentage: 100, message: 'Merged EPUB created and validated.' })
  return {
    outputPath: result.outputPath,
    chapterCount: merged.length,
    duplicateChapterCount: duplicates,
    conflictingChapterCount: conflicts,
    firstChapter,
    lastChapter
  }
}
