import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import type {
  LibraryFileRecord,
  LibraryIndex,
  LibraryFileFormat,
  LibraryProgress,
  LibraryFolderState
} from '../../shared/contracts'
import { LIBRARY_FOLDERS, MAX_EPUB_INPUT_BYTES } from '../../shared/constants'
import { inspectEpub } from './epubInspector'

interface ScannableFile {
  path: string
  relativePath: string
  folderState: LibraryFolderState
  size: number
  modifiedAt: string
  id: string
  format: LibraryFileFormat
}

export interface LibraryScanOptions {
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Library scan cancelled.')
}

function fileId(relativePath: string): string {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex')
}

function normalizedRelativePath(relativePath: string): string {
  return relativePath.replace(/[\\/]+/g, '/').toLocaleLowerCase()
}

async function matchesLibraryRoot(previousIndex: LibraryIndex | null, root: string): Promise<boolean> {
  if (
    !previousIndex ||
    previousIndex.schemaVersion !== 1 ||
    !Array.isArray(previousIndex.files) ||
    typeof previousIndex.libraryRoot !== 'string'
  ) {
    return false
  }
  try {
    const previousRoot = await realpath(previousIndex.libraryRoot)
    return process.platform === 'win32'
      ? previousRoot.toLocaleLowerCase() === root.toLocaleLowerCase()
      : previousRoot === root
  } catch {
    const previousRoot = resolve(previousIndex.libraryRoot)
    return process.platform === 'win32'
      ? previousRoot.toLocaleLowerCase() === root.toLocaleLowerCase()
      : previousRoot === root
  }
}

function cachedFile(
  cached: LibraryFileRecord | undefined,
  file: ScannableFile
): LibraryFileRecord | undefined {
  if (
    !cached ||
    cached.size !== file.size ||
    cached.modifiedAt !== file.modifiedAt ||
    !Array.isArray(cached.chapterTitles) ||
    !Array.isArray(cached.chapterNumbers)
  ) {
    return undefined
  }
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    filename: cached.filename,
    format: file.format,
    folderState: file.folderState,
    size: file.size,
    modifiedAt: file.modifiedAt,
    novelTitle: cached.novelTitle,
    author: cached.author,
    language: cached.language,
    chapterTitles: cached.chapterTitles,
    chapterNumbers: cached.chapterNumbers,
    filenameRange: cached.filenameRange,
    coverageConfidence: cached.coverageConfidence,
    coverPath: cached.coverPath,
    inspectionError: cached.inspectionError
  }
}

function parseFilenameRange(value: string): { start: number; end: number } | null {
  const match = value.match(/(?:^|[\s_-])(\d{1,7})\s*[-–]\s*(\d{1,7})(?:\D|$)/)
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

function emptyFile(file: ScannableFile, error: unknown): LibraryFileRecord {
  const parts = file.relativePath.split(/[\\/]/)
  const filename = parts[parts.length - 1]
  const title = parts.length > 2 ? parts[1] : filename
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    filename,
    format: file.format,
    folderState: file.folderState,
    size: file.size,
    modifiedAt: file.modifiedAt,
    novelTitle: title,
    author: '',
    language: '',
    chapterTitles: [],
    chapterNumbers: [],
    filenameRange: parseFilenameRange(filename ?? ''),
    coverageConfidence: 'unknown',
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
  filesFoundBefore: number,
  totalFolders: number
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
          if (extension !== '.epub' && extension !== '.azw3') continue

          const relativePath = relative(root, path)
          files.push({
            path,
            relativePath,
            folderState: folder,
            size: details.size,
            modifiedAt: details.mtime.toISOString(),
            id: fileId(relativePath),
            format: extension === '.epub' ? 'EPUB' : 'AZW3'
          })
          if (files.length % 200 === 0) {
            onProgress({
              stage: 'scan',
              current: currentFolderIndex,
              total: totalFolders,
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
            total: totalFolders,
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
  onProgress: (progress: LibraryProgress) => void,
  options: LibraryScanOptions
): Promise<LibraryIndex> {
  const root = await realpath(libraryRoot)
  const files: ScannableFile[] = []
  let scanErrors = 0
  const folders = LIBRARY_FOLDERS.filter((folder) =>
    (folder !== 'Old' || options.scanOldFolder) &&
    (folder !== 'Old Completed' || options.scanOldCompletedFolder)
  )

  for (let index = 0; index < folders.length; index += 1) {
    checkCancelled(signal)
    const folder = folders[index]
    if (!folder) continue
    onProgress({
      stage: 'scan',
      current: index,
      total: folders.length,
      discoveredFiles: files.length,
      indexedFiles: 0,
      totalFiles: 0,
      message: `Scanning ${folder}…`
    })
    const result = await enumerateFiles(
      root,
      folder,
      signal,
      onProgress,
      index + 1,
      files.length,
      folders.length
    )
    files.push(...result.files)
    scanErrors += result.errors
  }

  const canReusePreviousIndex = await matchesLibraryRoot(previousIndex, root)
  const previousFiles = canReusePreviousIndex ? previousIndex?.files ?? [] : []
  const previousFilesById = new Map(previousFiles.map((file) => [file.id, file]))
  const previousFilesByPath = new Map(
    previousFiles
      .filter((file) => typeof file.relativePath === 'string')
      .map((file) => [normalizedRelativePath(file.relativePath), file])
  )
  const previousCorrections = canReusePreviousIndex ? previousIndex?.corrections ?? {} : {}
  const corrections: LibraryIndex['corrections'] = {}
  const indexedFiles: LibraryFileRecord[] = []
  let reusedFiles = 0
  let inspectedFiles = 0

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
    const previousFile = previousFilesById.get(file.id) ??
      previousFilesByPath.get(normalizedRelativePath(file.relativePath))
    let record = cachedFile(previousFile, file)
    if (!record) {
      inspectedFiles += 1
      try {
        if (file.format === 'EPUB' && file.size > MAX_EPUB_INPUT_BYTES) {
          throw new Error(`EPUB exceeds the ${MAX_EPUB_INPUT_BYTES / (1024 * 1024)} MB inspection limit.`)
        }
        if (file.format === 'EPUB') {
          record = await inspectEpub(
            file.path,
            file.relativePath,
            file.folderState,
            file.size,
            file.modifiedAt,
            file.id
          )
        } else {
          const filename = file.relativePath.split(/[\\/]/).pop() ?? file.relativePath
          const novelTitle = filename
            .replace(/\.azw3$/i, '')
            .replace(/\s+\d+\s*[-–]\s*\d+$/, '')
          record = {
            id: file.id,
            path: file.path,
            relativePath: file.relativePath,
            filename,
            format: 'AZW3',
            folderState: file.folderState,
            size: file.size,
            modifiedAt: file.modifiedAt,
            novelTitle: novelTitle || filename,
            author: '',
            language: '',
            chapterTitles: [],
            chapterNumbers: [],
            filenameRange: parseFilenameRange(filename),
            coverageConfidence: 'unknown',
            coverPath: null,
            inspectionError: ''
          }
        }
      } catch (error) {
        record = emptyFile(file, error)
        scanErrors += 1
      }
    } else {
      reusedFiles += 1
    }

    const correction = previousCorrections[file.id] ??
      (previousFile ? previousCorrections[previousFile.id] : undefined)
    if (correction) corrections[file.id] = correction
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
    scanErrors,
    scanSummary: { reusedFiles, inspectedFiles }
  }
}
