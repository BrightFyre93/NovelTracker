import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type {
  LibraryFileRecord,
  LibraryIndex,
  LibraryPossibleMove,
  LibraryFileFormat,
  LibraryProgress,
  LibraryFolderState
} from '../../shared/contracts'
import { LIBRARY_FOLDERS, MAX_EPUB_INPUT_BYTES } from '../../shared/constants'
import { isNodeError, OperationCancelledError, toMessage } from '../../shared/errors'
import { normalizeNovelTitleForMatching } from '../../shared/novelTitle'
import {
  parseFilenameRange,
  stripTrailingFilenameRange
} from '../../shared/filenameRange'
import { samePath } from './pathUtils'
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
  forceRebuild?: boolean
}

export type PackagedEpubInspection =
  | { file: LibraryFileRecord; libraryRoot: string }
  | { file: null; skippedReason: string }

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new OperationCancelledError('Library scan cancelled.')
}

function fileId(relativePath: string): string {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex')
}

export async function inspectPackagedEpubForLibrary(
  path: string,
  libraryRoot: string,
  options: LibraryScanOptions
): Promise<PackagedEpubInspection> {
  if (!libraryRoot.trim()) {
    return {
      file: null,
      skippedReason: 'no library folder is configured'
    }
  }

  const root = await realpath(libraryRoot)
  const requestedPath = resolve(path)
  const filePath = await realpath(requestedPath)
  const details = await lstat(requestedPath)
  if (!details.isFile() || details.isSymbolicLink()) {
    return {
      file: null,
      skippedReason: 'the output is not a regular file'
    }
  }
  if (!samePath(requestedPath, filePath)) {
    return {
      file: null,
      skippedReason: 'the output is reached through a symbolic link'
    }
  }

  const relativePath = relative(root, filePath)
  const pathParts = relativePath.split(/[\\/]/)
  if (
    !relativePath ||
    relativePath === '..' ||
    pathParts[0] === '..' ||
    isAbsolute(relativePath)
  ) {
    return {
      file: null,
      skippedReason: 'the output is outside the configured library folder'
    }
  }

  const folderState = LIBRARY_FOLDERS.find(
    (folder) => folder.toLocaleLowerCase() === pathParts[0]?.toLocaleLowerCase()
  )
  if (!folderState) {
    return {
      file: null,
      skippedReason: 'the output is not inside a folder scanned by the library'
    }
  }
  if (
    (folderState === 'Old' && !options.scanOldFolder) ||
    (folderState === 'Old Completed' && !options.scanOldCompletedFolder)
  ) {
    return {
      file: null,
      skippedReason: `the ${folderState} folder is excluded from library scans`
    }
  }
  if (extname(filePath).toLowerCase() !== '.epub') {
    return {
      file: null,
      skippedReason: 'only EPUB files are added automatically'
    }
  }
  if (details.size > MAX_EPUB_INPUT_BYTES) {
    throw new Error(
      `EPUB exceeds the ${MAX_EPUB_INPUT_BYTES / (1024 * 1024)} MB inspection limit.`
    )
  }

  return {
    file: await inspectEpub(
      filePath,
      relativePath,
      folderState,
      details.size,
      details.mtime.toISOString(),
      fileId(relativePath)
    ),
    libraryRoot: root
  }
}

function normalizedRelativePath(relativePath: string): string {
  return relativePath.replace(/[\\/]+/g, '/').toLocaleLowerCase()
}

function stableBookVolumeKey(file: LibraryFileRecord): string | null {
  return file.stableBookId && Number.isSafeInteger(file.volumeIndex) && file.volumeIndex! > 0
    ? `${file.stableBookId}:${file.volumeIndex}`
    : null
}

function legacyMoveIdentity(file: LibraryFileRecord): string | null {
  if (file.stableBookId || file.chapterNumbers.length === 0) return null
  const numbers = [...file.chapterNumbers].sort((left, right) => left - right)
  return [
    file.size,
    file.modifiedAt,
    normalizeNovelTitleForMatching(file.novelTitle),
    numbers[0],
    numbers[numbers.length - 1]
  ].join(':')
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
      ? samePath(previousRoot, root)
      : previousRoot === root
  } catch {
    const previousRoot = resolve(previousIndex.libraryRoot)
    return process.platform === 'win32'
      ? samePath(previousRoot, root)
      : previousRoot === root
  }
}

type LibraryFileIdentity = Pick<
  LibraryFileRecord,
  'id' | 'path' | 'relativePath' | 'format' | 'folderState' | 'size' | 'modifiedAt'
>

