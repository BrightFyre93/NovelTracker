import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import sharp from 'sharp'
import { XMLValidator } from 'fast-xml-parser'
import * as yauzl from 'yauzl'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterImage,
  EpubMergeProgress,
  EpubNovelMetadata
} from '../../shared/contracts'
import { isNodeError, OperationCancelledError, toMessage } from '../../shared/errors'
import {
  EPUB_IMAGE_TYPES,
  DEFAULT_EPUB_CSS,
  EPUB_MIMETYPE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_EPUB_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../shared/constants'
import { sanitizeEpubFilename, suggestEpubFilename } from '../../shared/epubFilename'
import { resizeSmallKindleCover } from './kindleCover'
import { atomicWriteFile, atomicWriteStream } from './atomicFile'
import {
  readCoverArtifact,
  readChapterArtifactDescriptor,
  writeChapterArtifact,
  writeCoverArtifact
} from './localStore'
import type { EpubPackagingInput } from './epubPackaging'

function escapeXml(value: string): string {
  let validXmlText = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        validXmlText += value[index] + value[index + 1]
        index += 1
      }
      continue
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue
    validXmlText += value[index]
  }
  return validXmlText
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

interface PackagedImage {
  id: string
  href: string
  mediaType: EpubImageMediaType
  data: Buffer
  isCover: boolean
}

interface PackagedImageManifestEntry {
  id: string
  href: string
  mediaType: EpubImageMediaType
  isCover: boolean
}

interface PackagedDiskImage extends PackagedImageManifestEntry {
  path: string
}

function decodeImage(image: ChapterImage): Buffer {
  if (
    !Object.prototype.hasOwnProperty.call(EPUB_IMAGE_TYPES, image.mediaType) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.dataBase64)
  ) {
    throw new Error('EPUB image data is invalid.')
  }
  const data = Buffer.from(image.dataBase64, 'base64')
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES || data.toString('base64') !== image.dataBase64) {
    throw new Error('EPUB image data exceeds its size limit or is malformed.')
  }
  return data
}

async function normalizeKindleImage(
  image: ChapterImage,
  isCover = false
): Promise<{ mediaType: EpubImageMediaType; data: Buffer }> {
  return normalizeKindleImageData(
    decodeImage(image),
    image.mediaType,
    isCover
  )
}

async function normalizeKindleImageData(
  data: Buffer,
  mediaType: EpubImageMediaType,
  isCover: boolean
): Promise<{ mediaType: EpubImageMediaType; data: Buffer }> {
  try {
    if (isCover) {
      const resizedCover = await resizeSmallKindleCover(data)
      if (resizedCover) return { mediaType: 'image/jpeg', data: resizedCover }
    }
    if (mediaType !== 'image/webp') return { mediaType, data }
    const jpeg = await sharp(data, { failOn: 'error', limitInputPixels: 40_000_000 })
      .rotate()
      .jpeg({ quality: 90 })
      .toBuffer()
    if (jpeg.length === 0) throw new Error('The converted image is empty.')
    return { mediaType: 'image/jpeg', data: jpeg }
  } catch (error) {
    const details = toMessage(error)
    throw new Error(
      isCover
        ? `A Kindle cover could not be normalized: ${details}`
        : `A WebP image could not be converted to a Kindle-compatible JPEG: ${details}`
    )
  }
}

async function collectPackagedImages(
  chapters: ChapterContent[],
  cover?: ChapterImage
): Promise<{ images: PackagedImage[]; chapterHrefs: string[][]; coverHref: string }> {
  const images: PackagedImage[] = []
  const byHash = new Map<string, PackagedImage>()
  let totalBytes = 0
  const addImage = async (image: ChapterImage, isCover = false): Promise<PackagedImage> => {
    const normalized = await normalizeKindleImage(image, isCover)
    const { data, mediaType } = normalized
    const hash = createHash('sha256').update(data).digest('hex')
    const existing = byHash.get(hash)
    if (existing) {
      existing.isCover ||= isCover
      return existing
    }
    totalBytes += data.length
    if (totalBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
      throw new Error('The selected chapters contain more than 128 MB of images.')
    }
    const extension = EPUB_IMAGE_TYPES[mediaType]
    const packaged = {
      id: `image-${images.length + 1}`,
      href: `images/${hash}.${extension}`,
      mediaType,
      data,
      isCover
    }
    images.push(packaged)
    byHash.set(hash, packaged)
    return packaged
  }

  const chapterHrefs: string[][] = []
  for (const chapter of chapters) {
    const hrefs: string[] = []
    for (const image of chapter.images ?? []) hrefs.push((await addImage(image)).href)
    chapterHrefs.push(hrefs)
  }
  const coverHref = cover ? (await addImage(cover, true)).href : ''
  return { images, chapterHrefs, coverHref }
}

