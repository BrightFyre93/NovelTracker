import { lstat, mkdtemp, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import * as yauzl from 'yauzl'
import type { EpubRepairProgress, EpubRepairResult } from '../../shared/contracts'
import {
  EPUB_MIMETYPE,
  MAX_CHAPTER_IMAGE_BYTES,
  MAX_EPUB_INPUT_BYTES,
  MAX_EPUB_MERGE_ENTRY_BYTES,
  MAX_EPUB_ZIP_ENTRIES,
  MAX_TOTAL_EPUB_IMAGE_BYTES
} from '../../shared/constants'
import { resizeSmallKindleCover } from './kindleCover'
import { repairEscapedMarkupInXhtml } from './escapedMarkupRepair'
import { convertWebpToJpeg } from './webpToJpeg'
import { atomicWriteFile, atomicWriteStream } from './atomicFile'
import { toMessage } from '../../shared/errors'
import {
  createXmlParser,
  object,
  resolveArchivePath as resolveEpubArchivePath,
  text,
  xmlObjects
} from './epubArchiveUtils'

const MAX_REPAIR_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

const xmlParser = createXmlParser()

interface RepairArchive {
  archive: yauzl.ZipFile
  entries: yauzl.Entry[]
  entriesByName: Map<string, yauzl.Entry>
}

function resolveArchivePath(documentPath: string, href: string): string | null {
  return resolveEpubArchivePath(documentPath, href, {
    malformedPath: 'The EPUB contains a malformed internal resource path.',
    unsafePath: 'The EPUB contains an unsafe internal resource path.'
  })
}

async function openRepairArchive(path: string): Promise<RepairArchive> {
  const archive = await yauzl.openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true
  })
  if (archive.entryCount > MAX_EPUB_ZIP_ENTRIES) {
    archive.close()
    throw new Error(`The EPUB has too many ZIP entries to repair safely (limit ${MAX_EPUB_ZIP_ENTRIES.toLocaleString()}).`)
  }

  try {
    const entries = await new Promise<yauzl.Entry[]>((resolveEntries, rejectEntries) => {
      const collected: yauzl.Entry[] = []
      const onEntry = (entry: yauzl.Entry): void => {
        collected.push(entry)
        archive.readEntry()
      }
      const cleanup = (): void => {
        archive.off('entry', onEntry)
        archive.off('end', onEnd)
        archive.off('error', onError)
      }
      const onEnd = (): void => {
        cleanup()
        resolveEntries(collected)
      }
      const onError = (error: Error): void => {
        cleanup()
        rejectEntries(error)
      }
      archive.on('entry', onEntry)
      archive.once('end', onEnd)
      archive.once('error', onError)
      archive.readEntry()
    })
    const entriesByName = new Map<string, yauzl.Entry>()
    for (const entry of entries) {
      if (entriesByName.has(entry.fileName)) {
        throw new Error(`The EPUB contains a duplicate ZIP entry: ${entry.fileName}.`)
      }
      entriesByName.set(entry.fileName, entry)
    }
    return { archive, entries, entriesByName }
  } catch (error) {
    archive.close()
    throw error
  }
}

async function readEntry(
  archive: yauzl.ZipFile,
  entry: yauzl.Entry,
  limit: number
): Promise<Buffer> {
  const stream = await archive.openReadStreamPromise(entry)
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += data.length
    if (length > limit) {
      throw new Error(`An EPUB resource exceeds the ${limit.toLocaleString()} byte repair limit.`)
    }
    chunks.push(data)
  }
  return Buffer.concat(chunks, length)
}

function findCoverImagePath(packageXml: string, packagePath: string): string | null {
  const parsedPackage: unknown = xmlParser.parse(packageXml)
  const packageData = object(object(parsedPackage).package)
  const metadata = object(packageData.metadata)
  const manifestItems = xmlObjects(object(packageData.manifest).item)
  const coverId = text(
    xmlObjects(metadata.meta).find((item) => text(item['@_name']).toLowerCase() === 'cover')?.['@_content']
  )
  const coverItem =
    manifestItems.find((item) => coverId && text(item['@_id']) === coverId) ??
    manifestItems.find((item) => text(item['@_properties']).split(/\s+/).includes('cover-image'))
  if (!coverItem || !text(coverItem['@_media-type']).toLowerCase().startsWith('image/')) return null
  if (text(coverItem['@_media-type']).toLowerCase() === 'image/svg+xml') return null
  const href = text(coverItem['@_href'])
  return href ? resolveArchivePath(packagePath, href) : null
}

