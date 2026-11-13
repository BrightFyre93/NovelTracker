import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import JSZip from 'jszip'
import sharp from 'sharp'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
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

interface XmlObject {
  [key: string]: unknown
}

const MAX_REPAIR_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true
})

function object(value: unknown): XmlObject {
  return typeof value === 'object' && value !== null ? value as XmlObject : {}
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return typeof value === 'object' && value !== null ? text(object(value)['#text']) : ''
}

function xmlObjects(value: unknown): XmlObject[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(object)
}

function resolveArchivePath(documentPath: string, href: string): string | null {
  const pathPart = href.split(/[?#]/, 1)[0]
  if (!pathPart || pathPart.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(pathPart)) return null
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    throw new Error('The EPUB contains a malformed internal resource path.')
  }
  const resolvedPath = posix.normalize(posix.join(posix.dirname(documentPath), decodedPath.replace(/\\/g, '/')))
  if (resolvedPath === '..' || resolvedPath.startsWith('../')) {
    throw new Error('The EPUB contains an unsafe internal resource path.')
  }
  return resolvedPath
}

function findCoverImagePath(packageXml: string, packagePath: string): string | null {
  const packageData = object(xmlParser.parse(packageXml).package)
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
        stream.destroy(new Error(`An EPUB resource exceeds the ${limit.toLocaleString()} byte repair limit.`))
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', rejectEntry)
    stream.once('end', () => resolveEntry(Buffer.concat(chunks, length)))
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
  const source = await readFile(inputPath)
  const archive = await JSZip.loadAsync(source)
  const entries = Object.values(archive.files)
  if (entries.length > MAX_EPUB_ZIP_ENTRIES) {
    throw new Error(`The EPUB has too many ZIP entries to repair safely (limit ${MAX_EPUB_ZIP_ENTRIES.toLocaleString()}).`)
  }
  const containerFile = archive.file('META-INF/container.xml')
  if (!containerFile || containerFile.dir) {
    throw new Error('This archive is missing META-INF/container.xml and cannot be repaired as an EPUB.')
  }
  const containerXml = (await readEntry(containerFile, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  validateXml(containerXml, 'META-INF/container.xml')
  const rootfilesValue = object(object(object(xmlParser.parse(containerXml)).container).rootfiles).rootfile
  const rootfile = Array.isArray(rootfilesValue) ? rootfilesValue[0] : rootfilesValue
  const packagePath = text(object(rootfile)['@_full-path'])
  if (!packagePath || packagePath.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(packagePath)) {
    throw new Error('The EPUB container does not identify a safe package document.')
  }
  const normalizedPackagePath = posix.normalize(packagePath.replace(/\\/g, '/'))
  if (normalizedPackagePath === '..' || normalizedPackagePath.startsWith('../')) {
    throw new Error('The EPUB package document is outside its archive.')
  }
  const packageEntry = archive.file(normalizedPackagePath)
  if (!packageEntry || packageEntry.dir) {
    throw new Error(`The EPUB package document ${normalizedPackagePath} is missing.`)
  }
  let packageXml = (await readEntry(packageEntry, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  validateXml(packageXml, normalizedPackagePath)

  const webpEntries = entries.filter((entry) => !entry.dir && /\.webp$/i.test(entry.name))
  const coverImagePath = findCoverImagePath(packageXml, normalizedPackagePath)
  const coverEntry = coverImagePath ? archive.file(coverImagePath) : null
  const replacements = new Map<string, string>()
  const repairedImageData = new Map<string, Buffer>()
  const occupiedPaths = new Set(entries.map((entry) => entry.name))
  let totalImageBytes = 0
  let totalUncompressedBytes = 0
  let upscaledCover = false

  if (coverImagePath && coverEntry && !coverEntry.dir && !/\.webp$/i.test(coverImagePath)) {
    const data = await readEntry(coverEntry, MAX_REPAIR_ENTRY_BYTES)
    totalUncompressedBytes += data.length
    if (totalUncompressedBytes > MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('The EPUB exceeds the total uncompressed repair limit.')
    }
    let resizedCover: Buffer | null
    try {
      resizedCover = await resizeSmallKindleCover(data)
    } catch (error) {
      throw new Error(
        `Could not normalize cover ${coverImagePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (resizedCover) {
      const outputPath = jpegReplacementPath(coverImagePath, occupiedPaths)
      occupiedPaths.add(outputPath)
      replacements.set(coverImagePath, outputPath)
      repairedImageData.set(coverImagePath, resizedCover)
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
    const data = await readEntry(entry, MAX_CHAPTER_IMAGE_BYTES)
    totalUncompressedBytes += data.length
    if (totalUncompressedBytes > MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('The EPUB exceeds the total uncompressed repair limit.')
    }
    if (data.length === 0 || data.length > MAX_CHAPTER_IMAGE_BYTES) {
      throw new Error(`${entry.name} exceeds the ${MAX_CHAPTER_IMAGE_BYTES / (1024 * 1024)} MB image repair limit.`)
    }
    const outputPath = jpegReplacementPath(entry.name, occupiedPaths)
    occupiedPaths.add(outputPath)
    replacements.set(entry.name, outputPath)
    let jpeg: Buffer
    try {
      const resizedCover = entry.name === coverImagePath ? await resizeSmallKindleCover(data) : null
      jpeg = resizedCover ?? await sharp(data, { failOn: 'error', limitInputPixels: 40_000_000 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toBuffer()
      if (resizedCover) upscaledCover = true
    } catch (error) {
      throw new Error(
        `Could not convert ${entry.name} to a Kindle-compatible JPEG: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    totalImageBytes += jpeg.length
    if (totalImageBytes > MAX_TOTAL_EPUB_IMAGE_BYTES) {
      throw new Error(`Converted images exceed the ${MAX_TOTAL_EPUB_IMAGE_BYTES / (1024 * 1024)} MB repair limit.`)
    }
    repairedImageData.set(entry.name, jpeg)
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

  const mimeEntry = archive.file('mimetype')
  const currentMimetype = mimeEntry && !mimeEntry.dir
    ? (await readEntry(mimeEntry, 128)).toString('utf8')
    : ''
  const fixedMimetype = currentMimetype !== EPUB_MIMETYPE || entries[0]?.name !== 'mimetype'
  const repairedArchive = new JSZip()
  repairedArchive.file('mimetype', EPUB_MIMETYPE, { compression: 'STORE' })

  for (const [index, entry] of entries.entries()) {
    if (entry.name === 'mimetype') continue
    if (entry.dir) {
      repairedArchive.file(entry.name, null, { dir: true, date: entry.date, createFolders: false })
      continue
    }
    if ((index + 1) % Math.max(1, Math.ceil(entries.length / 100)) === 0) {
      onProgress({
        stage: 'rewriting',
        percentage: 60 + Math.round(((index + 1) / entries.length) * 25),
        message: `Rewriting EPUB resources · ${index + 1} of ${entries.length}`
      })
    }
    const replacementImage = repairedImageData.get(entry.name)
    if (replacementImage) {
      const replacementPath = replacements.get(entry.name)
      if (!replacementPath) throw new Error(`The repaired path for ${entry.name} is missing.`)
      repairedArchive.file(replacementPath, replacementImage, {
        date: entry.date,
        createFolders: false
      })
      continue
    }
    if (entry.name === normalizedPackagePath) {
      repairedArchive.file(entry.name, packageXml, { date: entry.date, createFolders: false })
      continue
    }
    if (isTextResource(entry.name)) {
      const data = await readEntry(entry, MAX_EPUB_MERGE_ENTRY_BYTES)
      totalUncompressedBytes += data.length
      if (totalUncompressedBytes > MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error('The EPUB exceeds the total uncompressed repair limit.')
      }
      let contents = data.toString('utf8')
      if (replacements.size > 0) contents = rewriteDocumentReferences(contents, entry.name, replacements)
      repairedArchive.file(entry.name, contents, { date: entry.date, createFolders: false })
      continue
    }
    const data = await readEntry(entry, MAX_REPAIR_ENTRY_BYTES)
    totalUncompressedBytes += data.length
    if (totalUncompressedBytes > MAX_REPAIR_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('The EPUB exceeds the total uncompressed repair limit.')
    }
    repairedArchive.file(entry.name, data, {
      date: entry.date,
      createFolders: false
    })
  }

  onProgress({ stage: 'validating', percentage: 88, message: 'Validating repaired EPUB package…' })
  const output = await repairedArchive.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  })
  const verified = await JSZip.loadAsync(output)
  const verifiedMimetypeEntry = verified.file('mimetype')
  const verifiedMimetype = verifiedMimetypeEntry
    ? (await readEntry(verifiedMimetypeEntry, 128)).toString('utf8')
    : undefined
  if (verifiedMimetype !== EPUB_MIMETYPE) {
    throw new Error('The repaired EPUB failed validation: its mimetype entry is invalid.')
  }
  const firstFilenameLength = output.readUInt16LE(26)
  const firstFilename = output.subarray(30, 30 + firstFilenameLength).toString('utf8')
  if (firstFilename !== 'mimetype' || output.readUInt16LE(8) !== 0) {
    throw new Error('The repaired EPUB failed validation: mimetype is not the first uncompressed ZIP entry.')
  }
  const verifiedPackage = verified.file(normalizedPackagePath)
  if (!verifiedPackage || verifiedPackage.dir) {
    throw new Error('The repaired EPUB failed validation: its package document is missing.')
  }
  const verifiedPackageXml = (await readEntry(verifiedPackage, MAX_EPUB_MERGE_ENTRY_BYTES)).toString('utf8')
  validateXml(verifiedPackageXml, normalizedPackagePath)
  if (/media-type\s*=\s*(["'])image\/webp\1/i.test(verifiedPackageXml) ||
    Object.values(verified.files).some((entry) => !entry.dir && /\.webp$/i.test(entry.name))) {
    throw new Error('The repaired EPUB failed validation: unsupported WebP resources remain.')
  }
  for (const [sourcePath, replacementPath] of replacements) {
    if (!verified.file(replacementPath) || verified.file(sourcePath)) {
      throw new Error(`The repaired EPUB failed validation for image ${sourcePath}.`)
    }
  }

  onProgress({ stage: 'saving', percentage: 96, message: 'Writing repaired EPUB copy…' })
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, output, { flag: 'wx' })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  const outputDetails = await stat(outputPath)
  onProgress({
    stage: 'complete',
    percentage: 100,
    message: `EPUB checked and repaired. Converted ${webpEntries.length} WebP image(s) to JPEG.${upscaledCover ? ' Upscaled the undersized cover.' : ''}`
  })
  return {
    outputPath,
    outputBytes: outputDetails.size,
    repairedWebpImages: webpEntries.length,
    upscaledCover,
    fixedMimetype
  }
}
