import { lstat } from 'node:fs/promises'
import * as yauzl from 'yauzl'
import type {
  LibraryFolderState,
  LibraryHealthIssue
} from '../../shared/contracts'
import { countEscapedMarkupParagraphs, readXhtmlTitle } from './escapedMarkupScan'

const MAX_CHAPTER_PAGE_BYTES = 8 * 1024 * 1024
const MAX_EXAMPLES = 5

export interface LibraryHealthFile {
  id: string
  path: string
  relativePath: string
  filename: string
  folderState: LibraryFolderState
}

export interface LibraryHealthWorkerProgress {
  current: number
  total: number
  message: string
  issueCount: number
}

export interface LibraryHealthWorkerResult {
  issues: LibraryHealthIssue[]
  errors: string[]
  scannedFileCount: number
}

async function readEntryText(archive: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  const stream = await archive.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += data.length
    if (length > MAX_CHAPTER_PAGE_BYTES) throw new Error('A chapter page is too large to check.')
    chunks.push(data)
  }
  return Buffer.concat(chunks, length).toString('utf8')
}

/** Looks through every page of one EPUB for chapters with escaped page markup. */
export async function scanEpubForEscapedMarkup(
  file: LibraryHealthFile
): Promise<LibraryHealthIssue | null> {
  const details = await lstat(file.path)
  if (details.isSymbolicLink() || !details.isFile()) throw new Error('The file is not a regular file.')
  const archive = await yauzl.openPromise(file.path, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: true
  })
  try {
    let affectedChapters = 0
    const examples: string[] = []
    await new Promise<void>((resolveScan, rejectScan) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        archive.off('entry', onEntry)
        archive.off('end', onEnd)
        archive.off('error', onError)
        if (error) rejectScan(error instanceof Error ? error : new Error(String(error)))
        else resolveScan()
      }
      const onEnd = (): void => finish()
      const onError = (error: Error): void => finish(error)
      const onEntry = (entry: yauzl.Entry): void => {
        if (!/\.x?html?$/i.test(entry.fileName) || entry.uncompressedSize > MAX_CHAPTER_PAGE_BYTES) {
          archive.readEntry()
          return
        }
        void (async () => {
          const page = await readEntryText(archive, entry)
          if (countEscapedMarkupParagraphs(page) > 0) {
            affectedChapters += 1
            if (examples.length < MAX_EXAMPLES) {
              examples.push(readXhtmlTitle(page) || entry.fileName)
            }
          }
          archive.readEntry()
        })().catch(finish)
      }
      archive.on('entry', onEntry)
      archive.once('end', onEnd)
      archive.once('error', onError)
      archive.readEntry()
    })
    if (affectedChapters === 0) return null
    return {
      fileId: file.id,
      filename: file.filename,
      relativePath: file.relativePath,
      folderState: file.folderState,
      affectedChapters,
      examples
    }
  } finally {
    archive.close()
  }
}

/** Scans the files one after the other and reports progress after each one. */
export async function scanLibraryForEscapedMarkup(
  files: LibraryHealthFile[],
  onProgress: (progress: LibraryHealthWorkerProgress) => void
): Promise<LibraryHealthWorkerResult> {
  const issues: LibraryHealthIssue[] = []
  const errors: string[] = []
  let scannedFileCount = 0
  for (const [index, file] of files.entries()) {
    onProgress({
      current: index,
      total: files.length,
      message: `Checking ${file.filename} (${(index + 1).toLocaleString()} of ${files.length.toLocaleString()})`,
      issueCount: issues.length
    })
    try {
      const issue = await scanEpubForEscapedMarkup(file)
      if (issue) issues.push(issue)
      scannedFileCount += 1
    } catch (error) {
      errors.push(`${file.filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  onProgress({
    current: files.length,
    total: files.length,
    message: 'Scan complete.',
    issueCount: issues.length
  })
  return { issues, errors, scannedFileCount }
}
