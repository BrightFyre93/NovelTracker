import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type {
  LibraryFileRecord,
  LibraryIndex,
  LibraryProgress,
  LibraryFolderState
} from '../../shared/contracts'
import { inspectEpub } from './epubInspector'
import { inspectPdf } from './pdfInspector'

const LIBRARY_FOLDERS: LibraryFolderState[] = ['Completed', 'Downloaded', 'Sent', 'Old']
const MAX_EPUB_BYTES = 256 * 1024 * 1024

interface ScannableFile {
  path: string
  relativePath: string
  folderState: LibraryFolderState
  size: number
  modifiedAt: string
  id: string
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Library scan cancelled.')
}

function fileId(relativePath: string): string {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex')
}

function cachedFile(
  cached: LibraryFileRecord | undefined,
  file: ScannableFile
): LibraryFileRecord | undefined {
  if (!cached || cached.size !== file.size || cached.modifiedAt !== file.modifiedAt) return undefined
  return { ...cached, path: file.path, relativePath: file.relativePath, folderState: file.folderState }
}

function parseFilenameRange(value: string): { start: number; end: number } | null {
  const match = value.match(/(?:^|[\s_-])(\d{1,7})\s*[-–]\s*(\d{1,7})(?:\D|$)/)
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

function emptyFile(file: ScannableFile, error: unknown): LibraryFileRecord {
  const parts = file.relativePath.split(/[\\/]/)
  const filename = parts[parts.length - 1]
  const isPdf = extname(filename).toLowerCase() === '.pdf'
  const title = parts.length > 2 ? parts[1] : filename
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    filename,
    format: isPdf ? 'PDF' : 'EPUB',
    folderState: file.folderState,
    size: file.size,
    modifiedAt: file.modifiedAt,
    novelTitle: title,
    author: '',
    language: '',
    pageCount: null,
    chapterTitles: [],
    chapterNumbers: [],
    chapterLocations: [],
    filenameRange: isPdf ? null : parseFilenameRange(filename),
    coverageConfidence: 'unknown',
    pdfClassification: isPdf ? 'unknown' : null,
    coverPath: null,
    inspectionError: error instanceof Error ? error.message : String(error)
  }
}

