import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import * as yauzl from 'yauzl'
import type {
  ChapterContent,
  ChapterContentBlock,
  ChapterImage,
  ChapterInlineNode,
  EpubMergeProgress,
  EpubNovelMetadata
} from '../../shared/contracts'
import {
  isNodeError,
  OperationCancelledError,
  toMessage
} from '../../shared/errors'
import {
  EPUB_IMAGE_TYPES,
  DEFAULT_EPUB_CSS,
  EPUB_MIMETYPE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_EPUB_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../shared/constants'
import {
  sanitizeEpubFilename,
  suggestEpubFilename
} from '../../shared/epubFilename'
import { normalizeEpubImage } from './imagePipeline'
import { atomicWriteFile, atomicWriteStream } from './atomicFile'
import {
  readCoverArtifact,
  readChapterArtifactDescriptor,
  writeChapterArtifact,
  writeCoverArtifact
} from './localStore'
import type { EpubPackagingInput } from './epubPackaging'
import { DEFAULT_EPUB_OUTPUT_OPTIONS } from '../../shared/epubOutputOptions'

function escapeXml(value: string): string {
  let validXmlText = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        validXmlText += value[index] + value[index + 1]
        index += 1
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue
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
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      image.dataBase64
    )
  ) {
    throw new Error('EPUB image data is invalid.')
  }
  const data = Buffer.from(image.dataBase64, 'base64')
  if (
    data.length === 0 ||
    data.length > MAX_IMAGE_BYTES ||
    data.toString('base64') !== image.dataBase64
  ) {
    throw new Error('EPUB image data exceeds its size limit or is malformed.')
  }
  return data
}

async function normalizeKindleImageData(
  data: Buffer,
  mediaType: EpubImageMediaType,
  isCover: boolean,
  options: EpubPackagingInput['outputOptions']
): Promise<{ mediaType: EpubImageMediaType; data: Buffer }> {
  try {
    return await normalizeEpubImage(data, mediaType, options, isCover)
  } catch (error) {
    const details = toMessage(error)
    throw new Error(
      `${isCover ? 'A Kindle cover' : 'A chapter image'} could not be normalized: ${details}`
    )
  }
}

