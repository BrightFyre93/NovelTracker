import { createHash, randomUUID } from 'node:crypto'
import { lstat, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterImage,
  EpubNovelMetadata
} from '../../shared/contracts'
import { DEFAULT_EPUB_CSS } from '../../shared/defaultEpubCss'
import {
  EPUB_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_EPUB_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../shared/epubImages'
import { sanitizeEpubFilename, suggestEpubFilename } from '../../shared/epubFilename'

const EPUB_MIMETYPE = 'application/epub+zip'

function escapeXml(value: string): string {
  return value
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

function collectPackagedImages(
  chapters: ChapterContent[],
  cover?: ChapterImage
): { images: PackagedImage[]; chapterHrefs: string[][]; coverHref: string } {
  const images: PackagedImage[] = []
  const byHash = new Map<string, PackagedImage>()
  let totalBytes = 0
  const addImage = (image: ChapterImage, isCover = false): PackagedImage => {
    const data = decodeImage(image)
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
    const extension = EPUB_IMAGE_TYPES[image.mediaType]
    const packaged = {
      id: `image-${images.length + 1}`,
      href: `images/${hash}.${extension}`,
      mediaType: image.mediaType,
      data,
      isCover
    }
    images.push(packaged)
    byHash.set(hash, packaged)
    return packaged
  }

  const chapterHrefs = chapters.map((chapter) =>
    (chapter.images ?? []).map((image) => addImage(image).href)
  )
  const coverHref = cover ? addImage(cover, true).href : ''
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
  if (requestedFilename?.trim()) return sanitizeEpubFilename(requestedFilename)
  return suggestEpubFilename(title, chapters[0].title, chapters[chapters.length - 1].title)
}

function createPackageFiles(
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  metadata: EpubNovelMetadata,
  images: PackagedImage[]
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

export async function buildEpubBuffer(
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  css = DEFAULT_EPUB_CSS,
  metadata: EpubNovelMetadata = {
    description: '',
    alternativeNames: [],
    genres: [],
    source: '',
    novelStatus: '',
    sourceUrl: ''
  }
): Promise<Buffer> {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')

  const zip = new JSZip()
  zip.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })
  const packagedImages = collectPackagedImages(chapters, metadata.cover)
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
  for (const image of packagedImages.images) zip.file(image.href, image.data)

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

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  await validateEpubBuffer(buffer, chapters.length)
  return buffer
}

export async function validateEpubBuffer(buffer: Buffer, chapterCount: number): Promise<void> {
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

  const imageFiles = names.filter((name) => /^images\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(name))
  const xhtmlFiles = ['text/novel-info.xhtml', ...chapterFiles]
  for (const path of xhtmlFiles) {
    const contents = await archive.file(path)!.async('string')
    const imageReferences = [...contents.matchAll(/<img\b[^>]*\bsrc="\.\.\/([^"]+)"/g)]
    for (const [, imagePath] of imageReferences) {
      if (!archive.file(imagePath)) throw new Error(`EPUB validation failed: missing image resource ${imagePath}.`)
    }
    if (/<img\b[^>]*\bsrc="(?!\.\.\/)[^"]+"/.test(contents)) {
      throw new Error(`EPUB validation failed: ${path} contains a nonlocal image reference.`)
    }
  }

  const manifestImages = imageFiles.filter((path) => packageXml.includes(`href="${path}"`))
  if (manifestImages.length !== imageFiles.length) {
    throw new Error('EPUB validation failed: an image resource is missing from the package manifest.')
  }

  const xmlFiles = ['META-INF/container.xml', 'package.opf', 'nav.xhtml', ...xhtmlFiles]
  for (const path of xmlFiles) {
    const contents = await archive.file(path)!.async('string')
    const result = XMLValidator.validate(contents)
    if (result !== true) throw new Error(`EPUB validation failed: invalid XML in ${path}.`)
  }
}

async function targetFileExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path)
    if (!details.isFile() && !details.isSymbolicLink()) {
      throw new Error('A folder or other item already uses this EPUB filename.')
    }
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function publishEpub(
  directory: string,
  filename: string,
  contents: Buffer,
  signal?: AbortSignal
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  const temporaryPath = join(directory, `.novel-tracker-${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' })
    if (signal?.aborted) throw new Error('EPUB creation was cancelled.')
    const outputPath = join(directory, filename)
    const overwroteExistingFile = await targetFileExists(outputPath)
    if (signal?.aborted) throw new Error('EPUB creation was cancelled.')
    await rename(temporaryPath, outputPath)
    return { outputPath, overwroteExistingFile }
  } finally {
    await rm(temporaryPath, { force: true })
  }
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
  metadata: EpubNovelMetadata = {
    description: '',
    alternativeNames: [],
    genres: [],
    source: '',
    novelStatus: '',
    sourceUrl: ''
  }
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  const buffer = await buildEpubBuffer(title, author, language, chapters, css, metadata)
  if (signal?.aborted) throw new Error('EPUB creation was cancelled.')
  const filename = createEpubFilename(title, chapters, requestedFilename)
  return publishEpub(outputDirectory, filename, buffer, signal)
}
