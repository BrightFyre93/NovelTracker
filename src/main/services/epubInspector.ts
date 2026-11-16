import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { load } from 'cheerio'
import JSZip from 'jszip'
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
  const archive = await JSZip.loadAsync(await readFile(path))
  const containerFile = archive.file('META-INF/container.xml')
  if (!containerFile) throw new Error('EPUB is missing META-INF/container.xml.')

  const container = object(xmlParser.parse(await containerFile.async('string')))
  const rootfiles = entries(object(object(container.container).rootfiles).rootfile)
  const packagePathValue = text(object(rootfiles[0])['@_full-path'])
  if (!packagePathValue) throw new Error('EPUB container has no package document.')
  const packagePath = xmlPath(packagePathValue)
  const packageFile = archive.file(packagePath)
  if (!packageFile) throw new Error('EPUB package document was not found.')

  const packageObject = object(xmlParser.parse(await packageFile.async('string')))
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
    const tocFile = archive.file(tocPath)
    if (tocFile) titles = tocLabels(await tocFile.async('string')).filter(keepChapterTitle)
  }

  if (titles.length === 0) {
    const spineItems = entries(spine.itemref).map(object)
    for (const spineItem of spineItems) {
      const manifestItem = manifestById.get(text(spineItem['@_idref']))
      if (!manifestItem) continue
      const contentPath = internalHref(packagePath, text(manifestItem['@_href']))
      const contentFile = archive.file(contentPath)
      if (contentFile) titles.push(...chapterHeadings(await contentFile.async('string')))
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
}
