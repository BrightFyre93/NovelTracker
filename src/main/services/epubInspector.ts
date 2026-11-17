import { posix } from 'node:path'
import { load } from 'cheerio'
import * as yauzl from 'yauzl'
import type { CoverageConfidence, LibraryFileRecord } from '../../shared/contracts'
import { parseChapterNumber } from '../../shared/chapterNumber'
import { parseFilenameRange } from '../../shared/filenameRange'
import {
  createXmlParser,
  entries,
  normalizeArchivePath,
  object,
  text,
  type XmlObject
} from './epubArchiveUtils'

const xmlParser = createXmlParser()
const MAX_NOVELTRACKER_SIDECAR_BYTES = 4 * 1024 * 1024
const MAX_INSPECTOR_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_INSPECTOR_ZIP_ENTRIES = 100_000
let legacyInspectionActive = false
const legacyInspectionWaiters: Array<() => void> = []

async function withLegacyInspectionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (legacyInspectionActive) {
    await new Promise<void>((resolveSlot) => legacyInspectionWaiters.push(resolveSlot))
  } else {
    legacyInspectionActive = true
  }
  try {
    return await task()
  } finally {
    const next = legacyInspectionWaiters.shift()
    if (next) next()
    else legacyInspectionActive = false
  }
}

interface NovelTrackerSidecar {
  bookId: string
  volumeIndex: number
  title: string
  author: string
  language: string
  chapters: Array<{ number: number | null; title: string }>
}

async function readNovelTrackerSidecar(
  path: string
): Promise<NovelTrackerSidecar | null> {
  const archive = await yauzl.openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true
  })
  const contents = await new Promise<string | null>((resolveSidecar, rejectSidecar) => {
    let settled = false
    const cleanup = (): void => {
      archive.off('entry', onEntry)
      archive.off('end', onEnd)
      archive.off('error', onError)
      archive.close()
    }
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveSidecar(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectSidecar(error instanceof Error ? error : new Error(String(error)))
    }
    const onEnd = (): void => finish(null)
    const onError = (error: Error): void => fail(error)
    const onEntry = (entry: yauzl.Entry): void => {
      if (entry.fileName !== 'META-INF/noveltracker.json') {
        archive.readEntry()
        return
      }
      if (entry.uncompressedSize > MAX_NOVELTRACKER_SIDECAR_BYTES) {
        finish(null)
        return
      }
      void (async () => {
        const stream = await archive.openReadStreamPromise(entry)
        const chunks: Uint8Array[] = []
        let length = 0
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          length += buffer.length
          if (length > MAX_NOVELTRACKER_SIDECAR_BYTES) {
            finish(null)
            stream.destroy()
            return
          }
          const bytes = new Uint8Array(buffer.byteLength)
          bytes.set(buffer)
          chunks.push(bytes)
        }
        finish(Buffer.concat(chunks, length).toString('utf8'))
      })().catch(fail)
    }
    archive.on('entry', onEntry)
    archive.once('end', onEnd)
    archive.once('error', onError)
    archive.readEntry()
  })
  if (!contents) return null
  try {
    const parsed: unknown = JSON.parse(contents)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      record.schemaVersion !== 1 ||
      typeof record.bookId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.bookId) ||
      typeof record.title !== 'string' ||
      typeof record.author !== 'string' ||
      typeof record.language !== 'string' ||
      typeof record.volume !== 'object' || record.volume === null ||
      !Array.isArray(record.chapters) ||
      record.chapters.length > 20_000
    ) return null
    const volumeIndex = (record.volume as Record<string, unknown>).index
    if (typeof volumeIndex !== 'number' || !Number.isSafeInteger(volumeIndex) || volumeIndex < 1) return null
    const chapters = record.chapters.flatMap((value) => {
      if (typeof value !== 'object' || value === null) return []
      const chapter = value as Record<string, unknown>
      if (
        typeof chapter.title !== 'string' ||
        chapter.title.length === 0 ||
        !(chapter.number === null || (typeof chapter.number === 'number' && Number.isFinite(chapter.number)))
      ) return []
      return [{ number: chapter.number, title: chapter.title }]
    })
    if (chapters.length !== record.chapters.length) return null
    return {
      bookId: record.bookId,
      volumeIndex,
      title: record.title,
      author: record.author,
      language: record.language,
      chapters
    }
  } catch {
    return null
  }
}

