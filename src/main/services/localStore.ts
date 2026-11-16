import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  DEFAULT_EPUB_CSS,
  DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  EPUB_IMAGE_TYPES,
  DOMAIN_REQUEST_DELAYS_MS,
  MAX_CHAPTER_IMAGE_BYTES,
  MAX_CHAPTER_IMAGES,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_EPUB_CSS_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_SIMULTANEOUS_DISCOVERIES,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DOWNLOADS,
  MIN_SIMULTANEOUS_DISCOVERIES
} from '../../shared/constants'
import { normalizeSiteExtractionPreferences } from '../../shared/siteExtractionPreferences'
import { normalizeDomainRequestDelays } from '../../shared/domainRequestPreferences'
import { isNodeError } from '../../shared/errors'
import { atomicWriteFile, renameWithRetry } from './atomicFile'
import type {
  AppSettings,
  ChapterImage,
  ChapterContent,
  DiscoveryQueueItem,
  QueueChapter,
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
  scanOldCompletedFolder: false,
  maxSimultaneousDownloads: DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  maxSimultaneousDiscoveries: DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  maxSimultaneousChaptersPerNovel: DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  domainRequestDelays: Object.entries(DOMAIN_REQUEST_DELAYS_MS).map(([hostname, delayMs]) => ({
    hostname,
    delayMs
  })),
  discoveryFreshnessHours: DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  siteExtractionPreferences: [],
  epubCss: DEFAULT_EPUB_CSS,
  appTheme: 'light'
}
const fileWriteTails = new Map<string, Promise<void>>()
let downloadHistoryWriteTail = Promise.resolve()
const storageRecoveryWarnings = new Set<string>()

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return fallback
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isDownloadHistoryArray(value: unknown): value is DownloadHistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every((entry) =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.title === 'string' &&
      typeof entry.status === 'string'
    )
  )
}

function isDiscoveryQueueArray(value: unknown): value is DiscoveryQueueItem[] {
  return (
    Array.isArray(value) &&
    value.every((item) =>
      isRecord(item) &&
      typeof item.id === 'string' &&
      typeof item.title === 'string' &&
      (item.recoveryReason === undefined || item.recoveryReason === 'missing-history') &&
      (item.chapterSummary === undefined || isRecord(item.chapterSummary)) &&
      (item.chapters === undefined || (Array.isArray(item.chapters) && item.chapters.every(isRecord)))
    )
  )
}

function recordStorageRecoveryWarning(message: string): void {
  storageRecoveryWarnings.add(message)
}

export function takeStorageRecoveryWarnings(): string[] {
  const warnings = [...storageRecoveryWarnings]
  storageRecoveryWarnings.clear()
  return warnings
}

async function quarantineInvalidJsonFile(path: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinedPath = `${path}.corrupt-${timestamp}-${randomUUID()}`
  await renameWithRetry(path, quarantinedPath)
  return quarantinedPath
}

