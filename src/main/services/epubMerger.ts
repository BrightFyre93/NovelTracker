import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { load } from 'cheerio'
import * as yauzl from 'yauzl'
import type { AnyNode, Element, Text } from 'domhandler'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterInlineNode,
  ChapterImage,
  EpubMergeProgress,
  EpubNovelMetadata
} from '../../shared/contracts'
import { parseChapterNumber } from '../../shared/chapterNumber'
import { NoReadableContentError } from '../../shared/errors'
import {
  createXmlParser,
  entries,
  object,
  resolveArchivePath as resolveEpubArchivePath,
  text,
  type XmlObject
} from './epubArchiveUtils'
import {
  MAX_CHAPTER_IMAGES,
  MAX_EPUB_INPUT_BYTES,
  MAX_EPUB_MERGE_ENTRY_BYTES,
  MAX_EPUB_MERGE_TEXT_BYTES,
  MAX_EPUB_MERGED_CHAPTERS,
  MAX_EPUB_ZIP_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_EPUB_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../shared/constants'
import { writeEpubFromArtifactStore } from './epub'
import type { EpubPackagingProgress } from './epubPackaging'
import { writeChapterArtifact, writeCoverArtifact } from './localStore'
import { DEFAULT_EPUB_OUTPUT_OPTIONS } from '../../shared/epubOutputOptions'

const xmlParser = createXmlParser()

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

function inlineNodesFromDom(node: AnyNode): ChapterInlineNode[] {
  const nodeType = String(node.type)
  if (nodeType === 'text') {
    const value = (node as Text).data.replace(/\s+/g, ' ')
    return value ? [{ type: 'text', text: value }] : []
  }
  if (nodeType !== 'tag') return []
  const element = node as Element
  const children = element.children.flatMap(inlineNodesFromDom)
  if (element.name === 'br') return [{ type: 'break' }]
  if (element.name === 'p') return [...children, { type: 'text', text: ' ' }]
  if (element.name === 'em' || element.name === 'i') {
    return [{ type: 'emphasis', children }]
  }
  if (element.name === 'strong' || element.name === 'b') {
    return [{ type: 'strong', children }]
  }
  if (element.name === 'a') {
    const href = safeExternalHref(element.attribs.href ?? '')
    return href ? [{ type: 'link', href, children }] : children
  }
  return children
}

function inlineText(nodes: ChapterInlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text
    if (node.type === 'break') return ' '
    return inlineText(node.children)
  }).join('').replace(/\s+/g, ' ').trim()
}

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
  appVersion?: string
  sources: EpubMergeSource[]
}

export interface EpubMergeResult {
  outputPath: string
  chapterCount: number
  duplicateChapterCount: number
  conflictingChapterCount: number
  conflictingChapterTitles: string[]
  firstChapter: number | null
  lastChapter: number | null
}

interface ParsedChapter {
  content: ChapterContent
  number: number | null
}

interface ParsedEpub {
  author: string
  language: string
  metadata: EpubNovelMetadata
  sidecar: MergeSidecar | null
}

interface MergeSidecarMetadata {
  sourceUrl: string
  alternativeNames: string[]
  genres: string[]
  source: string
  novelStatus: string
  description: string
}

interface MergeSidecar {
  bookId: string
  volumeIndex: number
  chapters: Array<{ number: number | null; title: string }>
  metadata?: MergeSidecarMetadata
}

function readSidecarMetadata(value: unknown): MergeSidecarMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const strings = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? candidate
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 200)
      : []
  const stringValue = (candidate: unknown): string =>
    typeof candidate === 'string' ? candidate : ''
  return {
    sourceUrl: stringValue(record.sourceUrl),
    alternativeNames: strings(record.alternativeNames),
    genres: strings(record.genres),
    source: stringValue(record.source),
    novelStatus: stringValue(record.novelStatus),
    description: stringValue(record.description)
  }
}