function xmlPath(value: string): string {
  return normalizeArchivePath(value, 'EPUB contains an invalid internal path.')
}

function internalHref(baseFile: string, href: string): string {
  const cleanHref = href.split(/[?#]/, 1)[0]
  if (!cleanHref || /^[a-z]+:/i.test(cleanHref) || cleanHref.startsWith('/')) {
    throw new Error('EPUB contains an unsupported external resource reference.')
  }
  return xmlPath(posix.join(posix.dirname(baseFile), cleanHref))
}

function firstString(value: unknown): string {
  return text(entries(value)[0])
}

function flattenNcx(value: unknown, result: string[]): void {
  for (const candidate of entries(value)) {
    const node = object(candidate)
    const label = text(object(node.navLabel).text)
    if (label) result.push(label)
    flattenNcx(node.navPoint, result)
  }
}

function tocLabels(xml: string): string[] {
  const parsed = object(xmlParser.parse(xml))
  const ncx = object(parsed.ncx)
  const labels: string[] = []
  flattenNcx(object(ncx.navMap).navPoint, labels)
  if (labels.length > 0) return labels

  const $ = load(xml)
  $('nav a').each((_, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim()
    if (label) labels.push(label)
  })
  return labels
}

function chapterHeadings(html: string): string[] {
  const $ = load(html)
  return $('h1, h2, h3, title')
    .toArray()
    .map((element) => $(element).text().replace(/\s+/g, ' ').trim())
    .filter((heading) => parseChapterNumber(heading) !== null || /\b(?:prologue|epilogue|interlude)\b/i.test(heading))
}

function keepChapterTitle(value: string): boolean {
  return parseChapterNumber(value) !== null || /\b(?:prologue|epilogue|interlude)\b/i.test(value)
}

function firstMetadataValue(metadata: XmlObject, name: string): string {
  return firstString(metadata[name])
}

export async function inspectEpub(
  path: string,
  relativePath: string,
  folderState: LibraryFileRecord['folderState'],
  size: number,
  modifiedAt: string,
  id: string
): Promise<LibraryFileRecord> {
  const sidecar = await readNovelTrackerSidecar(path)
  if (sidecar) {
    const chapterTitles = [...new Set(sidecar.chapters.map((chapter) => chapter.title))]
    const chapterNumbers = [...new Set(
      sidecar.chapters
        .map((chapter) => chapter.number)
        .filter((number): number is number => number !== null)
    )].sort((left, right) => left - right)
    return {
      id,
      path,
      relativePath,
      filename: relativePath.split(/[\\/]/).pop()!,
      format: 'EPUB',
      folderState,
      size,
      modifiedAt,
      novelTitle: sidecar.title,
      stableBookId: sidecar.bookId,
      volumeIndex: sidecar.volumeIndex,
      author: sidecar.author,
      language: sidecar.language,
      chapterTitles,
      chapterNumbers,
      filenameRange: parseFilenameRange(relativePath),
      coverageConfidence: chapterNumbers.length > 0 ? 'extracted-toc' : 'unknown',
      coverPath: null,
      inspectionError: ''
    }
  }
  return withLegacyInspectionSlot(() =>
    inspectLegacyEpub(path, relativePath, folderState, size, modifiedAt, id)
  )
}

async function inspectLegacyEpub(
  path: string,
  relativePath: string,
  folderState: LibraryFileRecord['folderState'],
  size: number,
  modifiedAt: string,
  id: string
): Promise<LibraryFileRecord> {
  const archive = await LazyEpubArchive.open(path)
  try {
  const container = object(xmlParser.parse(await archive.read('META-INF/container.xml')))
  const rootfiles = entries(object(object(container.container).rootfiles).rootfile)
  const packagePathValue = text(object(rootfiles[0])['@_full-path'])
  if (!packagePathValue) throw new Error('EPUB container has no package document.')
  const packagePath = xmlPath(packagePathValue)
  const packageObject = object(xmlParser.parse(await archive.read(packagePath)))
  const packageData = object(packageObject.package)
  const metadata = object(packageData.metadata)
  const manifestItems = entries(object(packageData.manifest).item).map(object)
  const manifestById = new Map(
    manifestItems.map((item) => [text(item['@_id']), item])
  )

  let coverPath: string | null = null
  const metas = entries(metadata.meta).map(object)
  const coverId = text(metas.find((item) => text(item['@_name']) === 'cover')?.['@_content'])
  const coverItem =
    manifestItems.find((item) => text(item['@_id']) === coverId) ??
    manifestItems.find((item) => text(item['@_properties']).split(/\s+/).includes('cover-image'))
  if (coverItem) coverPath = internalHref(packagePath, text(coverItem['@_href']))

  const spine = object(packageData.spine)
  const ncxItem = manifestById.get(text(spine['@_toc']))
  const navItem = manifestItems.find((item) => text(item['@_properties']).split(/\s+/).includes('nav'))
  const tocItem = ncxItem ?? navItem
  let titles: string[] = []
  if (tocItem) {
    const tocPath = internalHref(packagePath, text(tocItem['@_href']))
    const toc = await archive.readOptional(tocPath)
    if (toc) titles = tocLabels(toc).filter(keepChapterTitle)
  }

  if (titles.length === 0) {
    const spineItems = entries(spine.itemref).map(object)
    for (const spineItem of spineItems) {
      const manifestItem = manifestById.get(text(spineItem['@_idref']))
      if (!manifestItem) continue
      const contentPath = internalHref(packagePath, text(manifestItem['@_href']))
      const content = await archive.readOptional(contentPath)
      if (content) titles.push(...chapterHeadings(content))
    }
  }

  const uniqueTitles = [...new Set(titles)]
  const chapterNumbers = [...new Set(uniqueTitles
    .map((title) => parseChapterNumber(title))
    .filter((value): value is number => value !== null))]
    .sort((left, right) => left - right)
  const relativeParts = relativePath.split(/[\\/]/)
  const folderTitle = relativeParts.length > 2 ? relativeParts[1] : ''
  const filenameTitle = relativeParts[relativeParts.length - 1]
    .replace(/\.epub$/i, '')
    .replace(/\s+\d+\s*[-–]\s*\d+$/, '')
  const title =
    firstMetadataValue(metadata, 'title') ||
    filenameTitle ||
    folderTitle
  const creator = firstMetadataValue(metadata, 'creator')
  const author = /^(?:unknown|<unknown>)$/i.test(creator) ? '' : creator
  const language = firstMetadataValue(metadata, 'language')
  const confidence: CoverageConfidence =
    chapterNumbers.length > 0 ? 'extracted-toc' : parseFilenameRange(relativePath) ? 'filename' : 'unknown'

  return {
    id,
    path,
    relativePath,
    filename: relativePath.split(/[\\/]/).pop()!,
    format: 'EPUB',
    folderState,
    size,
    modifiedAt,
    novelTitle: title,
    author,
    language,
    chapterTitles: uniqueTitles,
    chapterNumbers,
    filenameRange: parseFilenameRange(relativePath),
    coverageConfidence: confidence,
    coverPath,
    inspectionError: ''
  }
  } finally {
    archive.close()
  }
}

class LazyEpubArchive {
  private readonly entries = new Map<string, yauzl.Entry>()

  private constructor(private readonly archive: yauzl.ZipFile) {}

  static async open(path: string): Promise<LazyEpubArchive> {
    const archive = await yauzl.openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true
    })
    const result = new LazyEpubArchive(archive)
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
          if (count > MAX_INSPECTOR_ZIP_ENTRIES) {
            cleanup()
            rejectEntries(new Error('EPUB contains too many ZIP entries.'))
            archive.close()
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

  async readOptional(name: string): Promise<string | null> {
    const entry = this.entries.get(name)
    if (!entry) return null
    if (entry.uncompressedSize > MAX_INSPECTOR_ENTRY_BYTES) {
      throw new Error('An EPUB inspection document exceeds the 16 MB safety limit.')
    }
    const stream = await this.archive.openReadStreamPromise(entry)
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += buffer.length
      if (length > MAX_INSPECTOR_ENTRY_BYTES) {
        stream.destroy(new Error('An EPUB inspection document exceeds the 16 MB safety limit.'))
        throw new Error('An EPUB inspection document exceeds the 16 MB safety limit.')
      }
      chunks.push(new Uint8Array(buffer))
    }
    return Buffer.concat(chunks, length).toString('utf8')
  }

  async read(name: string): Promise<string> {
    const value = await this.readOptional(name)
    if (value === null) throw new Error(`EPUB resource ${name} was not found.`)
    return value
  }

  close(): void {
    this.archive.close()
  }
}