function makeXhtml(
  title: string,
  paragraphs: string[],
  language: string,
  imageHrefs: string[] = [],
  blocks?: ChapterContentBlock[]
): string {
  const content: ChapterContentBlock[] = blocks ?? paragraphs.map((text) => ({ type: 'paragraph', text }))
  const body = content.map((block) => {
    if (block.type === 'paragraph') return `<p>${escapeXml(block.text)}</p>`
    const href = imageHrefs[block.imageIndex]
    if (!href) throw new Error('Chapter content references a missing image.')
    return `<figure><img src="../${escapeXml(href)}" alt="${escapeXml(block.alt)}"/></figure>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="../styles.css"/>
  </head>
  <body>
    <h1>${escapeXml(title)}</h1>
    ${body}
  </body>
</html>`
}

function makeNovelInfoXhtml(
  title: string,
  author: string,
  language: string,
  metadata: EpubNovelMetadata,
  coverHref: string
): string {
  const details = [
    ['Author', author],
    ['Alternative names', metadata.alternativeNames.join(', ')],
    ['Genre', metadata.genres.join(', ')],
    ['Source', metadata.source],
    ['Status', metadata.novelStatus]
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<p><strong>${label}:</strong> ${escapeXml(value)}</p>`)
    .join('\n')
  const cover = coverHref
    ? `<figure><img src="../${escapeXml(coverHref)}" alt="Cover of ${escapeXml(title)}"/></figure>`
    : ''
  const sourceLink = metadata.sourceUrl
    ? `<p><strong>Source page:</strong> <a href="${escapeXml(metadata.sourceUrl)}">${escapeXml(metadata.sourceUrl)}</a></p>`
    : ''
  const description = metadata.description
    ? `<section><h2>Description</h2><p>${escapeXml(metadata.description)}</p></section>`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${escapeXml(title)} - Novel Information</title>
    <link rel="stylesheet" type="text/css" href="../styles.css"/>
  </head>
  <body epub:type="frontmatter">
    <section epub:type="titlepage">
      <h1>${escapeXml(title)}</h1>
      ${cover}
      ${details}
      ${sourceLink}
    </section>
    ${description}
  </body>
</html>`
}

export function createEpubFilename(title: string, chapters: ChapterContent[], requestedFilename?: string): string {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')
  const firstChapter = chapters[0]
  const lastChapter = chapters[chapters.length - 1]
  if (!firstChapter || !lastChapter) {
    throw new Error('Select at least one chapter.')
  }
  return createEpubFilenameFromTitles(
    title,
    firstChapter.title,
    lastChapter.title,
    requestedFilename
  )
}

function createEpubFilenameFromTitles(
  title: string,
  firstTitle: string,
  lastTitle: string,
  requestedFilename?: string
): string {
  if (requestedFilename?.trim()) return sanitizeEpubFilename(requestedFilename)
  return suggestEpubFilename(title, firstTitle, lastTitle)
}

function createPackageFiles(
  title: string,
  author: string,
  language: string,
  chapters: readonly Pick<ChapterContent, 'title'>[],
  metadata: EpubNovelMetadata,
  images: readonly PackagedImageManifestEntry[]
) {
  const identifier = `urn:uuid:${randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    '<item id="novel-info" href="text/novel-info.xhtml" media-type="application/xhtml+xml"/>',
    ...images.map(
      (image) =>
        `<item id="${image.id}" href="${escapeXml(image.href)}" media-type="${image.mediaType}"${image.isCover ? ' properties="cover-image"' : ''}/>`
    ),
    ...chapters.map(
      (_, index) =>
        `<item id="chapter-${index + 1}" href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>`
    )
  ].join('\n    ')
  const spine = [
    '<itemref idref="novel-info"/>',
    ...chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`)
  ].join('\n    ')
  const navigation = [
    '<li><a href="text/novel-info.xhtml">Novel Information</a></li>',
    ...chapters
    .map(
      (_, index) =>
        `<li><a href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml">${escapeXml(chapters[index].title)}</a></li>`
    )
  ].join('\n      ')
  const descriptiveMetadata = [
    metadata.description ? `<dc:description>${escapeXml(metadata.description)}</dc:description>` : '',
    ...metadata.genres.map((genre) => `<dc:subject>${escapeXml(genre)}</dc:subject>`),
    metadata.sourceUrl ? `<dc:source>${escapeXml(metadata.sourceUrl)}</dc:source>` : ''
  ].filter(Boolean).join('\n    ')

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author || 'Unknown')}</dc:creator>
    <dc:language>${escapeXml(language)}</dc:language>
    ${descriptiveMetadata}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head><title>${escapeXml(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
      ${navigation}
      </ol>
    </nav>
  </body>
</html>`

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  return { identifier, modified, opf, nav, container }
}

function createArtifactPackageFiles(
  title: string,
  author: string,
  language: string,
  chapters: EpubPackagingInput['chapters'],
  metadata: EpubNovelMetadata,
  images: readonly PackagedImageManifestEntry[],
  readChapterTitle: (
    chapter: EpubPackagingInput['chapters'][number]
  ) => Promise<string>
): {
  container: string
  opf: Readable
  nav: Readable
  hashes: { opf: string; nav: string }
} {
  const identifier = `urn:uuid:${randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const hashes = { opf: '', nav: '' }
  const descriptiveMetadata = [
    metadata.description ? `<dc:description>${escapeXml(metadata.description)}</dc:description>` : '',
    ...metadata.genres.map((genre) => `<dc:subject>${escapeXml(genre)}</dc:subject>`),
    metadata.sourceUrl ? `<dc:source>${escapeXml(metadata.sourceUrl)}</dc:source>` : ''
  ].filter(Boolean).join('\n    ')
  const opfContent = (function* () {
    yield `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author || 'Unknown')}</dc:creator>
    <dc:language>${escapeXml(language)}</dc:language>
    ${descriptiveMetadata}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    <item id="novel-info" href="text/novel-info.xhtml" media-type="application/xhtml+xml"/>
`
    for (const image of images) {
      yield `    <item id="${image.id}" href="${escapeXml(image.href)}" media-type="${image.mediaType}"${image.isCover ? ' properties="cover-image"' : ''}/>\n`
    }
    for (let index = 0; index < chapters.length; index += 1) {
      yield `    <item id="chapter-${index + 1}" href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>\n`
    }
    yield `  </manifest>
  <spine>
    <itemref idref="novel-info"/>
`
    for (let index = 0; index < chapters.length; index += 1) {
      yield `    <itemref idref="chapter-${index + 1}"/>\n`
    }
    yield `  </spine>
</package>`
  })()
  const navContent = (async function* () {
    yield `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head><title>${escapeXml(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
      <li><a href="text/novel-info.xhtml">Novel Information</a></li>
`
    for (const [index, chapter] of chapters.entries()) {
      const chapterTitle = await readChapterTitle(chapter)
      yield `      <li><a href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml">${escapeXml(chapterTitle)}</a></li>\n`
    }
    yield `      </ol>
    </nav>
  </body>
</html>`
  })()
  const hashTextStream = (
    source: AsyncIterable<string> | Iterable<string>,
    recordHash: (hash: string) => void
  ): Readable => Readable.from((async function* () {
    const hash = createHash('sha256')
    for await (const chunk of source) {
      hash.update(chunk)
      yield chunk
    }
    recordHash(hash.digest('hex'))
  })())
  const opf = hashTextStream(opfContent, (hash) => { hashes.opf = hash })
  const nav = hashTextStream(navContent, (hash) => { hashes.nav = hash })
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  return { container, opf, nav, hashes }
}

async function createEpubArchive(
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  css = DEFAULT_EPUB_CSS,
  metadata: EpubNovelMetadata = createDefaultEpubNovelMetadata(),
): Promise<JSZip> {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')

  const zip = new JSZip()
  zip.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })
  const packagedImages = await collectPackagedImages(chapters, metadata.cover)
  const files = createPackageFiles(
    title.trim() || 'Untitled',
    author.trim(),
    language.trim() || 'en',
    chapters,
    metadata,
    packagedImages.images
  )
  zip.file('META-INF/container.xml', files.container)
  zip.file('package.opf', files.opf)
  zip.file('nav.xhtml', files.nav)
  zip.file('styles.css', css)
  zip.file(
    'text/novel-info.xhtml',
    makeNovelInfoXhtml(
      title.trim() || 'Untitled',
      author.trim(),
      language.trim() || 'en',
      metadata,
      packagedImages.coverHref
    )
  )
  for (const image of packagedImages.images) {
    zip.file(image.href, image.data, { compression: 'STORE' })
  }

  chapters.forEach((chapter, index) => {
    const filename = `text/chapter-${String(index + 1).padStart(4, '0')}.xhtml`
    zip.file(
      filename,
      makeXhtml(
        chapter.title,
        chapter.paragraphs,
        language.trim() || 'en',
        packagedImages.chapterHrefs[index],
        chapter.blocks
      )
    )
  })
  return zip
}