async function readJsonWithQuarantine<T>(
  path: string,
  fallback: T,
  isValid: (value: unknown) => value is T
): Promise<T> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return fallback
    if (!(error instanceof SyntaxError)) throw error
    const quarantinedPath = await quarantineInvalidJsonFile(path)
    recordStorageRecoveryWarning(
      `${basename(path)} was unreadable and moved to ${basename(quarantinedPath)}. Defaults will be used.`
    )
    return fallback
  }

  if (isValid(value)) return value
  const quarantinedPath = await quarantineInvalidJsonFile(path)
  recordStorageRecoveryWarning(
    `${basename(path)} had an invalid format and moved to ${basename(quarantinedPath)}. Defaults will be used.`
  )
  return fallback
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

  try {
    await atomicWriteFile(targetPath, `${JSON.stringify(value)}\n`)
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
  const saved = await readJsonWithQuarantine(join(dataDirectory, 'settings.json'), {}, isRecord)
  const defaults: AppSettings = {
    ...EMPTY_SETTINGS,
    domainRequestDelays: EMPTY_SETTINGS.domainRequestDelays.map((preference) => ({ ...preference })),
    siteExtractionPreferences: EMPTY_SETTINGS.siteExtractionPreferences.map((preference) => ({ ...preference }))
  }
  const warnings: string[] = []
  const setting = <T>(
    key: keyof AppSettings,
    label: string,
    fallback: T,
    isValid: (value: unknown) => value is T
  ): T => {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) return fallback
    const value = saved[key]
    if (isValid(value)) return value
    warnings.push(`The saved ${label} was invalid and has been reset to its default.`)
    return fallback
  }
  const normalizedSetting = <T>(
    key: keyof AppSettings,
    label: string,
    fallback: T,
    normalize: (value: unknown) => T
  ): T => {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) return fallback
    try {
      return normalize(saved[key])
    } catch (error) {
      if (!(error instanceof Error)) throw error
      warnings.push(`The saved ${label} was invalid and has been reset to its default.`)
      return fallback
    }
  }
  const integerBetween = (minimum: number, maximum: number) => (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum

  const settings: AppSettings = {
    libraryRoot: setting('libraryRoot', 'library folder', defaults.libraryRoot, (value): value is string => typeof value === 'string'),
    trackerCsvPath: setting('trackerCsvPath', 'tracker CSV path', defaults.trackerCsvPath, (value): value is string => typeof value === 'string'),
    outputDirectory: setting('outputDirectory', 'EPUB output folder', defaults.outputDirectory, (value): value is string => typeof value === 'string'),
    scanOldFolder: setting('scanOldFolder', 'Old-folder scan option', defaults.scanOldFolder, (value): value is boolean => typeof value === 'boolean'),
    scanOldCompletedFolder: setting(
      'scanOldCompletedFolder',
      'Old Completed-folder scan option',
      defaults.scanOldCompletedFolder,
      (value): value is boolean => typeof value === 'boolean'
    ),
    maxSimultaneousDownloads: setting(
      'maxSimultaneousDownloads',
      'download concurrency',
      defaults.maxSimultaneousDownloads,
      integerBetween(MIN_SIMULTANEOUS_DOWNLOADS, MAX_SIMULTANEOUS_DOWNLOADS)
    ),
    maxSimultaneousDiscoveries: setting(
      'maxSimultaneousDiscoveries',
      'discovery concurrency',
      defaults.maxSimultaneousDiscoveries,
      integerBetween(MIN_SIMULTANEOUS_DISCOVERIES, MAX_SIMULTANEOUS_DISCOVERIES)
    ),
    maxSimultaneousChaptersPerNovel: setting(
      'maxSimultaneousChaptersPerNovel',
      'per-novel chapter concurrency',
      defaults.maxSimultaneousChaptersPerNovel,
      integerBetween(MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL, MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL)
    ),
    domainRequestDelays: normalizedSetting(
      'domainRequestDelays',
      'domain request delays',
      defaults.domainRequestDelays,
      normalizeDomainRequestDelays
    ),
    discoveryFreshnessHours: setting(
      'discoveryFreshnessHours',
      'discovery freshness window',
      defaults.discoveryFreshnessHours,
      integerBetween(MIN_DISCOVERY_FRESHNESS_HOURS, MAX_DISCOVERY_FRESHNESS_HOURS)
    ),
    siteExtractionPreferences: normalizedSetting(
      'siteExtractionPreferences',
      'site extraction preferences',
      defaults.siteExtractionPreferences,
      normalizeSiteExtractionPreferences
    ),
    epubCss: setting(
      'epubCss',
      'EPUB stylesheet',
      DEFAULT_EPUB_CSS,
      (value): value is string => typeof value === 'string' && value.length <= MAX_EPUB_CSS_LENGTH
    ),
    appTheme: setting(
      'appTheme',
      'app theme',
      defaults.appTheme,
      (value): value is AppSettings['appTheme'] => value === 'light' || value === 'dark'
    )
  }
  for (const warning of warnings) recordStorageRecoveryWarning(warning)
  return settings
}

