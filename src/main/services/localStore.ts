import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  DEFAULT_EPUB_CSS,
  DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  EPUB_IMAGE_TYPES,
  MAX_CHAPTER_IMAGE_BYTES,
  MAX_CHAPTER_IMAGES,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_EPUB_CSS_LENGTH,
  MAX_IMAGE_BYTES,
  MIN_DISCOVERY_FRESHNESS_HOURS
} from '../../shared/constants'
import type {
  AppSettings,
  ChapterImage,
  ChapterContent,
  DiscoveryQueueItem,
  DownloadHistoryEntry,
  LibraryOperation,
  LibraryFileCorrection,
  LibraryIndex
} from '../../shared/contracts'
const EMPTY_SETTINGS: AppSettings = {
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: '',
  scanOldFolder: false,
  maxSimultaneousDownloads: DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  discoveryFreshnessHours: DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  epubCss: DEFAULT_EPUB_CSS,
  appTheme: 'light'
}
const fileWriteTails = new Map<string, Promise<void>>()
let downloadHistoryWriteTail = Promise.resolve()

function isTransientRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))
  )
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const delays = [75, 150, 300, 600, 1200, 2000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (!isTransientRenameError(error)) throw error
      if (delay === undefined) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'filesystem error'
        throw new Error(
          `Windows could not replace "${destination}" after several attempts (${code}). Close any application locking the file, then retry.`
        )
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay))
    }
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const targetPath = resolve(path)
  const previous = fileWriteTails.get(targetPath) ?? Promise.resolve()
  let release!: () => void
  const hold = new Promise<void>((resolveHold) => {
    release = resolveHold
  })
  const tail = previous.then(() => hold)
  fileWriteTails.set(targetPath, tail)
  await previous

  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { flag: 'wx' })
    await renameWithRetry(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch((cleanupError: unknown) => {
      console.warn(`Temporary file ${temporaryPath} could not be removed:`, cleanupError)
    })
    throw error
  } finally {
    release()
    if (fileWriteTails.get(targetPath) === tail) {
      void tail.then(() => {
        if (fileWriteTails.get(targetPath) === tail) fileWriteTails.delete(targetPath)
      })
    }
  }
}

export async function readSettings(dataDirectory: string): Promise<AppSettings> {
  const saved = await readJson<Partial<AppSettings> & { scanPdfs?: unknown }>(
    join(dataDirectory, 'settings.json'),
    {}
  )
  if (Object.prototype.hasOwnProperty.call(saved, 'scanPdfs')) {
    delete saved.scanPdfs
    await writeJson(join(dataDirectory, 'settings.json'), saved)
  }
  const settings = { ...EMPTY_SETTINGS, ...saved }
  if (saved.epubCss === undefined) settings.epubCss = DEFAULT_EPUB_CSS
  else if (typeof settings.epubCss !== 'string' || settings.epubCss.length > MAX_EPUB_CSS_LENGTH) {
    throw new Error('The saved EPUB stylesheet is invalid or exceeds the size limit.')
  }
  if (saved.appTheme !== undefined && saved.appTheme !== 'light' && saved.appTheme !== 'dark') {
    throw new Error('The saved app theme must be light or dark.')
  }
  if (typeof settings.scanOldFolder !== 'boolean') {
    throw new Error('The saved Old-folder scan option must be a boolean value.')
  }
  if (
    !Number.isInteger(settings.discoveryFreshnessHours) ||
    settings.discoveryFreshnessHours < MIN_DISCOVERY_FRESHNESS_HOURS ||
    settings.discoveryFreshnessHours > MAX_DISCOVERY_FRESHNESS_HOURS
  ) {
    throw new Error(
      `The saved discovery freshness window must be a whole number from ${MIN_DISCOVERY_FRESHNESS_HOURS} to ${MAX_DISCOVERY_FRESHNESS_HOURS} hours.`
    )
  }
  return settings
}

export function writeSettings(dataDirectory: string, settings: AppSettings): Promise<void> {
  return writeJson(join(dataDirectory, 'settings.json'), settings)
}

function supportedEbookIndex(index: LibraryIndex | null): LibraryIndex | null {
  if (!index || !Array.isArray(index.files)) return index
  const files = index.files
    .filter((file) => file.format === 'EPUB' || file.format === 'AZW3')
    .map((file) => ({
      id: file.id,
      path: file.path,
      relativePath: file.relativePath,
      filename: file.filename,
      format: file.format,
      folderState: file.folderState,
      size: file.size,
      modifiedAt: file.modifiedAt,
      novelTitle: file.novelTitle,
      author: file.author,
      language: file.language,
      chapterTitles: file.chapterTitles,
      chapterNumbers: file.chapterNumbers,
      filenameRange: file.filenameRange,
      coverageConfidence: file.coverageConfidence,
      coverPath: file.coverPath,
      inspectionError: file.inspectionError
    }))
  return { ...index, files }
}

export async function readLibraryIndex(dataDirectory: string): Promise<LibraryIndex | null> {
  return supportedEbookIndex(await readJson<LibraryIndex | null>(join(dataDirectory, 'library-index.json'), null))
}