export async function buildEpubBuffer(
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  css = DEFAULT_EPUB_CSS,
  metadata: EpubNovelMetadata = createDefaultEpubNovelMetadata(),
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<Buffer> {
  const zip = await createEpubArchive(
    title,
    author,
    language,
    chapters,
    css,
    metadata
  )
  onProgress?.({ stage: 'packaging', percentage: 0, message: 'Compressing EPUB files…' })
  let lastPackagePercentage = -1
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  }, (metadata) => {
    const percentage = Math.round(metadata.percent)
    if (percentage === lastPackagePercentage) return
    lastPackagePercentage = percentage
    onProgress?.({
      stage: 'packaging',
      percentage,
      message: `Compressing EPUB files · ${percentage}%`
    })
  })
  await validateEpubBuffer(buffer, chapters.length, onProgress)
  return buffer
}

export async function validateEpubBuffer(
  buffer: Buffer,
  chapterCount: number,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<void> {
  const archive = await JSZip.loadAsync(buffer)
  const required = [
    'mimetype',
    'META-INF/container.xml',
    'package.opf',
    'nav.xhtml',
    'styles.css',
    'text/novel-info.xhtml'
  ]
  for (const path of required) {
    if (!archive.file(path)) throw new Error(`EPUB validation failed: missing ${path}.`)
  }

  const names = Object.keys(archive.files)
  const chapterFiles = names.filter((name) => /^text\/chapter-\d{4}\.xhtml$/.test(name))
  if (chapterFiles.length !== chapterCount) {
    throw new Error('EPUB validation failed: the chapter count does not match the package.')
  }

  const mimeType = await archive.file('mimetype')!.async('string')
  if (mimeType !== EPUB_MIMETYPE) throw new Error('EPUB validation failed: invalid mimetype entry.')

  const firstFilenameLength = buffer.readUInt16LE(26)
  const firstFilename = buffer.subarray(30, 30 + firstFilenameLength).toString('utf8')
  if (firstFilename !== 'mimetype' || buffer.readUInt16LE(8) !== 0) {
    throw new Error('EPUB validation failed: mimetype must be the first uncompressed ZIP entry.')
  }

  const packageXml = await archive.file('package.opf')!.async('string')
  if (!/<spine>\s*<itemref idref="novel-info"\/>/.test(packageXml)) {
    throw new Error('EPUB validation failed: the novel information page must be first in the reading order.')
  }

  const webpImages = names.filter((name) => /^images\/.*\.webp$/i.test(name))
  if (webpImages.length > 0) {
    throw new Error('EPUB validation failed: WebP images are not supported for Kindle output.')
  }
  const imageFiles = names.filter((name) => /^images\/[a-f0-9]{64}\.(?:jpg|png|gif)$/.test(name))
  const xhtmlFiles = ['text/novel-info.xhtml', ...chapterFiles]
  onProgress?.({ stage: 'validating', percentage: 0, message: 'Validating EPUB resources…' })
  const xhtmlUpdateInterval = Math.max(1, Math.ceil(xhtmlFiles.length / 100))
  for (const [index, path] of xhtmlFiles.entries()) {
    const contents = await archive.file(path)!.async('string')
    const imageReferences = [...contents.matchAll(/<img\b[^>]*\bsrc="\.\.\/([^"]+)"/g)]
    for (const [, imagePath] of imageReferences) {
      if (!archive.file(imagePath)) throw new Error(`EPUB validation failed: missing image resource ${imagePath}.`)
    }
    if (/<img\b[^>]*\bsrc="(?!\.\.\/)[^"]+"/.test(contents)) {
      throw new Error(`EPUB validation failed: ${path} contains a nonlocal image reference.`)
    }
    if ((index + 1) % xhtmlUpdateInterval === 0 || index + 1 === xhtmlFiles.length) {
      onProgress?.({
        stage: 'validating',
        percentage: Math.round(((index + 1) / xhtmlFiles.length) * 80),
        message: `Validating chapter resources · ${index + 1} of ${xhtmlFiles.length} documents`
      })
    }
  }

  const manifestImages = imageFiles.filter((path) => packageXml.includes(`href="${path}"`))
  if (manifestImages.length !== imageFiles.length) {
    throw new Error('EPUB validation failed: an image resource is missing from the package manifest.')
  }

  const xmlFiles = ['META-INF/container.xml', 'package.opf', 'nav.xhtml', ...xhtmlFiles]
  const xmlUpdateInterval = Math.max(1, Math.ceil(xmlFiles.length / 20))
  for (const [index, path] of xmlFiles.entries()) {
    const contents = await archive.file(path)!.async('string')
    const result = XMLValidator.validate(contents)
    if (result !== true) throw new Error(`EPUB validation failed: invalid XML in ${path}.`)
    if ((index + 1) % xmlUpdateInterval === 0 || index + 1 === xmlFiles.length) {
      onProgress?.({
        stage: 'validating',
        percentage: 80 + Math.round(((index + 1) / xmlFiles.length) * 20),
        message: `Checking EPUB XML · ${index + 1} of ${xmlFiles.length} documents`
      })
    }
  }
}