function rewriteReference(
  reference: string,
  documentPath: string,
  replacements: Map<string, string>
): string {
  const suffixIndex = reference.search(/[?#]/)
  const pathPart = suffixIndex < 0 ? reference : reference.slice(0, suffixIndex)
  const suffix = suffixIndex < 0 ? '' : reference.slice(suffixIndex)
  const resolvedPath = resolveArchivePath(documentPath, pathPart)
  if (!resolvedPath) return reference
  const replacement = replacements.get(resolvedPath)
  if (!replacement) return reference
  const relativePath = posix.relative(posix.dirname(documentPath), replacement)
  const encodedPath = relativePath.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `${encodedPath}${suffix}`
}

function rewriteDocumentReferences(
  contents: string,
  documentPath: string,
  replacements: Map<string, string>
): string {
  const rewrite = (reference: string) => rewriteReference(reference, documentPath, replacements)
  let updated = contents.replace(
    /(\b(?:href|src|xlink:href)\s*=\s*)(["'])(.*?)\2/gi,
    (_match, prefix: string, quote: string, reference: string) =>
      `${prefix}${quote}${rewrite(reference)}${quote}`
  )
  updated = updated.replace(
    /(\bsrcset\s*=\s*)(["'])(.*?)\2/gi,
    (_match, prefix: string, quote: string, value: string) => {
      if (/^\s*data:/i.test(value)) return `${prefix}${quote}${value}${quote}`
      const candidates = value.split(',').map((candidate: string) => {
        const match = candidate.match(/^(\s*)(\S+)([\s\S]*)$/)
        if (!match) return candidate
        return `${match[1]}${rewrite(match[2])}${match[3]}`
      })
      return `${prefix}${quote}${candidates.join(',')}${quote}`
    }
  )
  return updated.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi,
    (_match, quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) => {
      const reference = (quote ? quoted : unquoted)?.trim() ?? ''
      const updatedReference = rewrite(reference)
      return `url(${quote ? `${quote}${updatedReference}${quote}` : updatedReference})`
    }
  )
}

function rewriteManifestMediaTypes(
  packageXml: string,
  packagePath: string,
  replacements: Map<string, string>
): string {
  return packageXml.replace(/<item\b[^>]*>/gi, (item) => {
    const href = item.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (!href || !resolveArchivePath(packagePath, href) ||
      !replacements.has(resolveArchivePath(packagePath, href) ?? '')) {
      return item
    }
    if (/\bmedia-type\s*=/i.test(item)) {
      return item.replace(
        /\bmedia-type\s*=\s*(["']).*?\1/i,
        (_match, quote: string) => `media-type=${quote}image/jpeg${quote}`
      )
    }
    return item.replace(/\/?>$/, (close) =>
      close.startsWith('/') ? ` media-type="image/jpeg"/>` : ` media-type="image/jpeg">`
    )
  })
}

function isTextResource(path: string): boolean {
  return /\.(?:css|htm|html|ncx|opf|svg|xhtml|xml)$/i.test(path)
}

function jpegReplacementPath(sourcePath: string, occupiedPaths: Set<string>): string {
  const outputPath = sourcePath.replace(/\.[^.]+$/, '.jpg')
  if (outputPath !== sourcePath && !occupiedPaths.has(outputPath)) return outputPath
  const extensionless = sourcePath.replace(/\.[^.]+$/, '')
  let suffix = 1
  while (occupiedPaths.has(`${extensionless}-repaired-${suffix}.jpg`)) suffix += 1
  return `${extensionless}-repaired-${suffix}.jpg`
}

function validateXml(contents: string, path: string): void {
  const result = XMLValidator.validate(contents)
  if (result !== true) throw new Error(`EPUB repair cannot continue: ${path} is not valid XML.`)
}

async function validateRepairedEpubFile(
  path: string,
  packagePath: string,
  replacements: Map<string, string>
): Promise<void> {
  const archive = await yauzl.openPromise(path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true
  })

  await new Promise<void>((resolveValidation, rejectValidation) => {
    const replacementPresence = new Map<string, boolean>()
    for (const [sourcePath, replacementPath] of replacements) {
      replacementPresence.set(sourcePath, false)
      replacementPresence.set(replacementPath, false)
    }
    let packageXml = ''
    let mimetype = ''
    let hasPackage = false
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
      rejectValidation(error instanceof Error ? error : new Error(String(error)))
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveValidation()
    }
    const onEnd = (): void => {
      try {
        if (mimetype !== EPUB_MIMETYPE) {
          throw new Error('The repaired EPUB failed validation: its mimetype entry is invalid.')
        }
        if (!hasPackage) {
          throw new Error('The repaired EPUB failed validation: its package document is missing.')
        }
        validateXml(packageXml, packagePath)
        if (/media-type\s*=\s*(["'])image\/webp\1/i.test(packageXml)) {
          throw new Error('The repaired EPUB failed validation: unsupported WebP resources remain.')
        }
        for (const [sourcePath, replacementPath] of replacements) {
          if (replacementPresence.get(sourcePath) ||
            !replacementPresence.get(replacementPath)) {
            throw new Error(`The repaired EPUB failed validation for image ${sourcePath}.`)
          }
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
        if (entryIndex === 0 && (name !== 'mimetype' || entry.compressionMethod !== 0)) {
          throw new Error(
            'The repaired EPUB failed validation: mimetype is not the first uncompressed ZIP entry.'
          )
        }
        entryIndex += 1
        if (/\.webp$/i.test(name)) {
          throw new Error('The repaired EPUB failed validation: unsupported WebP resources remain.')
        }
        if (replacementPresence.has(name)) replacementPresence.set(name, true)

        const stream = await archive.openReadStreamPromise(entry)
        if (name === 'mimetype' || name === packagePath) {
          const chunks: Uint8Array[] = []
          let length = 0
          const limit = name === 'mimetype' ? 128 : MAX_EPUB_MERGE_ENTRY_BYTES
          for await (const chunk of stream) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            length += data.length
            if (length > limit) {
              throw new Error(`The repaired EPUB failed validation: ${name} exceeds its size limit.`)
            }
            chunks.push(data)
          }
          const contents = Buffer.concat(chunks, length).toString('utf8')
          if (name === 'mimetype') mimetype = contents
          else {
            packageXml = contents
            hasPackage = true
          }
        } else {
          for await (const chunk of stream) void chunk
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

export async function repairEpubFile(
  inputPath: string,
  outputPath: string,
  onProgress: (progress: EpubRepairProgress) => void = () => undefined
): Promise<EpubRepairResult> {
  const inputDetails = await lstat(inputPath)
  if (inputDetails.isSymbolicLink() || !inputDetails.isFile()) {
    throw new Error('The selected EPUB is not a regular file.')
  }
  if (inputDetails.size > MAX_EPUB_INPUT_BYTES) {
    throw new Error(`The selected EPUB exceeds the ${MAX_EPUB_INPUT_BYTES / (1024 * 1024)} MB repair limit.`)
  }

  onProgress({ stage: 'checking', percentage: 2, message: 'Checking EPUB archive…' })
  const { archive, entries, entriesByName } = await openRepairArchive(inputPath)
  let tempDirectory: string | null = null
  try {
  tempDirectory = await mkdtemp(join(tmpdir(), 'novel-tracker-repair-'))
  let totalUncompressedBytes = 0
  for (const entry of entries) {
    if (entry.fileName.endsWith('/')) continue
    const entryLimit = /\.webp$/i.test(entry.fileName)
      ? MAX_CHAPTER_IMAGE_BYTES
      : isTextResource(entry.fileName)
        ? MAX_EPUB_MERGE_ENTRY_BYTES
        : MAX_REPAIR_ENTRY_BYTES
    if (entry.uncompressedSize > entryLimit) {
      throw new Error(`An EPUB resource exceeds the ${entryLimit.toLocaleString()} byte repair limit.`)
    }
    totalUncompressedBytes += entry.uncompressedSize
    if (totalUncompressedBytes > MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('The EPUB exceeds the total uncompressed repair limit.')
    }
  }

  const containerFile = entriesByName.get('META-INF/container.xml')
  if (!containerFile || containerFile.fileName.endsWith('/')) {
    throw new Error('This archive is missing META-INF/container.xml and cannot be repaired as an EPUB.')
  }
  const containerXml = (await readEntry(archive, containerFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  validateXml(containerXml, 'META-INF/container.xml')
  const parsedContainer: unknown = xmlParser.parse(containerXml)
  const rootfilesValue = object(object(object(parsedContainer).container).rootfiles).rootfile
  const rootfile = xmlObjects(rootfilesValue)[0]
  const packagePath = text(object(rootfile)['@_full-path'])
  if (!packagePath || packagePath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(packagePath)) {
    throw new Error('The EPUB container does not identify a safe package document.')
  }
  const normalizedPackagePath = posix.normalize(packagePath.replace(/\\/g, '/'))
  if (normalizedPackagePath === '..' || normalizedPackagePath.startsWith('../')) {
    throw new Error('The EPUB package document is outside its archive.')
  }
  const packageEntry = entriesByName.get(normalizedPackagePath)
  if (!packageEntry || packageEntry.fileName.endsWith('/')) {
    throw new Error(`The EPUB package document ${normalizedPackagePath} is missing.`)
  }
  let packageXml = (await readEntry(archive, packageEntry, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  validateXml(packageXml, normalizedPackagePath)

  const webpEntries = entries.filter((entry) => !entry.fileName.endsWith('/') && /\.webp$/i.test(entry.fileName))
  const coverImagePath = findCoverImagePath(packageXml, normalizedPackagePath)
  const coverEntry = coverImagePath ? entriesByName.get(coverImagePath) ?? null : null
  const replacements = new Map<string, string>()
  const repairedImageFiles = new Map<string, string>()
  const occupiedPaths = new Set(entries.map((entry) => entry.fileName))
  let totalImageBytes = 0
  let upscaledCover = false
  let repairedMarkupChapters = 0
  let repairedMarkupParagraphs = 0

  if (coverImagePath && coverEntry && !coverEntry.fileName.endsWith('/') && !/\.webp$/i.test(coverImagePath)) {
    const data = await readEntry(archive, coverEntry, MAX_REPAIR_ENTRY_BYTES)
    let resizedCover: Buffer | null
    try {
      resizedCover = await resizeSmallKindleCover(data)
    } catch (error) {
      throw new Error(
        `Could not normalize cover ${coverImagePath}: ${toMessage(error)}`
      )
    }
    if (resizedCover) {
      const outputPath = jpegReplacementPath(coverImagePath, occupiedPaths)
      occupiedPaths.add(outputPath)
      replacements.set(coverImagePath, outputPath)
      const imagePath = join(tempDirectory, `repaired-${repairedImageFiles.size}.jpg`)
      await atomicWriteFile(imagePath, resizedCover)
      repairedImageFiles.set(coverImagePath, imagePath)
      totalImageBytes += resizedCover.length
      if (totalImageBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
        throw new Error(`Converted images exceed the ${MAX_TOTAL_EPUB_IMAGE_BYTES / (1024 * 1024)} MB repair limit.`)
      }
      upscaledCover = true
    }
  }

  for (const [index, entry] of webpEntries.entries()) {
    onProgress({
      stage: 'converting-images',
      percentage: 5 + Math.round(((index + 1) / Math.max(1, webpEntries.length)) * 55),
      message: `Converting WebP image ${index + 1} of ${webpEntries.length} to JPEG…`
    })
    const data = await readEntry(archive, entry, MAX_CHAPTER_IMAGE_BYTES)
    if (data.length === 0 || data.length > MAX_CHAPTER_IMAGE_BYTES) {
      throw new Error(`${entry.fileName} exceeds the ${MAX_CHAPTER_IMAGE_BYTES / (1024 * 1024)} MB image repair limit.`)
    }
    const outputPath = jpegReplacementPath(entry.fileName, occupiedPaths)
    occupiedPaths.add(outputPath)
    replacements.set(entry.fileName, outputPath)
    let jpeg: Buffer
    try {
      const resizedCover = entry.fileName === coverImagePath ? await resizeSmallKindleCover(data) : null
      jpeg = resizedCover ?? await convertWebpToJpeg(data)
      if (resizedCover) upscaledCover = true
    } catch (error) {
      throw new Error(
        `Could not convert ${entry.fileName} to a Kindle-compatible JPEG: ${toMessage(error)}`
      )
    }
    totalImageBytes += jpeg.length
    if (totalImageBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
      throw new Error(`Converted images exceed the ${MAX_TOTAL_EPUB_IMAGE_BYTES / (1024 * 1024)} MB repair limit.`)
    }
    const imagePath = join(tempDirectory, `repaired-${repairedImageFiles.size}.jpg`)
    await atomicWriteFile(imagePath, jpeg)
    repairedImageFiles.set(entry.fileName, imagePath)
  }

  if (replacements.size > 0) {
    packageXml = rewriteManifestMediaTypes(packageXml, normalizedPackagePath, replacements)
    packageXml = rewriteDocumentReferences(packageXml, normalizedPackagePath, replacements)
    packageXml = packageXml.replace(
      /\bmedia-type\s*=\s*(["'])image\/webp\1/gi,
      (_match, quote: string) => `media-type=${quote}image/jpeg${quote}`
    )
    validateXml(packageXml, normalizedPackagePath)
  }

  const mimeEntry = entriesByName.get('mimetype')
  const currentMimetype = mimeEntry && !mimeEntry.fileName.endsWith('/')
    ? (await readEntry(archive, mimeEntry, 128)).toString('utf8')
    : ''
  const fixedMimetype = currentMimetype !== EPUB_MIMETYPE || entries[0]?.fileName !== 'mimetype'
  const repairedArchive = new JSZip()
  repairedArchive.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })

  for (const [index, entry] of entries.entries()) {
    const name = entry.fileName
    const date = entry.getLastModDate()
    if (name === 'mimetype') continue
    if (name.endsWith('/')) {
      repairedArchive.file(name, null, { dir: true, date, createFolders: false })
      continue
    }
    if ((index + 1) % Math.max(1, Math.ceil(entries.length / 100)) === 0) {
      onProgress({
        stage: 'rewriting',
        percentage: 60 + Math.round(((index + 1) / entries.length) * 25),
        message: `Rewriting EPUB resources · ${index + 1} of ${entries.length}`
      })
    }
    const replacementImagePath = repairedImageFiles.get(name)
    if (replacementImagePath) {
      const replacementPath = replacements.get(name)
      if (!replacementPath) throw new Error(`The repaired path for ${name} is missing.`)
      repairedArchive.file(replacementPath, createReadStream(replacementImagePath), {
        binary: true,
        date,
        createFolders: false
      })
      continue
    }
    if (name === normalizedPackagePath) {
      repairedArchive.file(name, packageXml, { date, createFolders: false })
      continue
    }
    if (isTextResource(name)) {
      const data = await readEntry(archive, entry, MAX_EPUB_MERGE_ENTRY_BYTES)
      let contents = data.toString('utf8')
      if (replacements.size > 0) contents = rewriteDocumentReferences(contents, name, replacements)
      if (/\.x?html?$/i.test(name)) {
        // Chapters where escaped page markup (ads, footer, scripts) ended up as text.
        const markupRepair = repairEscapedMarkupInXhtml(contents)
        if (markupRepair.paragraphCount > 0) {
          validateXml(markupRepair.contents, name)
          contents = markupRepair.contents
          repairedMarkupChapters += 1
          repairedMarkupParagraphs += markupRepair.paragraphCount
        }
      }
      repairedArchive.file(name, contents, { date, createFolders: false })
      continue
    }
    const content = Readable.from((async function* () {
      const stream = await archive.openReadStreamPromise(entry)
      for await (const chunk of stream) yield chunk
    })())
    repairedArchive.file(name, content, {
      binary: true,
      date,
      createFolders: false
    })
  }

  onProgress({ stage: 'validating', percentage: 88, message: 'Validating repaired EPUB package…' })
  const output = repairedArchive.generateNodeStream({
    type: 'nodebuffer',
    streamFiles: true,
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })

  onProgress({ stage: 'saving', percentage: 96, message: 'Writing repaired EPUB copy…' })
  await atomicWriteStream(outputPath, output, async (temporaryPath) => {
    await validateRepairedEpubFile(temporaryPath, normalizedPackagePath, replacements)
  })
  const outputDetails = await stat(outputPath)
  onProgress({
    stage: 'complete',
    percentage: 100,
    message: `EPUB checked and repaired. Converted ${webpEntries.length} WebP image(s) to JPEG.${upscaledCover ? ' Upscaled the undersized cover.' : ''}${repairedMarkupChapters > 0 ? ` Cleaned ${repairedMarkupChapters} chapter(s) that contained page code.` : ''}`
  })
  return {
    outputPath,
    outputBytes: outputDetails.size,
    repairedWebpImages: webpEntries.length,
    upscaledCover,
    fixedMimetype,
    repairedMarkupChapters,
    repairedMarkupParagraphs
  }
  } finally {
    archive.close()
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  }
}