export async function readLibraryIndexBackup(dataDirectory: string): Promise<LibraryIndex | null> {
  return supportedEbookIndex(await readJson<LibraryIndex | null>(join(dataDirectory, 'library-index.backup.json'), null))
}

export async function writeLibraryIndex(
  dataDirectory: string,
  index: LibraryIndex,
  previousIndex?: LibraryIndex | null
): Promise<void> {
  const indexPath = join(dataDirectory, 'library-index.json')
  let backupCandidate = previousIndex
  if (backupCandidate === undefined) {
    try {
      backupCandidate = await readJson<LibraryIndex | null>(indexPath, null)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      console.warn('The existing library index is corrupt; replacing it without creating a backup.')
      backupCandidate = null
    }
  }
  if (backupCandidate) {
    await writeJson(join(dataDirectory, 'library-index.backup.json'), backupCandidate)
  }
  await writeJson(indexPath, index)
}

export function readDownloadHistory(dataDirectory: string): Promise<DownloadHistoryEntry[]> {
  return readJson(join(dataDirectory, 'download-history.json'), [])
}

function isLibraryOperation(value: unknown): value is LibraryOperation {
  if (typeof value !== 'object' || value === null) return false
  const operation = value as Partial<LibraryOperation>
  return (
    typeof operation.id === 'string' &&
    ['merge-epubs', 'epub-to-azw3', 'azw3-to-epub', 'repair-epub'].includes(operation.kind ?? '') &&
    ['running', 'completed', 'failed', 'interrupted'].includes(operation.status ?? '') &&
    Array.isArray(operation.inputFiles) &&
    operation.inputFiles.every((path) => typeof path === 'string') &&
    typeof operation.outputPath === 'string' &&
    (operation.progress === null ||
      (typeof operation.progress === 'number' && Number.isFinite(operation.progress) &&
        operation.progress >= 0 && operation.progress <= 100)) &&
    typeof operation.message === 'string' &&
    typeof operation.error === 'string' &&
    typeof operation.startedAt === 'string' &&
    typeof operation.updatedAt === 'string'
  )
}

export async function readLibraryOperations(dataDirectory: string): Promise<LibraryOperation[]> {
  const saved = await readJson<unknown>(join(dataDirectory, 'library-operations.json'), [])
  if (!Array.isArray(saved)) throw new Error('The saved library operation history is invalid.')
  const operations = saved.filter(isLibraryOperation)
  if (operations.length !== saved.length) {
    console.warn('Invalid entries in library operation history were ignored.')
  }
  return operations.slice(0, 30)
}

export function writeLibraryOperations(dataDirectory: string, operations: LibraryOperation[]): Promise<void> {
  return writeJson(join(dataDirectory, 'library-operations.json'), operations.slice(0, 30))
}

function serializeDownloadHistoryWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = downloadHistoryWriteTail.then(operation)
  downloadHistoryWriteTail = result.then(() => undefined, () => undefined)
  return result
}

export function readDiscoveryQueue(dataDirectory: string): Promise<DiscoveryQueueItem[]> {
  return readJson(join(dataDirectory, 'discovery-queue.json'), [])
}

export function writeDiscoveryQueue(dataDirectory: string, items: DiscoveryQueueItem[]): Promise<void> {
  return writeJson(join(dataDirectory, 'discovery-queue.json'), items)
}

function chapterArtifactPath(dataDirectory: string, queueItemId: string, chapterUrl: string): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId)) throw new Error('Invalid download queue identifier.')
  const filename = `${createHash('sha256').update(chapterUrl).digest('hex')}.json`
  return join(dataDirectory, 'download-artifacts', queueItemId, filename)
}

function coverArtifactPath(dataDirectory: string, queueItemId: string): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId)) throw new Error('Invalid download queue identifier.')
  return join(dataDirectory, 'download-artifacts', queueItemId, 'cover.json')
}

function isValidChapterImage(value: unknown): value is ChapterImage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sourceUrl' in value) ||
    !('mediaType' in value) ||
    !('dataBase64' in value)
  ) {
    return false
  }
  if (
    typeof value.sourceUrl !== 'string' ||
    typeof value.mediaType !== 'string' ||
    !Object.prototype.hasOwnProperty.call(EPUB_IMAGE_TYPES, value.mediaType) ||
    typeof value.dataBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)
  ) return false
  let source: URL
  try {
    source = new URL(value.sourceUrl)
  } catch {
    return false
  }
  const imageBytes = Buffer.byteLength(value.dataBase64, 'base64')
  return (
    (source.protocol === 'http:' || source.protocol === 'https:') &&
    !source.username &&
    !source.password &&
    imageBytes > 0 &&
    imageBytes <= MAX_IMAGE_BYTES
  )
}