function makeXhtml(
  title: string,
  paragraphs: string[],
  language: string,
  imageHrefs: string[] = [],
  blocks?: ChapterContentBlock[],
  skipImages = false,
  imageSourceUrls: string[] = [],
  includeImageAttribution = false
): string {
  const content: ChapterContentBlock[] =
    blocks ?? paragraphs.map((text) => ({ type: 'paragraph', text }))
  const body = content
    .map((block) => {
      if (block.type === 'paragraph') {
        return `<p>${renderInlineContent(block.inline, block.text)}</p>`
      }
      if (block.type === 'heading') {
        return `<h${block.level}>${renderInlineContent(block.inline, block.text)}</h${block.level}>`
      }
      if (block.type === 'blockquote') {
        return `<blockquote><p>${renderInlineContent(block.inline, block.text)}</p></blockquote>`
      }
      if (block.type === 'list') {
        const tagName = block.ordered ? 'ol' : 'ul'
        const items = block.items
          .map(
            (item) => `<li>${renderInlineContent(item.inline, item.text)}</li>`
          )
          .join('\n')
        return `<${tagName}>${items}</${tagName}>`
      }
      if (block.type === 'scene-break') return '<hr/>'
      const href = imageHrefs[block.imageIndex]
      if (!href) {
        if (skipImages) return ''
        throw new Error('Chapter content references a missing image.')
      }
      const image = `<img src="../${escapeXml(href)}" alt="${escapeXml(block.alt)}"/>`
      const attribution = includeImageAttribution
        ? safeAttributionUrl(imageSourceUrls[block.imageIndex])
        : null
      return `<figure>${attribution ? `<a href="${escapeXml(attribution)}">${image}</a>` : image}</figure>`
    })
    .join('\n')
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

function renderInlineContent(
  nodes: ChapterInlineNode[] | undefined,
  fallbackText: string
): string {
  if (!nodes) return escapeXml(fallbackText)
  return nodes
    .map((node) => {
      if (node.type === 'text') return escapeXml(node.text)
      if (node.type === 'break') return '<br/>'
      const children = renderInlineContent(node.children, '')
      if (node.type === 'emphasis' || node.type === 'strong') {
        const tagName = node.type === 'emphasis' ? 'em' : 'strong'
        return `<${tagName}>${children}</${tagName}>`
      }

      let href: URL
      try {
        href = new URL(node.href)
      } catch {
        throw new Error('Chapter content contains an invalid link.')
      }
      if (
        (href.protocol !== 'http:' && href.protocol !== 'https:') ||
        href.username ||
        href.password
      ) {
        throw new Error('Chapter content contains an unsafe link.')
      }
      return `<a href="${escapeXml(href.href)}">${children}</a>`
    })
    .join('')
}

function safeAttributionUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

function makeNovelInfoXhtml(
  title: string,
  author: string,
  language: string,
  metadata: EpubNovelMetadata,
  coverHref: string,
  includeImageAttribution: boolean
): string {
  const details = [
    ['Author', author],
    ['Alternative names', metadata.alternativeNames.join(', ')],
    ['Genre', metadata.genres.join(', ')],
    ['Source', metadata.source],
    ['Status', metadata.novelStatus]
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<p><strong>${label}:</strong> ${escapeXml(value)}</p>`
    )
    .join('\n')
  const coverImage = coverHref
    ? `<img src="../${escapeXml(coverHref)}" alt="Cover of ${escapeXml(title)}"/>`
    : ''
  const coverAttribution = includeImageAttribution
    ? safeAttributionUrl(metadata.cover?.sourceUrl)
    : null
  const cover = coverImage
    ? `<figure>${coverAttribution ? `<a href="${escapeXml(coverAttribution)}">${coverImage}</a>` : coverImage}</figure>`
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

function createEpubFilenameFromTitles(
  title: string,
  firstTitle: string,
  lastTitle: string,
  requestedFilename?: string
): string {
  if (requestedFilename?.trim()) return sanitizeEpubFilename(requestedFilename)
  return suggestEpubFilename(title, firstTitle, lastTitle)
}

function makeChapterListXhtml(
  title: string,
  language: string,
  chapters: EpubPackagingInput['chapters']
): Readable {
  return Readable.from(
    (function* () {
      yield `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head><title>${escapeXml(title)} — Chapter List</title></head>
  <body><h1>Chapter List</h1><ol>
`
      for (const [index, chapter] of chapters.entries()) {
        yield `    <li><a href="chapter-${String(index + 1).padStart(4, '0')}.xhtml">${escapeXml(chapter.title)}</a></li>\n`
      }
      yield '  </ol></body>\n</html>'
    })()
  )
}

function createArtifactPackageFiles(
  title: string,
  author: string,
  language: string,
  chapters: EpubPackagingInput['chapters'],
  metadata: EpubNovelMetadata,
  images: readonly PackagedImageManifestEntry[],
  identifierSeedValue: string,
  includeNovelInfoPage: boolean,
  includeChapterListPage: boolean
): {
  container: string
  opf: Readable
  nav: Readable
  hashes: { opf: string; nav: string }
} {
  const firstChapter = chapters[0]
  const lastChapter = chapters[chapters.length - 1]
  const identifierSeed = [
    identifierSeedValue.trim() || metadata.sourceUrl.trim(),
    firstChapter?.url ?? '',
    lastChapter?.url ?? ''
  ].join('\n')
  const identifier = `urn:sha256:${createHash('sha256').update(identifierSeed).digest('hex')}`
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const hashes = { opf: '', nav: '' }
  const descriptiveMetadata = [
    metadata.description
      ? `<dc:description>${escapeXml(metadata.description)}</dc:description>`
      : '',
    ...metadata.genres.map(
      (genre) => `<dc:subject>${escapeXml(genre)}</dc:subject>`
    ),
    metadata.sourceUrl
      ? `<dc:source>${escapeXml(metadata.sourceUrl)}</dc:source>`
      : ''
  ]
    .filter(Boolean)
    .join('\n    ')
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
`
    if (includeNovelInfoPage) {
      yield '    <item id="novel-info" href="text/novel-info.xhtml" media-type="application/xhtml+xml"/>\n'
    }
    if (includeChapterListPage) {
      yield '    <item id="chapter-list" href="text/chapter-list.xhtml" media-type="application/xhtml+xml"/>\n'
    }
    for (const image of images) {
      yield `    <item id="${image.id}" href="${escapeXml(image.href)}" media-type="${image.mediaType}"${image.isCover ? ' properties="cover-image"' : ''}/>\n`
    }
    for (let index = 0; index < chapters.length; index += 1) {
      yield `    <item id="chapter-${index + 1}" href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>\n`
    }
    yield `  </manifest>
  <spine>
`
    if (includeNovelInfoPage) yield '    <itemref idref="novel-info"/>\n'
    if (includeChapterListPage) yield '    <itemref idref="chapter-list"/>\n'
    for (let index = 0; index < chapters.length; index += 1) {
      yield `    <itemref idref="chapter-${index + 1}"/>\n`
    }
    yield `  </spine>
</package>`
  })()
  const navContent = (function* () {
    yield `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head><title>${escapeXml(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
`
    if (includeNovelInfoPage) {
      yield '      <li><a href="text/novel-info.xhtml">Novel Information</a></li>\n'
    }
    if (includeChapterListPage) {
      yield '      <li><a href="text/chapter-list.xhtml">Chapter List</a></li>\n'
    }
    for (const [index, chapter] of chapters.entries()) {
      yield `      <li><a href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml">${escapeXml(chapter.title)}</a></li>\n`
    }
    yield `      </ol>
    </nav>
  </body>
</html>`
  })()
  const hashTextStream = (
    source: AsyncIterable<string> | Iterable<string>,
    recordHash: (hash: string) => void
  ): Readable =>
    Readable.from(
      (async function* () {
        const hash = createHash('sha256')
        for await (const chunk of source) {
          hash.update(chunk)
          yield chunk
        }
        recordHash(hash.digest('hex'))
      })()
    )
  const opf = hashTextStream(opfContent, (hash) => {
    hashes.opf = hash
  })
  const nav = hashTextStream(navContent, (hash) => {
    hashes.nav = hash
  })
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  return { container, opf, nav, hashes }
}