async function readMergeSidecar(archive: LazyMergeArchive): Promise<MergeSidecar | null> {
  try {
    const sidecar = await archive.readOptional('META-INF/noveltracker.json', 4 * 1024 * 1024)
    if (sidecar === null) return null
    const parsed: unknown = JSON.parse(sidecar.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const value = parsed as Record<string, unknown>
    const volume = typeof value.volume === 'object' && value.volume !== null
      ? value.volume as Record<string, unknown>
      : {}
    if (
      value.schemaVersion !== 1 ||
      typeof value.bookId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.bookId) ||
      !Number.isSafeInteger(volume.index) ||
      !Array.isArray(value.chapters) ||
      value.chapters.length > MAX_EPUB_MERGED_CHAPTERS
    ) return null
    const chapters = value.chapters.flatMap((candidate) => {
      if (typeof candidate !== 'object' || candidate === null) return []
      const chapter = candidate as Record<string, unknown>
      if (
        typeof chapter.title !== 'string' ||
        !(chapter.number === null || (typeof chapter.number === 'number' && Number.isFinite(chapter.number)))
      ) return []
      return [{ number: chapter.number, title: chapter.title }]
    })
    if (chapters.length !== value.chapters.length) return null
    return {
      bookId: value.bookId,
      volumeIndex: volume.index as number,
      chapters,
      metadata: readSidecarMetadata(value.metadata)
    }
  } catch {
    return null
  }
}

function resolveArchivePath(base: string, href: string): string | null {
  return resolveEpubArchivePath(base, href, {
    malformedPath: 'An EPUB contains a malformed internal path.',
    unsafePath: 'An EPUB contains an unsafe internal path.'
  })
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
  archive: LazyMergeArchive,
  packagePath: string,
  spine: XmlObject,
  manifest: XmlObject[],
  manifestById: Map<string, XmlObject>
): Promise<Map<string, string>> {
  const nav = manifestById.get(text(spine['@_toc'])) ??
    manifest.find((item) => text(item['@_properties']).split(/\s+/).includes('nav'))
  if (!nav) return new Map()
  const navPath = resolveArchivePath(packagePath, text(nav['@_href']))
  const xmlBuffer = navPath ? await archive.readOptional(navPath, MAX_EPUB_MERGE_ENTRY_BYTES) : null
  if (!xmlBuffer) return new Map()
  const xml = xmlBuffer.toString('utf8')
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

class LazyMergeArchive {
  private readonly entries = new Map<string, yauzl.Entry>()

  private constructor(private readonly archive: yauzl.ZipFile) {}

  static async open(path: string): Promise<LazyMergeArchive> {
    const archive = await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true
    })
    const result = new LazyMergeArchive(archive)
    try {
      await new Promise<void>((resolveEntries, rejectEntries) => {
        let count = 0
        const cleanup = (): void => {
          archive.off('entry', onEntry)
          archive.off('end', onEnd)
          archive.off('error', onError)
        }
        const onEnd = (): void => {
          cleanup()
          resolveEntries()
        }
        const onError = (error: Error): void => {
          cleanup()
          rejectEntries(error)
        }
        const onEntry = (entry: yauzl.Entry): void => {
          count += 1
          if (count > MAX_EPUB_ZIP_ENTRIES) {
            cleanup()
            archive.close()
            rejectEntries(new Error('EPUB contains too many ZIP entries.'))
            return
          }
          if (!entry.fileName.endsWith('/')) result.entries.set(entry.fileName, entry)
          archive.readEntry()
        }
        archive.on('entry', onEntry)
        archive.once('end', onEnd)
        archive.once('error', onError)
        archive.readEntry()
      })
      return result
    } catch (error) {
      archive.close()
      throw error
    }
  }

  async readOptional(name: string, limit: number): Promise<Buffer | null> {
    const entry = this.entries.get(name)
    if (!entry) return null
    if (entry.uncompressedSize > limit) {
      throw new Error(`An EPUB resource exceeds the ${limit.toLocaleString()} byte safety limit.`)
    }
    const stream = await this.archive.openReadStreamPromise(entry)
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > limit) {
        stream.destroy()
        throw new Error(`An EPUB resource exceeds the ${limit.toLocaleString()} byte safety limit.`)
      }
      chunks.push(new Uint8Array(buffer))
    }
    return Buffer.concat(chunks, length)
  }

  async read(name: string, limit: number): Promise<Buffer> {
    const value = await this.readOptional(name, limit)
    if (!value) throw new Error(`EPUB resource ${name} was not found.`)
    return value
  }

  close(): void {
    this.archive.close()
  }
}