export async function readChapterArtifact(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string
): Promise<ChapterContent | null> {
  const artifact = await readJson<ChapterContent | null>(
    chapterArtifactPath(dataDirectory, queueItemId, chapterUrl),
    null
  )
  const images = artifact?.images ?? []
  if (
    artifact !== null &&
    (typeof artifact.title !== 'string' ||
      typeof artifact.url !== 'string' ||
      !Array.isArray(artifact.paragraphs) ||
      artifact.paragraphs.some((paragraph) => typeof paragraph !== 'string') ||
      !Array.isArray(images) ||
      images.length > MAX_CHAPTER_IMAGES)
  ) {
    throw new Error('A saved chapter artifact is invalid and must be fetched again.')
  }
  if (artifact) {
    let totalImageBytes = 0
    for (const image of images) {
      if (!isValidChapterImage(image)) {
        throw new Error('A saved chapter artifact contains invalid image data and must be fetched again.')
      }
      const imageBytes = Buffer.byteLength(image.dataBase64, 'base64')
      totalImageBytes += imageBytes
      if (totalImageBytes > MAX_CHAPTER_IMAGE_BYTES) {
        throw new Error('A saved chapter artifact exceeds its image size limit and must be fetched again.')
      }
    }

    if (artifact.blocks !== undefined) {
      if (!Array.isArray(artifact.blocks)) {
        throw new Error('A saved chapter artifact has invalid content blocks and must be fetched again.')
      }
      for (const block of artifact.blocks) {
        if (
          typeof block !== 'object' ||
          block === null ||
          (block.type === 'paragraph' && typeof block.text === 'string') ||
          (block.type === 'image' &&
            Number.isInteger(block.imageIndex) &&
            block.imageIndex >= 0 &&
            block.imageIndex < images.length &&
            typeof block.alt === 'string' &&
            block.alt.length <= 1000)
        ) continue
        throw new Error('A saved chapter artifact has invalid content blocks and must be fetched again.')
      }
    }
  }
  return artifact
}

export async function readCoverArtifact(dataDirectory: string, queueItemId: string): Promise<ChapterImage | null> {
  const cover = await readJson<ChapterImage | null>(coverArtifactPath(dataDirectory, queueItemId), null)
  if (cover !== null && !isValidChapterImage(cover)) {
    throw new Error('The saved cover artifact is invalid and must be fetched again.')
  }
  return cover
}

export function writeCoverArtifact(
  dataDirectory: string,
  queueItemId: string,
  cover: ChapterImage
): Promise<void> {
  if (!isValidChapterImage(cover)) throw new Error('The cover image cannot be saved because its data is invalid.')
  return writeJson(coverArtifactPath(dataDirectory, queueItemId), cover)
}

export function writeChapterArtifact(
  dataDirectory: string,
  queueItemId: string,
  chapter: ChapterContent
): Promise<void> {
  return writeJson(chapterArtifactPath(dataDirectory, queueItemId, chapter.url), chapter)
}

export async function removeChapterArtifacts(dataDirectory: string, queueItemId: string): Promise<void> {
  if (!/^[\da-f-]{36}$/i.test(queueItemId)) throw new Error('Invalid download queue identifier.')
  await rm(join(dataDirectory, 'download-artifacts', queueItemId), { recursive: true, force: true })
}

export async function saveDownloadHistoryEntry(
  dataDirectory: string,
  entry: DownloadHistoryEntry
): Promise<DownloadHistoryEntry[]> {
  return serializeDownloadHistoryWrite(async () => {
    const history = await readDownloadHistory(dataDirectory)
    const existingIndex = history.findIndex((item) => item.id === entry.id)
    if (existingIndex >= 0) history[existingIndex] = entry
    else history.push(entry)
    history.sort((left, right) =>
      (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt)
    )
    const latest = history.slice(0, 50)
    await writeJson(join(dataDirectory, 'download-history.json'), latest)
    return latest
  })
}

export async function markInterruptedDownloadJobs(dataDirectory: string): Promise<void> {
  await serializeDownloadHistoryWrite(async () => {
    const history = await readDownloadHistory(dataDirectory)
    let changed = false
    for (const entry of history) {
      if (entry.status === 'running') {
        entry.status = 'interrupted'
        entry.error = 'The app closed before this job finished.'
        entry.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (changed) await writeJson(join(dataDirectory, 'download-history.json'), history)
  })
}

export async function writeLibraryCorrection(
  dataDirectory: string,
  fileId: string,
  correction: LibraryFileCorrection
): Promise<LibraryIndex> {
  const index = await readLibraryIndex(dataDirectory)
  if (!index) throw new Error('Scan the library before correcting a file.')

  const file = index.files.find((candidate) => candidate.id === fileId)
  if (!file) throw new Error('The selected library file is no longer indexed. Rescan the library.')

  const corrections = index.corrections ?? {}
  const saved = corrections[fileId] ?? {}
  if (correction.novelTitle !== undefined) saved.novelTitle = correction.novelTitle.trim()
  if (correction.chapterNumbers !== undefined) saved.chapterNumbers = [...new Set(correction.chapterNumbers)]
  corrections[fileId] = saved
  index.corrections = corrections
  if (saved.novelTitle) file.novelTitle = saved.novelTitle
  if (saved.chapterNumbers) {
    file.chapterNumbers = [...saved.chapterNumbers].sort((left, right) => left - right)
    file.coverageConfidence = 'user-corrected'
  }
  await writeLibraryIndex(dataDirectory, index)
  return index
}
