import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { load } from 'cheerio'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { CoverageConfidence, LibraryFileRecord } from '../../shared/contracts'

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true
})

type XmlObject = Record<string, unknown>

function object(value: unknown): XmlObject {
  return typeof value === 'object' && value !== null ? value as XmlObject : {}
}

function entries(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  const nestedText = object(value)['#text']
  return nestedText === undefined ? '' : text(nestedText)
}

function xmlPath(value: string): string {
  const path = posix.normalize(value.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!path || path === '.' || path.startsWith('../')) throw new Error('EPUB contains an invalid internal path.')
  return path
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

function chapterNumber(value: string): number | undefined {
  const match =
    value.match(/\b(?:chapter|ch\.?|episode|part)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i) ??
    value.match(/^\s*#?\s*(\d+(?:\.\d+)?)(?=\s|$|[:.-])/)
  if (match) return Number(match[1])
  if (/\bprologue\b/i.test(value)) return 0
  return undefined
}

function filenameRange(filename: string): { start: number; end: number } | null {
  const match = filename.match(/(?:^|[\s_-])(\d{1,7})\s*[-–]\s*(\d{1,7})(?:\D|$)/)
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
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
    .filter((heading) => chapterNumber(heading) !== undefined || /\b(?:prologue|epilogue|interlude)\b/i.test(heading))
}

function keepChapterTitle(value: string): boolean {
  return chapterNumber(value) !== undefined || /\b(?:prologue|epilogue|interlude)\b/i.test(value)
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
  const chapterNumbers = [...new Set(uniqueTitles.map(chapterNumber).filter((value): value is number => value !== undefined))]
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
    chapterNumbers.length > 0 ? 'extracted-toc' : filenameRange(relativePath) ? 'filename' : 'unknown'

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
    pageCount: null,
    chapterTitles: uniqueTitles,
    chapterNumbers,
    chapterLocations: [],
    filenameRange: filenameRange(relativePath),
    coverageConfidence: confidence,
    pdfClassification: null,
    coverPath,
    inspectionError: ''
  }
}