function isFrontMatter(path: string, title: string): boolean {
  const basename = posix.basename(path).toLowerCase().replace(/\.[^.]+$/, '')
  return /^(?:cover|titlepage|title-page|copyright|dedication|contents|toc|nav|novel-info|chapter-list|colophon)$/.test(basename) ||
    /^(?:novel information|chapter list|table of contents|contents|cover|title page)$/i.test(title.trim())
}

async function parseEpub(
  source: EpubMergeSource,
  imageBytes: { value: number },
  imageHashes: Set<string>,
  onProgress: (completed: number, total: number) => void,
  onChapter: (chapter: ParsedChapter, sidecar: MergeSidecar | null) => Promise<void>
): Promise<ParsedEpub> {
  const fileDetails = await stat(source.path)
  if (fileDetails.size > MAX_EPUB_INPUT_BYTES) {
    throw new Error(`${source.filename} exceeds the ${MAX_EPUB_INPUT_BYTES / (1024 * 1024)} MB source limit.`)
  }
  const archive = await LazyMergeArchive.open(source.path)
  try {
  const sidecar = await readMergeSidecar(archive)
  const container = object(xmlParser.parse((await archive.read('META-INF/container.xml', MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')))
  const rootfile = entries(object(object(container.container).rootfiles).rootfile)[0]
  const packagePath = text(object(rootfile)['@_full-path'])
  if (!packagePath) throw new Error(`${source.filename} has no package document.`)
  const normalizedPackagePath = posix.normalize(packagePath.replace(/\\/g, '/'))
  if (normalizedPackagePath.startsWith('../') || normalizedPackagePath.startsWith('/')) {
    throw new Error(`${source.filename} has an unsafe package path.`)
  }
  const parsedPackage = object(xmlParser.parse((await archive.read(normalizedPackagePath, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')))
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
    const mediaType = coverPath ? mediaTypeFor(coverPath) : null
    if (coverPath && mediaType) {
      const data = await archive.readOptional(coverPath, MAX_IMAGE_BYTES)
      if (!data) throw new Error(`Cover image in ${source.filename} could not be read.`)
      const hash = createHash('sha256').update(data).digest('hex')
      if (!imageHashes.has(hash)) {
        imageHashes.add(hash)
        imageBytes.value += data.byteLength
        if (imageBytes.value > MAX_TOTAL_EPUB_IMAGE_BYTES) {
          throw new Error('The selected EPUBs contain more than 128 MB of images.')
        }
      }
      cover = {
        sourceUrl: `https://offline.invalid/${hash}`,
        mediaType,
        dataBase64: data.toString('base64')
      }
    }
  }

  const sourceId = createHash('sha256').update(source.path).digest('hex')
  let textBytes = 0
  let contentOrdinal = 0
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
    if (!chapterPath) continue
    const chapterMarkup = await archive.readOptional(chapterPath, MAX_EPUB_MERGE_ENTRY_BYTES)
    if (!chapterMarkup) continue
    const markup = chapterMarkup.toString('utf8')
    const $ = load(markup)
    const body = $('body').first()
    const root = body.length ? body : $('html').first()
    root.find('script, style, nav, noscript').remove()
    const heading = root.find('h1, h2, h3').first().text().replace(/\s+/g, ' ').trim()
    const title = labels.get(chapterPath) || heading || $('title').first().text().replace(/\s+/g, ' ').trim() ||
      posix.basename(chapterPath).replace(/\.[^.]+$/, '')
    if (isFrontMatter(chapterPath, title)) continue
    const sidecarChapter = sidecar?.chapters[contentOrdinal]
    contentOrdinal += 1

    const paragraphs: string[] = []
    const images: ChapterImage[] = []
    const blocks: ChapterContentBlock[] = []
    for (const element of root.find('p, h2, h3, h4, blockquote, ul, ol, hr, img[src]').toArray()) {
      const selection = $(element)
      if (selection.parents('blockquote, ul, ol').length > 0) continue
      const tag = String(element.type) === 'tag' ? element.name : ''
      if (tag === 'hr') {
        blocks.push({ type: 'scene-break' })
        continue
      }
      if (tag === 'img') {
        if (images.length >= MAX_CHAPTER_IMAGES) continue
        const imagePath = resolveArchivePath(chapterPath, selection.attr('src') ?? '')
        const mediaType = imagePath ? mediaTypeFor(imagePath) : null
        if (!imagePath || !mediaType) continue
        const data = await archive.readOptional(imagePath, MAX_IMAGE_BYTES)
        if (!data) continue
        const hash = createHash('sha256').update(data).digest('hex')
        if (!imageHashes.has(hash)) {
          imageHashes.add(hash)
          imageBytes.value += data.byteLength
          if (imageBytes.value > MAX_TOTAL_EPUB_IMAGE_BYTES) {
            throw new Error('The selected EPUBs contain more than 128 MB of images.')
          }
        }
        const image: ChapterImage = {
          sourceUrl: `https://offline.invalid/${hash}`,
          mediaType,
          dataBase64: data.toString('base64')
        }
        const imageIndex = images.length
        images.push(image)
        blocks.push({ type: 'image', imageIndex, alt: (selection.attr('alt') ?? '').slice(0, 1000) })
        continue
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = selection.children('li').toArray().flatMap((item) => {
          const inline = inlineNodesFromDom(item)
          const text = inlineText(inline)
          return text ? [{ text, inline }] : []
        })
        if (items.length > 0) {
          blocks.push({ type: 'list', ordered: tag === 'ol', items })
          paragraphs.push(...items.map((item) => item.text))
        }
        continue
      }
      if (tag === 'p' || tag === 'blockquote' || /^h[234]$/.test(tag)) {
        const inline = String(element.type) === 'tag'
          ? element.children.flatMap(inlineNodesFromDom)
          : []
        const text = inlineText(inline)
        if (!text) continue
        paragraphs.push(text)
        if (tag === 'blockquote') blocks.push({ type: 'blockquote', text, inline })
        else if (/^h[234]$/.test(tag)) {
          blocks.push({ type: 'heading', level: Number(tag.slice(1)) as 2 | 3 | 4, text, inline })
        } else blocks.push({ type: 'paragraph', text, inline })
      }
    }
    if (blocks.length === 0) {
      const bodyText = root.text().replace(/\s+/g, ' ').trim()
      if (bodyText && bodyText !== title) {
        paragraphs.push(bodyText)
        blocks.push({ type: 'paragraph', text: bodyText })
      }
    }
    if (paragraphs.length === 0 && images.length === 0) continue

    textBytes += Buffer.byteLength(paragraphs.join('\n'), 'utf8')
    if (textBytes > MAX_EPUB_MERGE_TEXT_BYTES) {
      throw new Error(
        `${source.filename} contains more than ${MAX_EPUB_MERGE_TEXT_BYTES / (1024 * 1024)} MB of chapter text.`
      )
    }
    const number = sidecarChapter !== undefined
      ? sidecarChapter.number
      : parseChapterNumber(title)
    const content: ChapterContent = {
      title,
      url: `https://offline.invalid/${sourceId}/${ordinal}`,
      paragraphs,
      images,
      blocks
    }
    await onChapter({ content, number }, sidecar)
  }
  if (spineItems.length === 0) onProgress(0, 0)

  const sidecarMetadata = sidecar?.metadata
  const metadataResult: EpubNovelMetadata = {
    description: text(metadata.description) || sidecarMetadata?.description || '',
    alternativeNames: sidecarMetadata?.alternativeNames ?? [],
    genres: sidecarMetadata?.genres ?? [],
    source: sidecarMetadata?.source ?? '',
    novelStatus: sidecarMetadata?.novelStatus ?? '',
    sourceUrl: sidecarMetadata?.sourceUrl ?? '',
    cover
  }
  return {
    author: text(metadata.creator),
    language: text(metadata.language) || 'en',
    metadata: metadataResult,
    sidecar
  }
  } finally {
    archive.close()
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export async function mergeEpubFiles(
  input: EpubMergeInput,
  onProgress: (progress: EpubMergeProgress) => void = () => undefined
): Promise<EpubMergeResult> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'novel-tracker-merge-'))
  const queueItemId = randomUUID()
  try {
    return await mergeEpubFilesToArtifacts(input, onProgress, dataDirectory, queueItemId)
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

async function mergeEpubFilesToArtifacts(
  input: EpubMergeInput,
  onProgress: (progress: EpubMergeProgress) => void,
  dataDirectory: string,
  queueItemId: string
): Promise<EpubMergeResult> {
  if (input.sources.length < 2) throw new Error('Select at least two EPUB files to combine.')
  const sources = [...input.sources].sort((left, right) =>
    (left.chapterNumbers[0] ?? left.filenameRange?.start ?? Number.MAX_SAFE_INTEGER) -
      (right.chapterNumbers[0] ?? right.filenameRange?.start ?? Number.MAX_SAFE_INTEGER) ||
    left.filename.localeCompare(right.filename)
  )
  const imageHashes = new Set<string>()
  const imageBytes = { value: 0 }
  const chaptersByIdentity = new Map<string, { title: string; url: string; textHash: string; number: number | null }>()
  const chaptersByBaseIdentity = new Map<string, Array<{ key: string; textHash: string }>>()
  const conflictingChapterTitles: string[] = []
  let duplicates = 0
  let conflicts = 0
  let totalTextBytes = 0
  let primary: Pick<ParsedEpub, 'author' | 'language' | 'metadata'> | null = null
  let includeCover = false
  let lastProgressPercentage = 0
  const sourceBookIds = new Set<string>()
  let everySourceHasSidecar = true

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
    let chapterIndex = 0
    const parsed = await parseEpub(source, imageBytes, imageHashes, (completed, total) => {
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
    }, async (chapter, sidecar) => {
      totalTextBytes += Buffer.byteLength(chapter.content.paragraphs.join('\n'), 'utf8')
      if (totalTextBytes > MAX_EPUB_MERGE_TEXT_BYTES) {
        throw new Error(
          `The selected EPUBs contain more than ${MAX_EPUB_MERGE_TEXT_BYTES / (1024 * 1024)} MB of chapter text.`
        )
      }
      const identity = chapter.number === null
        ? `title:${normalizedText(chapter.content.title)}`
        : `number:${chapter.number}`
      const chapterText = normalizedText(`${chapter.content.title}\n${chapter.content.paragraphs.join('\n')}`)
      const textHash = createHash('sha256').update(chapterText).digest('hex')
      const sameIdentity = chaptersByBaseIdentity.get(identity) ?? []
      if (sameIdentity.some((candidate) => candidate.textHash === textHash)) {
        duplicates += 1
      } else {
        if (chaptersByIdentity.size >= MAX_EPUB_MERGED_CHAPTERS) {
          throw new Error('The combined EPUB exceeds the 20,000 chapter safety limit.')
        }
        const previousConflict = sameIdentity.length > 0
        if (previousConflict) {
          conflicts += 1
          if (conflictingChapterTitles.length < 100) {
            conflictingChapterTitles.push(chapter.content.title)
          }
        }
        const volumeDiscriminator = sidecar
          ? `${sidecar.bookId}:volume:${sidecar.volumeIndex}`
          : source.filenameRange
            ? `range:${source.filenameRange.start}-${source.filenameRange.end}`
            : createHash('sha256').update(source.path).digest('hex')
        let key = previousConflict
          ? `${identity}:conflict:${volumeDiscriminator}`
          : identity
        if (chaptersByIdentity.has(key)) key = `${key}:source:${sourceIndex}:${chapterIndex}`
        await writeChapterArtifact(dataDirectory, queueItemId, chapter.content)
        chaptersByIdentity.set(key, {
          title: chapter.content.title,
          url: chapter.content.url,
          textHash,
          number: chapter.number
        })
        chaptersByBaseIdentity.set(identity, [...sameIdentity, { key, textHash }])
      }
      chapterIndex += 1
      if (chapterIndex % 100 === 0) {
        const progress: EpubMergeProgress = {
          stage: 'merging',
          percentage: Math.min(74, Math.round(sourceStartPercentage + sourceSlicePercentage * 0.8)),
          message: `Combining chapters from ${source.filename} · ${chapterIndex.toLocaleString()} processed`
        }
        if (progress.percentage > lastProgressPercentage) {
          lastProgressPercentage = progress.percentage
          onProgress(progress)
        }
      }
    })
    if (parsed.sidecar) sourceBookIds.add(parsed.sidecar.bookId)
    else everySourceHasSidecar = false
    if (!primary) {
      includeCover = Boolean(parsed.metadata.cover)
      if (parsed.metadata.cover) {
        await writeCoverArtifact(dataDirectory, queueItemId, parsed.metadata.cover)
      }
      const metadataWithoutCover = { ...parsed.metadata }
      delete metadataWithoutCover.cover
      primary = {
        author: parsed.author,
        language: parsed.language,
        metadata: metadataWithoutCover
      }
    } else {
      // Fill details the first source lacks from the following sources.
      const target = primary.metadata
      const extra = parsed.metadata
      if (!primary.author && parsed.author) primary.author = parsed.author
      if (!target.description) target.description = extra.description
      if (!target.source) target.source = extra.source
      if (!target.novelStatus) target.novelStatus = extra.novelStatus
      if (!target.sourceUrl) target.sourceUrl = extra.sourceUrl
      if (target.alternativeNames.length === 0) {
        target.alternativeNames = extra.alternativeNames
      }
      if (target.genres.length === 0) target.genres = extra.genres
    }
  }

  const merged = [...chaptersByIdentity.values()]
  if (!primary || merged.length === 0) {
    throw new NoReadableContentError(
      'No readable chapter content was found in the selected EPUBs.'
    )
  }
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
  // Every source belongs to one novel: keep its novel id. Otherwise derive a
  // new one from the source URL (if any) or the merged title. The file id comes
  // from the merged file name so re-merging the same name gives the same id.
  const sharedNovelId =
    everySourceHasSidecar && sourceBookIds.size === 1
      ? [...sourceBookIds][0]
      : undefined
  const result = await writeEpubFromArtifactStore(
    {
      dataDirectory,
      queueItemId,
      chapters: merged.map(({ title, url }) => ({ title, url })),
      outputDirectory: input.outputDirectory,
      title: input.title,
      author: primary.author,
      filename,
      outputOptions: {
        ...DEFAULT_EPUB_OUTPUT_OPTIONS,
        css: input.epubCss,
        language: input.language || primary.language,
        // Sources were already normalized when they were built: keep images as is.
        compressImages: false,
        imageFormat: 'original',
        identifierSeed:
          primary.metadata.sourceUrl.trim() ||
          `merged:${normalizedText(input.title)}`
      },
      appVersion: input.appVersion,
      includeCover,
      metadata: primary.metadata,
      novelId: sharedNovelId,
      fileIdKey: `merged:${normalizedText(filename)}`,
      allowVolumeSplit: false
    },
    undefined,
    (progress: EpubPackagingProgress) => {
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
    conflictingChapterTitles,
    firstChapter,
    lastChapter
  }
}