function libraryFileIdentity(file: ScannableFile): LibraryFileIdentity {
  return {
    id: file.id,
    path: file.path,
    relativePath: file.relativePath,
    format: file.format,
    folderState: file.folderState,
    size: file.size,
    modifiedAt: file.modifiedAt
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
    (!Array.isArray(cached.chapterTitles) &&
      !Array.isArray(cached.chapterTitleKeys)) ||
    !Array.isArray(cached.chapterNumbers)
  ) {
    return undefined
  }
  return {
    ...libraryFileIdentity(file),
    filename: cached.filename,
    novelTitle: cached.novelTitle,
    ...(cached.stableBookId ? { stableBookId: cached.stableBookId } : {}),
    ...(cached.volumeIndex ? { volumeIndex: cached.volumeIndex } : {}),
    author: cached.author,
    language: cached.language,
    chapterTitles: cached.chapterTitles ?? [],
    chapterTitleKeys: cached.chapterTitleKeys,
    chapterNumbers: cached.chapterNumbers,
    filenameRange: cached.filenameRange,
    coverageConfidence: cached.coverageConfidence,
    coverPath: cached.coverPath,
    inspectionError: cached.inspectionError
  }
}

function emptyFile(file: ScannableFile, error: unknown): LibraryFileRecord {
  const parts = file.relativePath.split(/[\\/]/)
  const filename = parts[parts.length - 1]
  const title = parts.length > 2 ? parts[1] : filename
  return {
    ...libraryFileIdentity(file),
    filename,
    novelTitle: title,
    author: '',
    language: '',
    chapterTitles: [],
    chapterNumbers: [],
    filenameRange: parseFilenameRange(filename ?? ''),
    coverageConfidence: 'unknown',
    coverPath: null,
    inspectionError: toMessage(error)
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
    if (isNodeError(error) && error.code === 'ENOENT') return { files, errors }
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
            message: `Skipped an inaccessible entry in ${folder}: ${toMessage(error)}`
          })
        }
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
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
  const scanStartedAt = new Date().toISOString()
  const root = await realpath(libraryRoot)
  const files: ScannableFile[] = []
  let scanErrors = 0
  const fullyScannedFolders = new Set<LibraryFolderState>()
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
    if (result.errors === 0) fullyScannedFolders.add(folder)
  }

  const canReusePreviousIndex = await matchesLibraryRoot(previousIndex, root)
  const previousFiles = canReusePreviousIndex ? previousIndex?.files ?? [] : []
  const previousFilesById = new Map(previousFiles.map((file) => [file.id, file]))
  const previousFilesByPath = new Map(
    previousFiles
      .filter((file) => typeof file.relativePath === 'string')
      .map((file) => [normalizedRelativePath(file.relativePath), file])
  )
  const previousFilesByStableBookVolume = new Map<string, LibraryFileRecord>()
  const repeatedStableBookVolumes = new Set<string>()
  const previousFilesByLegacyIdentity = new Map<string, LibraryFileRecord>()
  const legacyIdentityCandidates = new Map<string, LibraryFileRecord[]>()
  const repeatedLegacyIdentities = new Set<string>()
  for (const previousFile of previousFiles) {
    const key = stableBookVolumeKey(previousFile)
    if (!key) continue
    if (previousFilesByStableBookVolume.has(key)) {
      repeatedStableBookVolumes.add(key)
      previousFilesByStableBookVolume.delete(key)
    } else if (!repeatedStableBookVolumes.has(key)) {
      previousFilesByStableBookVolume.set(key, previousFile)
    }
    const legacyKey = legacyMoveIdentity(previousFile)
    if (!legacyKey) continue
    const candidates = legacyIdentityCandidates.get(legacyKey) ?? []
    candidates.push(previousFile)
    legacyIdentityCandidates.set(legacyKey, candidates)
    if (previousFilesByLegacyIdentity.has(legacyKey)) {
      repeatedLegacyIdentities.add(legacyKey)
      previousFilesByLegacyIdentity.delete(legacyKey)
    } else if (!repeatedLegacyIdentities.has(legacyKey)) {
      previousFilesByLegacyIdentity.set(legacyKey, previousFile)
    }
  }
  const previousCorrections = canReusePreviousIndex ? previousIndex?.corrections ?? {} : {}
  const corrections: LibraryIndex['corrections'] = {}
  const currentFileIds = new Set(files.map((file) => file.id))
  // A correction may only follow a file that was moved or renamed, so the
  // previous file must be gone from a folder that this scan fully covered.
  const onlyIfGone = (
    candidate: LibraryFileRecord | undefined
  ): LibraryFileRecord | undefined =>
    candidate &&
    fullyScannedFolders.has(candidate.folderState) &&
    !currentFileIds.has(candidate.id)
      ? candidate
      : undefined
  const indexedFiles: LibraryFileRecord[] = []
  const reusedFileIds: string[] = []
  const possibleMoves: LibraryPossibleMove[] = []
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

  const inspectFile = async (file: ScannableFile): Promise<{
    record: LibraryFileRecord
    correction?: LibraryIndex['corrections'][string]
    possibleMove?: LibraryPossibleMove
  }> => {
    checkCancelled(signal)
    const previousFile = previousFilesById.get(file.id) ??
      previousFilesByPath.get(normalizedRelativePath(file.relativePath))
    let record = options.forceRebuild ? undefined : cachedFile(previousFile, file)
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
          const novelTitle = filename.replace(/\.azw3$/i, '')
          const normalizedNovelTitle = stripTrailingFilenameRange(novelTitle)
          record = {
            ...libraryFileIdentity(file),
            filename,
            novelTitle: normalizedNovelTitle || filename,
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
      reusedFileIds.push(file.id)
    }

    const stablePreviousFile = stableBookVolumeKey(record)
      ? onlyIfGone(previousFilesByStableBookVolume.get(stableBookVolumeKey(record)!))
      : undefined
    const legacyKey = previousFile ? null : legacyMoveIdentity(record)
    const legacyPreviousFile = legacyKey && !repeatedLegacyIdentities.has(legacyKey)
      ? onlyIfGone(previousFilesByLegacyIdentity.get(legacyKey))
      : undefined
    const correction = previousCorrections[file.id] ??
      (previousFile ? previousCorrections[previousFile.id] : undefined) ??
      (stablePreviousFile ? previousCorrections[stablePreviousFile.id] : undefined) ??
      (legacyPreviousFile ? previousCorrections[legacyPreviousFile.id] : undefined)
    const possibleMoveCandidates = legacyKey && repeatedLegacyIdentities.has(legacyKey)
      ? (legacyIdentityCandidates.get(legacyKey) ?? []).filter(
          (candidate) => onlyIfGone(candidate) !== undefined
        )
      : []
    const candidates = possibleMoveCandidates.flatMap((candidate) => {
      const previousCorrection = previousCorrections[candidate.id]
      return previousCorrection && Object.keys(previousCorrection).length > 0
        ? [{ previousFilename: candidate.filename, correction: previousCorrection }]
        : []
    })
    const possibleMove: LibraryPossibleMove | undefined = candidates.length > 0
      ? {
          newFilename: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
          newFileId: file.id,
          candidates
        }
      : undefined
    if (correction?.novelTitle) record.novelTitle = correction.novelTitle
    if (correction?.chapterNumbers) {
      record.chapterNumbers = [...correction.chapterNumbers].sort((left, right) => left - right)
      record.coverageConfidence = 'user-corrected'
    }
    return { record, correction, possibleMove }
  }

  const inspectionConcurrency = 4
  for (let offset = 0; offset < files.length; offset += inspectionConcurrency) {
    checkCancelled(signal)
    const batch = files.slice(offset, offset + inspectionConcurrency)
    const results = await Promise.all(batch.map((file) => inspectFile(file)))
    for (let batchIndex = 0; batchIndex < results.length; batchIndex += 1) {
      const result = results[batchIndex]
      const file = batch[batchIndex]
      if (result.correction) corrections[file.id] = result.correction
      if (result.possibleMove && possibleMoves.length < 20) {
        possibleMoves.push(result.possibleMove)
      }
      indexedFiles.push(result.record)
      const current = offset + batchIndex + 1
      if (current % 25 === 0 || current === files.length) {
        onProgress({
          stage: 'inspect',
          current,
          total: files.length,
          discoveredFiles: files.length,
          indexedFiles: current,
          totalFiles: files.length,
          message: `Indexed ${current.toLocaleString()} of ${files.length.toLocaleString()} files…`
        })
      }
    }
  }

  const indexedIds = new Set(indexedFiles.map((file) => file.id))
  for (const previousFile of previousFiles) {
    if (fullyScannedFolders.has(previousFile.folderState) || indexedIds.has(previousFile.id)) continue
    indexedFiles.push(previousFile)
    indexedIds.add(previousFile.id)
    reusedFileIds.push(previousFile.id)
    reusedFiles += 1
    const correction = previousCorrections[previousFile.id]
    if (correction) corrections[previousFile.id] = correction
  }

  checkCancelled(signal)
  const contentChanged = !canReusePreviousIndex ||
    indexedFiles.length !== previousFiles.length ||
    inspectedFiles > 0 ||
    Object.keys(corrections).length !== Object.keys(previousCorrections).length
  return {
    schemaVersion: 1,
    libraryRoot: root,
    scannedAt: new Date().toISOString(),
    files: indexedFiles,
    corrections,
    scanErrors,
    scanSummary: {
      reusedFiles,
      inspectedFiles,
      reusedFileIds,
      scannedFolders: [...fullyScannedFolders],
      contentChanged,
      possibleMoves,
      scanStartedAt
    }
  }
}