async function enumerateFiles(
  root: string,
  folder: LibraryFolderState,
  signal: AbortSignal,
  onProgress: (progress: LibraryProgress) => void,
  currentFolderIndex: number,
  filesFoundBefore: number
): Promise<{ files: ScannableFile[]; errors: number }> {
  const files: ScannableFile[] = []
  let errors = 0
  const folderPath = resolve(root, folder)
  let folderDetails
  try {
    folderDetails = await lstat(folderPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { files, errors }
    throw error
  }
  if (!folderDetails.isDirectory() || folderDetails.isSymbolicLink()) return { files, errors: 1 }

  async function walk(directory: string): Promise<void> {
    checkCancelled(signal)
    let handle
    try {
      handle = await opendir(directory)
      for await (const entry of handle) {
        checkCancelled(signal)
        try {
          const path = resolve(directory, entry.name)
          const details = await lstat(path)
          if (details.isSymbolicLink()) continue
          if (details.isDirectory()) {
            await walk(path)
            continue
          }
          if (!details.isFile()) continue
          const extension = extname(entry.name).toLowerCase()
          if ((folder === 'Old' && extension !== '.pdf') || (folder !== 'Old' && extension !== '.epub')) continue

          const relativePath = relative(root, path)
          files.push({
            path,
            relativePath,
            folderState: folder,
            size: details.size,
            modifiedAt: details.mtime.toISOString(),
            id: fileId(relativePath)
          })
          if (files.length % 200 === 0) {
            onProgress({
              stage: 'scan',
              current: currentFolderIndex,
              total: LIBRARY_FOLDERS.length,
              discoveredFiles: filesFoundBefore + files.length,
              indexedFiles: 0,
              totalFiles: 0,
              message: `Found ${(filesFoundBefore + files.length).toLocaleString()} supported files in ${folder}…`
            })
          }
        } catch (error) {
          errors += 1
          onProgress({
            stage: 'scan',
            current: currentFolderIndex,
            total: LIBRARY_FOLDERS.length,
            discoveredFiles: filesFoundBefore + files.length,
            indexedFiles: 0,
            totalFiles: 0,
            message: `Skipped an inaccessible entry in ${folder}: ${error instanceof Error ? error.message : String(error)}`
          })
        }
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      errors += 1
    }
  }

  await walk(folderPath)
  return { files, errors }
}

export async function scanLibrary(
  libraryRoot: string,
  previousIndex: LibraryIndex | null,
  signal: AbortSignal,
  onProgress: (progress: LibraryProgress) => void
): Promise<LibraryIndex> {
  const root = await realpath(libraryRoot)
  const files: ScannableFile[] = []
  let scanErrors = 0

  for (let index = 0; index < LIBRARY_FOLDERS.length; index += 1) {
    checkCancelled(signal)
    const folder = LIBRARY_FOLDERS[index]
    onProgress({
      stage: 'scan',
      current: index,
      total: LIBRARY_FOLDERS.length,
      discoveredFiles: files.length,
      indexedFiles: 0,
      totalFiles: 0,
      message: `Scanning ${folder}…`
    })
    const result = await enumerateFiles(root, folder, signal, onProgress, index + 1, files.length)
    files.push(...result.files)
    scanErrors += result.errors
  }

  const previousFiles = new Map(
    (previousIndex?.libraryRoot === root ? previousIndex.files : []).map((file) => [file.id, file])
  )
  const currentIds = new Set(files.map((file) => file.id))
  const corrections = previousIndex?.libraryRoot === root
    ? Object.fromEntries(
        Object.entries(previousIndex.corrections ?? {}).filter(([id]) => currentIds.has(id))
      )
    : {}
  const indexedFiles: LibraryFileRecord[] = []

  onProgress({
    stage: 'inspect',
    current: 0,
    total: files.length,
    discoveredFiles: files.length,
    indexedFiles: 0,
    totalFiles: files.length,
    message: `Starting metadata inspection for ${files.length.toLocaleString()} files…`
  })

  for (let index = 0; index < files.length; index += 1) {
    checkCancelled(signal)
    const file = files[index]
    let record = cachedFile(previousFiles.get(file.id), file)
    if (!record) {
      try {
        if (file.folderState !== 'Old') {
          if (file.size > MAX_EPUB_BYTES) throw new Error(`EPUB exceeds the ${MAX_EPUB_BYTES / (1024 * 1024)} MB inspection limit.`)
          record = await inspectEpub(
            file.path,
            file.relativePath,
            file.folderState,
            file.size,
            file.modifiedAt,
            file.id
          )
        } else {
          record = await inspectPdf(
            file.path,
            file.relativePath,
            file.folderState,
            file.size,
            file.modifiedAt,
            file.id
          )
        }
      } catch (error) {
        record = emptyFile(file, error)
        scanErrors += 1
      }
    }

    const correction = corrections[file.id]
    if (correction?.novelTitle) record.novelTitle = correction.novelTitle
    if (correction?.chapterNumbers) {
      record.chapterNumbers = [...correction.chapterNumbers].sort((left, right) => left - right)
      record.coverageConfidence = 'user-corrected'
    }
    indexedFiles.push(record)

    if ((index + 1) % 25 === 0 || index + 1 === files.length) {
      onProgress({
        stage: 'inspect',
        current: index + 1,
        total: files.length,
        discoveredFiles: files.length,
        indexedFiles: index + 1,
        totalFiles: files.length,
        message: `Indexed ${(index + 1).toLocaleString()} of ${files.length.toLocaleString()} files…`
      })
    }
  }

  checkCancelled(signal)
  return {
    schemaVersion: 1,
    libraryRoot: root,
    scannedAt: new Date().toISOString(),
    files: indexedFiles,
    corrections,
    scanErrors
  }
}