export async function migrateSettings(dataDirectory: string): Promise<void> {
  const settingsPath = join(dataDirectory, 'settings.json')
  const saved = await readJsonWithQuarantine(settingsPath, {}, isRecord)
  if (!Object.prototype.hasOwnProperty.call(saved, 'scanPdfs')) return
  const migrated = { ...saved }
  delete migrated.scanPdfs
  await writeJson(settingsPath, migrated)
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

export async function readLibraryIndexBackupDate(dataDirectory: string): Promise<string | null> {
  try {
    const details = await stat(join(dataDirectory, 'library-index.backup.json'))
    return details.isFile() ? details.mtime.toISOString() : null
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
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

export async function readDownloadHistory(dataDirectory: string): Promise<DownloadHistoryEntry[]> {
  return readJsonWithQuarantine(join(dataDirectory, 'download-history.json'), [], isDownloadHistoryArray)
}

function isLibraryOperation(value: unknown): value is LibraryOperation {
  if (typeof value !== 'object' || value === null) return false
  const operation = value as Partial<LibraryOperation>
  return (
    typeof operation.id === 'string' &&
    ['merge-epubs', 'repair-epub'].includes(operation.kind ?? '') &&
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

function isLegacyConversionOperation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  return value.kind === 'epub-to-azw3' || value.kind === 'azw3-to-epub'
}

export async function readLibraryOperations(dataDirectory: string): Promise<LibraryOperation[]> {
  const saved = await readJsonWithQuarantine(join(dataDirectory, 'library-operations.json'), [], isJsonArray)
  const nonLegacySaved = saved.filter((operation) => !isLegacyConversionOperation(operation))
  const operations = nonLegacySaved.filter(isLibraryOperation)
  if (operations.length !== nonLegacySaved.length) {
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

export async function readDiscoveryQueue(dataDirectory: string): Promise<DiscoveryQueueItem[]> {
  return readJsonWithQuarantine(join(dataDirectory, 'discovery-queue.json'), [], isDiscoveryQueueArray)
}

export function writeDiscoveryQueue(dataDirectory: string, items: DiscoveryQueueItem[]): Promise<void> {
  return writeJson(join(dataDirectory, 'discovery-queue.json'), items)
}

function discoveryQueueChaptersPath(dataDirectory: string, queueItemId: string): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId)) throw new Error('Invalid download queue identifier.')
  return join(dataDirectory, 'download-artifacts', queueItemId, 'queue-chapters.json')
}

export async function readDiscoveryQueueItemChapters(
  dataDirectory: string,
  queueItemId: string
): Promise<QueueChapter[] | null> {
  const chapters = await readJson<QueueChapter[] | null>(
    discoveryQueueChaptersPath(dataDirectory, queueItemId),
    null
  )
  if (chapters !== null && !Array.isArray(chapters)) {
    throw new Error('The saved queue chapter list is invalid.')
  }
  return chapters
}

export function writeDiscoveryQueueItemChapters(
  dataDirectory: string,
  queueItemId: string,
  chapters: QueueChapter[]
): Promise<void> {
  return writeJson(discoveryQueueChaptersPath(dataDirectory, queueItemId), chapters)
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
  entry: DownloadHistoryEntry,
  queueReferencedIds: readonly string[] = []
): Promise<DownloadHistoryEntry[]> {
  return serializeDownloadHistoryWrite(async () => {
    const history = await readDownloadHistory(dataDirectory)
    const existingIndex = history.findIndex((item) => item.id === entry.id)
    if (existingIndex >= 0) history[existingIndex] = entry
    else history.push(entry)
    history.sort((left, right) =>
      (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt)
    )
    const activeQueue = await readDiscoveryQueue(dataDirectory)
    const referencedHistoryIds = new Set(
      [
        ...activeQueue.map((item) => item.downloadHistoryId),
        ...queueReferencedIds
      ].filter((id) => typeof id === 'string' && id.length > 0)
    )
    const recentHistoryIds = new Set(history.slice(0, 50).map((item) => item.id))
    const retained = history.filter(
      (item) => referencedHistoryIds.has(item.id) || recentHistoryIds.has(item.id)
    )
    await writeJson(join(dataDirectory, 'download-history.json'), retained)
    return retained
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