export async function validateEpubFile(
  path: string,
  chapterCount: number,
  imageCount: number,
  expectedHashes: { opf: string; nav: string },
  pages: Pick<EpubPackagingInput['outputOptions'], 'includeNovelInfoPage' | 'includeChapterListPage'>,
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
          ...(pages.includeNovelInfoPage ? ['text/novel-info.xhtml'] : []),
          ...(pages.includeChapterListPage ? ['text/chapter-list.xhtml'] : [])
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
        if (
          packageHash !== expectedHashes.opf ||
          navHash !== expectedHashes.nav
        ) {
          throw new Error(
            'EPUB validation failed: the generated package metadata changed while writing.'
          )
        }
        if (imageFiles.size !== imageCount) {
          throw new Error(
            'EPUB validation failed: the image count does not match the package.'
          )
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
        if (
          [
            'mimetype',
            'META-INF/container.xml',
            'package.opf',
            'nav.xhtml',
            'styles.css',
          ...(pages.includeNovelInfoPage ? ['text/novel-info.xhtml'] : []),
          ...(pages.includeChapterListPage ? ['text/chapter-list.xhtml'] : [])
          ].includes(name)
        ) {
          requiredEntries.add(name)
        }
        if (isChapterFile) chapterFileCount += 1
        if (isImageFile) imageFiles.add(name)
        if (/^images\/.*\.webp$/i.test(name)) {
          throw new Error(
            'EPUB validation failed: WebP images are not supported for Kindle output.'
          )
        }
        if (
          entryIndex === 0 &&
          (name !== 'mimetype' || entry.compressionMethod !== 0)
        ) {
          throw new Error(
            'EPUB validation failed: mimetype must be the first uncompressed ZIP entry.'
          )
        }
        entryIndex += 1

        const isXhtml = name.endsWith('.xhtml')
        const isXml = isXhtml || name === 'META-INF/container.xml'
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
              throw new Error(
                `EPUB validation failed: invalid stream data in ${name}.`
              )
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
                throw new Error(
                  `EPUB validation failed: missing image resource ${imagePath}.`
                )
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
  pages: Pick<EpubPackagingInput['outputOptions'], 'includeNovelInfoPage' | 'includeChapterListPage'>,
  signal?: AbortSignal,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  const outputPath = join(directory, filename)
  if (signal?.aborted)
    throw new OperationCancelledError('EPUB creation was cancelled.')
  const overwroteExistingFile = await targetFileExists(outputPath)
  const onAbort = (): void => {
    contents.destroy(
      new OperationCancelledError('EPUB creation was cancelled.')
    )
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
        pages,
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
  pages: Pick<EpubPackagingInput['outputOptions'], 'includeNovelInfoPage' | 'includeChapterListPage'>,
  signal?: AbortSignal,
  onProgress?: (progress: EpubMergeProgress) => void
): Promise<{ outputPath: string; overwroteExistingFile: boolean }> {
  if (signal?.aborted) {
    throw new OperationCancelledError('EPUB creation was cancelled.')
  }
  onProgress?.({
    stage: 'packaging',
    percentage: 0,
    message: 'Compressing EPUB files…'
  })
  let lastPackagePercentage = -1
  const contents = zip.generateNodeStream(
    {
      type: 'nodebuffer',
      streamFiles: true,
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    },
    (progress) => {
      const percentage = Math.round(progress.percent)
      if (percentage === lastPackagePercentage) return
      lastPackagePercentage = percentage
      onProgress?.({
        stage: 'packaging',
        percentage,
        message: `Compressing EPUB files · ${percentage}%`
      })
    }
  ) as Readable
  onProgress?.({
    stage: 'saving',
    percentage: 0,
    message: `Writing ${filename}…`
  })
  const result = await publishEpub(
    outputDirectory,
    filename,
    contents,
    chapterCount,
    imageCount,
    expectedHashes,
    pages,
    signal,
    onProgress
  )
  onProgress?.({
    stage: 'saving',
    percentage: 100,
    message: 'Writing complete.'
  })
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
  const dataDirectory = await mkdtemp(
    join(tmpdir(), 'novel-tracker-epub-source-')
  )
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
        filename: requestedFilename ?? '',
        outputOptions: {
          ...DEFAULT_EPUB_OUTPUT_OPTIONS,
          css,
          language,
          identifierSeed: metadata.sourceUrl
        },
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

    const normalized = await normalizeKindleImageData(
      data,
      mediaType,
      isCover,
      input.outputOptions
    )
    const hash = createHash('sha256').update(normalized.data).digest('hex')
    let packaged = imagesByHash.get(hash)
    if (packaged) {
      packaged.isCover ||= isCover
    } else {
      totalImageBytes += normalized.data.length
      if (totalImageBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
        throw new Error(
          'The selected chapters contain more than 128 MB of images.'
        )
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
    for (const [index, chapter] of input.chapters.entries()) {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      const descriptor = await readChapterArtifactDescriptor(
        input.dataDirectory,
        input.queueItemId,
        chapter.url,
        { verifyImages: false }
      )
      if (!descriptor || descriptor.url !== chapter.url) {
        throw new Error(
          `Saved chapter content is missing for "${chapter.title}".`
        )
      }
      for (const image of input.outputOptions.skipImages ? [] : descriptor.images) {
        const data = await readFile(image.path)
        await addImage(data, image.mediaType, image.sha256, image.path)
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
    if (input.includeCover && !input.outputOptions.skipImages) {
      if (signal?.aborted) {
        throw new OperationCancelledError('EPUB creation was cancelled.')
      }
      const cover = await readCoverArtifact(
        input.dataDirectory,
        input.queueItemId
      )
      if (!cover) {
        throw new Error(
          'The saved cover content is missing; retry this EPUB online before repackaging.'
        )
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
    const language = input.outputOptions.language.trim() || 'en'
    const files = createArtifactPackageFiles(
      title,
      input.author.trim(),
      language,
      input.chapters,
      input.metadata,
      packagedImages,
      input.outputOptions.identifierSeed,
      input.outputOptions.includeNovelInfoPage,
      input.outputOptions.includeChapterListPage
    )
    const zip = new JSZip()
    zip.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })
    zip.file('META-INF/container.xml', files.container)
    zip.file('package.opf', files.opf, {
      binary: false,
      compression: 'DEFLATE'
    })
    zip.file('nav.xhtml', files.nav, { binary: false, compression: 'DEFLATE' })
    zip.file('styles.css', input.outputOptions.css)
    for (const image of packagedImages) {
      zip.file(image.href, createReadStream(image.path), {
        binary: true,
        compression: 'STORE'
      })
    }
    if (input.outputOptions.includeNovelInfoPage) {
      zip.file(
        'text/novel-info.xhtml',
        makeNovelInfoXhtml(
          title,
          input.author.trim(),
          language,
          input.metadata,
          coverHref,
          input.outputOptions.includeImageAttribution
        )
      )
    }
    if (input.outputOptions.includeChapterListPage) {
      zip.file(
        'text/chapter-list.xhtml',
        makeChapterListXhtml(title, language, input.chapters),
        { binary: false, compression: 'DEFLATE' }
      )
    }
    for (const [index, chapter] of input.chapters.entries()) {
      const content = Readable.from(
        (async function* () {
          if (signal?.aborted) {
            throw new OperationCancelledError('EPUB creation was cancelled.')
          }
          const descriptor = await readChapterArtifactDescriptor(
            input.dataDirectory,
            input.queueItemId,
            chapter.url,
            { verifyImages: false }
          )
          if (!descriptor || descriptor.url !== chapter.url) {
            throw new Error(
              `Saved chapter content is missing for "${chapter.title}".`
            )
          }
          const imageHrefs = input.outputOptions.skipImages
            ? []
            : descriptor.images.map((image) => {
                const packaged = sourceImages.get(
                  `${image.mediaType}:${image.sha256}:chapter`
                )
                if (!packaged) {
                  throw new Error(
                    `A saved image for "${chapter.title}" was not packaged.`
                  )
                }
                return packaged.href
              })
          const imageSourceUrls = input.outputOptions.skipImages
            ? []
            : descriptor.images.map((image) => image.sourceUrl)
          yield makeXhtml(
            descriptor.title,
            descriptor.paragraphs,
            language,
            imageHrefs,
            descriptor.blocks,
            input.outputOptions.skipImages,
            imageSourceUrls,
            input.outputOptions.includeImageAttribution
          )
        })()
      )
      zip.file(
        `text/chapter-${String(index + 1).padStart(4, '0')}.xhtml`,
        content,
        { binary: false, compression: 'DEFLATE' }
      )
    }

    const filename = createEpubFilenameFromTitles(
      title,
      firstChapter.title,
      lastChapter.title,
      input.filename
    )
    return await writeEpubArchive(
      input.outputDirectory,
      filename,
      zip,
      input.chapters.length,
      packagedImages.length,
      files.hashes,
      input.outputOptions,
      signal,
      onProgress
    )
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
