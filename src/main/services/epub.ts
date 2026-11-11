import { randomUUID } from 'node:crypto'
import { link, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import type { ChapterContent } from '../../shared/contracts'
import { DEFAULT_EPUB_CSS } from '../../shared/defaultEpubCss'
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

function makeXhtml(title: string, paragraphs: string[], language: string): string {
  const body = paragraphs.map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('\n')
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

export function createEpubFilename(title: string, chapters: ChapterContent[], requestedFilename?: string): string {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')
  if (requestedFilename?.trim()) return sanitizeEpubFilename(requestedFilename)
  return suggestEpubFilename(title, chapters[0].title, chapters[chapters.length - 1].title)
}

function createPackageFiles(title: string, author: string, language: string, chapters: ChapterContent[]) {
  const identifier = `urn:uuid:${randomUUID()}`
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    ...chapters.map(
      (_, index) =>
        `<item id="chapter-${index + 1}" href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>`
    )
  ].join('\n    ')
  const spine = chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join('\n    ')
  const navigation = chapters
    .map(
      (_, index) =>
        `<li><a href="text/chapter-${String(index + 1).padStart(4, '0')}.xhtml">${escapeXml(chapters[index].title)}</a></li>`
    )
    .join('\n      ')

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author || 'Unknown')}</dc:creator>
    <dc:language>${escapeXml(language)}</dc:language>
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
  chapters: ChapterContent[]
): Promise<Buffer> {
  if (chapters.length === 0) throw new Error('Select at least one chapter.')

  const zip = new JSZip()
  zip.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })
  const files = createPackageFiles(title.trim() || 'Untitled', author.trim(), language.trim() || 'en', chapters)
  zip.file('META-INF/container.xml', files.container)
  zip.file('package.opf', files.opf)
  zip.file('nav.xhtml', files.nav)
  zip.file('styles.css', DEFAULT_EPUB_CSS)

  chapters.forEach((chapter, index) => {
    const filename = `text/chapter-${String(index + 1).padStart(4, '0')}.xhtml`
    zip.file(filename, makeXhtml(chapter.title, chapter.paragraphs, language.trim() || 'en'))
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
  const required = ['mimetype', 'META-INF/container.xml', 'package.opf', 'nav.xhtml', 'styles.css']
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

  const xmlFiles = ['META-INF/container.xml', 'package.opf', 'nav.xhtml', ...chapterFiles]
  for (const path of xmlFiles) {
    const contents = await archive.file(path)!.async('string')
    const result = XMLValidator.validate(contents)
    if (result !== true) throw new Error(`EPUB validation failed: invalid XML in ${path}.`)
  }
}

async function publishWithoutOverwrite(directory: string, filename: string, contents: Buffer): Promise<{
  outputPath: string
  createdNumberedCopy: boolean
}> {
  const base = filename.replace(/\.epub$/i, '')
  const temporaryPath = join(directory, `.novel-tracker-${randomUUID()}.tmp`)
  await writeFile(temporaryPath, contents, { flag: 'wx' })

  try {
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const numbered = suffix > 1
      const candidate = join(directory, `${base}${numbered ? ` (${suffix})` : ''}.epub`)
      try {
        await link(temporaryPath, candidate)
        return { outputPath: candidate, createdNumberedCopy: numbered }
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('Could not find an unused EPUB filename in the selected folder.')
  } finally {
    await unlink(temporaryPath)
  }
}

export async function writeEpub(
  outputDirectory: string,
  title: string,
  author: string,
  language: string,
  chapters: ChapterContent[],
  requestedFilename?: string
): Promise<{ outputPath: string; createdNumberedCopy: boolean }> {
  const buffer = await buildEpubBuffer(title, author, language, chapters)
  const filename = createEpubFilename(title, chapters, requestedFilename)
  return publishWithoutOverwrite(outputDirectory, filename, buffer)
}