export async function validateEpubFile(
  path: string,
  chapterCount: number,
  imageCount: number,
  expectedHashes: { opf: string; nav: string },
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<void> {
  const archive = await yauzl.openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true
  })

  await new Promise<void>((resolveValidation, rejectValidation) => {
    const requiredEntries = new Set<string>()
    const imageFiles = new Set<string>()
    let packageHash = ''
    let navHash = ''
    let mimeType = ''
    let chapterFileCount = 0
    let entryIndex = 0
    let settled = false

    const cleanup = (): void => {
      archive.off('entry', onEntry)
      archive.off('end', onEnd)
      archive.off('error', onError)
      archive.close()
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectValidation(
        error instanceof Error ? error : new Error(String(error))
      )
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveValidation()
    }

    const onEnd = (): void => {
      try {
        const required = [
          'mimetype',
          'META-INF/container.xml',
          'package.opf',
          'nav.xhtml',
          'styles.css',
          'text/novel-info.xhtml'
        ]
        for (const name of required) {
          if (!requiredEntries.has(name)) {
            throw new Error(`EPUB validation failed: missing ${name}.`)
          }
        }
        if (chapterFileCount !== chapterCount) {
          throw new Error(
            'EPUB validation failed: the chapter count does not match the package.'
          )
        }
        if (mimeType !== EPUB_MIMETYPE) {
          throw new Error('EPUB validation failed: invalid mimetype entry.')
        }
        if (packageHash !== expectedHashes.opf || navHash !== expectedHashes.nav) {
          throw new Error('EPUB validation failed: the generated package metadata changed while writing.')
        }
        if (imageFiles.size !== imageCount) {
          throw new Error('EPUB validation failed: the image count does not match the package.')
        }
        succeed()
      } catch (error) {
        fail(error)
      }
    }

    const onError = (error: Error): void => fail(error)
    const onEntry = (entry: yauzl.Entry): void => {
      void (async () => {
        const name = entry.fileName
        const isChapterFile = /^text\/chapter-\d{4,}\.xhtml$/.test(name)
        const isImageFile = /^images\/[a-f0-9]{64}\.(?:jpg|png|gif)$/.test(name)
        if ([
          'mimetype',
          'META-INF/container.xml',
          'package.opf',
          'nav.xhtml',
          'styles.css',
          'text/novel-info.xhtml'
        ].includes(name)) {
          requiredEntries.add(name)
        }
        if (isChapterFile) chapterFileCount += 1
        if (isImageFile) imageFiles.add(name)
        if (/^images\/.*\.webp$/i.test(name)) {
          throw new Error('EPUB validation failed: WebP images are not supported for Kindle output.')
        }
        if (entryIndex === 0 && (name !== 'mimetype' || entry.compressionMethod !== 0)) {
          throw new Error(
            'EPUB validation failed: mimetype must be the first uncompressed ZIP entry.'
          )
        }
        entryIndex += 1

        const isXhtml = name.endsWith('.xhtml')
        const isXml =
          isXhtml ||
          name === 'META-INF/container.xml'
        const stream = await archive.openReadStreamPromise(entry)
        if (name === 'package.opf' || name === 'nav.xhtml') {
          const hash = createHash('sha256')
          for await (const chunk of stream) {
            const data: unknown = chunk
            if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
              hash.update(data)
            } else if (typeof data === 'string') {
              hash.update(data)
            } else {
              throw new Error(`EPUB validation failed: invalid stream data in ${name}.`)
            }
          }
          if (name === 'package.opf') packageHash = hash.digest('hex')
          else navHash = hash.digest('hex')
        } else if (name === 'mimetype' || isXml) {
          const chunks: Uint8Array[] = []
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
          const contents = Buffer.concat(chunks).toString('utf8')
          if (name === 'mimetype') mimeType = contents
          if (isXml) {
            const result = XMLValidator.validate(contents)
            if (result !== true) {
              throw new Error(`EPUB validation failed: invalid XML in ${name}.`)
            }
          }
          if (isXhtml) {
            for (const match of contents.matchAll(
              /<img\b[^>]*\bsrc="\.\.\/([^"]+)"/g
            )) {
              const imagePath = match[1]
              if (imagePath && !imageFiles.has(imagePath)) {
                throw new Error(`EPUB validation failed: missing image resource ${imagePath}.`)
              }
            }
            if (/<img\b[^>]*\bsrc="(?!\.\.\/)[^"]+"/.test(contents)) {
              throw new Error(
                `EPUB validation failed: ${name} contains a nonlocal image reference.`
              )
            }
          }
        } else {
          for await (const chunk of stream) void chunk
        }

        if (isXml || name === 'mimetype') {
          onProgress?.({
            stage: 'validating',
            percentage: Math.round(
              (entryIndex / Math.max(archive.entryCount, 1)) * 100
            ),
            message: `Validating ${name}…`
          })
        }
        archive.readEntry()
      })().catch(fail)
    }

    archive.on('entry', onEntry)
    archive.once('end', onEnd)
    archive.once('error', onError)
    archive.readEntry()
  })
}

async function targetFileExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path)
    if (!details.isFile() && !details.isSymbolicLink()) {
      throw new Error('A folder or other item already uses this EPUB filename.')
    }
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

async function publishEpub(
  directory: string,
  filename: string,
  contents: Readable,
  chapterCount: number,
  imageCount: number,
  expectedHashes: { opf: string; nav: string },
  signal?: AbortSignal,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  const outputPath = join(directory, filename)
  if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
  const overwroteExistingFile = await targetFileExists(outputPath)
  const onAbort = (): void => {
    contents.destroy(new OperationCancelledError('EPUB creation was cancelled.'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await atomicWriteStream(outputPath, contents, async (temporaryPath) => {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      await validateEpubFile(
        temporaryPath,
        chapterCount,
        imageCount,
        expectedHashes,
        onProgress
      )
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return { outputPath, overwroteExistingFile }
}

function createDefaultEpubNovelMetadata(): EpubNovelMetadata {
  return {
    description: '',
    alternativeNames: [],
    genres: [],
    source: '',
    novelStatus: '',
    sourceUrl: ''
  }
}

async function writeEpubArchive(
  outputDirectory: string,
  filename: string,
  zip: JSZip,
  chapterCount: number,
  imageCount: number,
  expectedHashes: { opf: string; nav: string },
  signal?: AbortSignal,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  if (signal?.aborted) {
    throw new OperationCancelledError('EPUB creation was cancelled.')
  }
  onProgress?.({ stage: 'packaging', percentage: 0, message: 'Compressing EPUB files…' })
  let lastPackagePercentage = -1
  const contents = zip.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  }, (progress) => {
    const percentage = Math.round(progress.percent)
    if (percentage === lastPackagePercentage) return
    lastPackagePercentage = percentage
    onProgress?.({
      stage: 'packaging',
      percentage,
      message: `Compressing EPUB files · ${percentage}%`
    })
  }) as Readable
  onProgress?.({ stage: 'saving', percentage: 0, message: `Writing ${filename}…` })
  const result = await publishEpub(
    outputDirectory,
    filename,
    contents,
    chapterCount,
    imageCount,
    expectedHashes,
    signal,
    onProgress
  )
  onProgress?.({ stage: 'saving', percentage: 100, message: 'Writing complete.' })
  return result
}

export async function writeEpub(
  outputDirectory: string,
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  requestedFilename?: string,
  signal?: AbortSignal,
  css = DEFAULT_EPUB_CSS,
  metadata: EpubNovelMetadata = createDefaultEpubNovelMetadata(),
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')
  const dataDirectory = await mkdtemp(join(tmpdir(), 'novel-tracker-epub-source-'))
  const queueItemId = randomUUID()
  try {
    for (const chapter of chapters) {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      await writeChapterArtifact(dataDirectory, queueItemId, chapter)
    }
    const metadataWithoutCover = { ...metadata }
    delete metadataWithoutCover.cover
    if (metadata.cover) {
      await writeCoverArtifact(dataDirectory, queueItemId, metadata.cover)
    }
    return await writeEpubFromArtifactStore(
      {
        dataDirectory,
        queueItemId,
        chapters: chapters.map(({ title, url }) => ({ title, url })),
        outputDirectory,
        title,
        author,
        language,
        filename: requestedFilename ?? '',
        css,
        includeCover: Boolean(metadata.cover),
        metadata: metadataWithoutCover
      },
      signal,
      onProgress
    )
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
}

export async function writeEpubFromArtifactStore(
  input: EpubPackagingInput,
  signal?: AbortSignal,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  if (input.chapters.length === 0) {
    throw new Error('Select at least one chapter.')
  }
  const firstChapter = input.chapters[0]
  const lastChapter = input.chapters[input.chapters.length - 1]
  if (!firstChapter || !lastChapter) {
    throw new Error('Select at least one chapter.')
  }
  const tempDirectory = await mkdtemp(join(tmpdir(), 'novel-tracker-epub-'))
  const packagedImages: PackagedDiskImage[] = []
  const imagesByHash = new Map<string, PackagedDiskImage>()
  const sourceImages = new Map<string, PackagedDiskImage>()
  let totalImageBytes = 0

  const addImage = async (
    data: Buffer,
    mediaType: EpubImageMediaType,
    sourceHash: string,
    sourcePath: string | null,
    isCover = false
  ): Promise<PackagedDiskImage> => {
    const sourceKey = `${mediaType}:${sourceHash}:${isCover ? 'cover' : 'chapter'}`
    const priorSource = sourceImages.get(sourceKey)
    if (priorSource) {
      if (isCover) priorSource.isCover = true
      return priorSource
    }

    const normalized = await normalizeKindleImageData(data, mediaType, isCover)
    const hash = createHash('sha256').update(normalized.data).digest('hex')
    let packaged = imagesByHash.get(hash)
    if (packaged) {
      packaged.isCover ||= isCover
    } else {
      totalImageBytes += normalized.data.length
      if (totalImageBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
        throw new Error('The selected chapters contain more than 128 MB of images.')
      }
      const extension = EPUB_IMAGE_TYPES[normalized.mediaType]
      const imagePath =
        sourcePath && normalized.data === data
          ? sourcePath
          : join(tempDirectory, `image-${hash}.${extension}`)
      if (imagePath !== sourcePath) {
        await atomicWriteFile(imagePath, normalized.data)
      }
      packaged = {
        id: `image-${packagedImages.length + 1}`,
        href: `images/${hash}.${extension}`,
        mediaType: normalized.mediaType,
        isCover,
        path: imagePath
      }
      packagedImages.push(packaged)
      imagesByHash.set(hash, packaged)
    }
    sourceImages.set(sourceKey, packaged)
    return packaged
  }

  try {
    let firstChapterTitle = ''
    let lastChapterTitle = ''
    for (const [index, chapter] of input.chapters.entries()) {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      const descriptor = await readChapterArtifactDescriptor(
        input.dataDirectory,
        input.queueItemId,
        chapter.url
      )
      if (!descriptor || descriptor.url !== chapter.url) {
        throw new Error(`Saved chapter content is missing for "${chapter.title}".`)
      }
      if (index === 0) firstChapterTitle = descriptor.title
      lastChapterTitle = descriptor.title
      for (const image of descriptor.images) {
        const data = await readFile(image.path)
        await addImage(
          data,
          image.mediaType,
          image.sha256,
          image.path
        )
      }
      if ((index + 1) % 25 === 0 || index + 1 === input.chapters.length) {
        onProgress?.({
          stage: 'packaging',
          percentage: Math.round(((index + 1) / input.chapters.length) * 10),
          message: `Preparing chapter artifacts · ${index + 1} of ${input.chapters.length}`
        })
      }
    }

    let coverHref = ''
    if (input.includeCover) {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      const cover = await readCoverArtifact(input.dataDirectory, input.queueItemId)
      if (!cover) {
        throw new Error('The saved cover content is missing; retry this EPUB online before repackaging.')
      }
      const coverData = decodeImage(cover)
      const packagedCover = await addImage(
        coverData,
        cover.mediaType,
        createHash('sha256').update(coverData).digest('hex'),
        null,
        true
      )
      coverHref = packagedCover.href
    }

    const title = input.title.trim() || 'Untitled'
    const language = input.language.trim() || 'en'
    const files = createArtifactPackageFiles(
      title,
      input.author.trim(),
      language,
      input.chapters,
      input.metadata,
      packagedImages,
      async (chapter) => {
        if (signal?.aborted) {
          throw new OperationCancelledError('EPUB creation was cancelled.')
        }
        const descriptor = await readChapterArtifactDescriptor(
          input.dataDirectory,
          input.queueItemId,
          chapter.url
        )
        if (!descriptor || descriptor.url !== chapter.url) {
          throw new Error(`Saved chapter content is missing for "${chapter.title}".`)
        }
        return descriptor.title
      }
    )
    const zip = new JSZip()
    zip.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })
    zip.file('META-INF/container.xml', files.container)
    zip.file('package.opf', files.opf, { binary: false, compression: 'DEFLATE' })
    zip.file('nav.xhtml', files.nav, { binary: false, compression: 'DEFLATE' })
    zip.file('styles.css', input.css)
    for (const image of packagedImages) {
      zip.file(image.href, createReadStream(image.path), {
        binary: true,
        compression: 'STORE'
      })
    }
    zip.file(
      'text/novel-info.xhtml',
      makeNovelInfoXhtml(
        title,
        input.author.trim(),
        language,
        input.metadata,
        coverHref
      )
    )
    for (const [index, chapter] of input.chapters.entries()) {
      const content = Readable.from((async function* () {
        if (signal?.aborted) {
          throw new OperationCancelledError('EPUB creation was cancelled.')
        }
        const descriptor = await readChapterArtifactDescriptor(
          input.dataDirectory,
          input.queueItemId,
          chapter.url
        )
        if (!descriptor || descriptor.url !== chapter.url) {
          throw new Error(`Saved chapter content is missing for "${chapter.title}".`)
        }
        const imageHrefs = descriptor.images.map((image) => {
          const packaged = sourceImages.get(
            `${image.mediaType}:${image.sha256}:chapter`
          )
          if (!packaged) {
            throw new Error(`A saved image for "${chapter.title}" was not packaged.`)
          }
          return packaged.href
        })
        yield makeXhtml(
          descriptor.title,
          descriptor.paragraphs,
          language,
          imageHrefs,
          descriptor.blocks
        )
      })())
      zip.file(
        `text/chapter-${String(index + 1).padStart(4, '0')}.xhtml`,
        content,
        { binary: false, compression: 'DEFLATE' }
      )
    }

    const filename = createEpubFilenameFromTitles(
      title,
      firstChapterTitle || firstChapter.title,
      lastChapterTitle || lastChapter.title,
      input.filename
    )
    return await writeEpubArchive(
      input.outputDirectory,
      filename,
      zip,
      input.chapters.length,
      packagedImages.length,
      files.hashes,
      signal,
      onProgress
    )
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
