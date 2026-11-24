import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  DEFAULT_DOWNLOAD_RETRY_ATTEMPTS,
  DEFAULT_EPUB_CSS,
  DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS,
  DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  EPUB_IMAGE_TYPES,
  DOMAIN_REQUEST_DELAYS_MS,
  MAX_CHAPTER_IMAGE_BYTES,
  MAX_CHAPTER_IMAGES,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_DOWNLOAD_RETRY_ATTEMPTS,
  MAX_HTTP_CONNECT_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MAX_EPUB_CSS_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_SIMULTANEOUS_DISCOVERIES,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_DOWNLOAD_RETRY_ATTEMPTS,
  MIN_HTTP_CONNECT_TIMEOUT_MS,
  MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DOWNLOADS,
  MIN_SIMULTANEOUS_DISCOVERIES
} from '../../shared/constants'
import { normalizeSiteExtractionPreferences } from '../../shared/siteExtractionPreferences'
import { normalizeDomainRequestDelays } from '../../shared/domainRequestPreferences'
import {
  DEFAULT_EPUB_OUTPUT_PREFERENCES,
  normalizeEpubOutputPreferences
} from '../../shared/epubOutputOptions'
import { isNodeError } from '../../shared/errors'
import { atomicWriteFile, renameWithRetry } from './atomicFile'
import { chapterContentBlocksSchema } from '../../shared/chapterContentSchema'
import type {
  AppSettings,
  ChapterImage,
  ChapterContent,
  ChapterContentBlock,
  DiscoveryQueueItem,
  QueueChapter,
  DownloadHistoryEntry,
  LibraryOperation,
  LibraryIndex
} from '../../shared/contracts'
const EMPTY_SETTINGS: AppSettings = {
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: '',
  scanOldFolder: false,
  scanOldCompletedFolder: false,
  omitHttp404Chapters: false,
  maxSimultaneousDownloads: DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  maxDownloadRetryAttempts: DEFAULT_DOWNLOAD_RETRY_ATTEMPTS,
  httpConnectTimeoutMs: DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  httpResponseReadTimeoutMs: DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS,
  maxSimultaneousDiscoveries: DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  maxSimultaneousChaptersPerNovel: DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  domainRequestDelays: Object.entries(DOMAIN_REQUEST_DELAYS_MS).map(
    ([hostname, delayMs]) => ({
      hostname,
      delayMs
    })
  ),
  discoveryFreshnessHours: DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  siteExtractionPreferences: [],
  epubCss: DEFAULT_EPUB_CSS,
  epubOutputPreferences: { ...DEFAULT_EPUB_OUTPUT_PREFERENCES },
  appTheme: 'light'
}
const fileWriteTails = new Map<string, Promise<void>>()
let downloadHistoryWriteTail = Promise.resolve()
let downloadHistoryCachePath: string | null = null
let downloadHistoryCache: DownloadHistoryEntry[] | null = null
let libraryIndexCache:
  | {
      path: string
      size: number
      modifiedAtMs: number
      changedAtMs: number
      index: LibraryIndex | null
    }
  | undefined
const storageRecoveryWarnings = new Set<string>()

export function clearLibraryIndexCache(): void {
  libraryIndexCache = undefined
}

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

function isDownloadHistoryArray(
  value: unknown
): value is DownloadHistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.status === 'string'
    )
  )
}

export function isDiscoveryQueueArray(
  value: unknown
): value is DiscoveryQueueItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        (item.recoveryReason === undefined ||
          item.recoveryReason === 'missing-history') &&
        (item.chapterSummary === undefined || isRecord(item.chapterSummary)) &&
        (item.chapters === undefined ||
          (Array.isArray(item.chapters) && item.chapters.every(isRecord)))
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
        if (fileWriteTails.get(targetPath) === tail)
          fileWriteTails.delete(targetPath)
      })
    }
  }
}

export async function readSettings(
  dataDirectory: string
): Promise<AppSettings> {
  const saved = await readJsonWithQuarantine(
    join(dataDirectory, 'settings.json'),
    {},
    isRecord
  )
  const defaults: AppSettings = {
    ...EMPTY_SETTINGS,
    domainRequestDelays: EMPTY_SETTINGS.domainRequestDelays.map(
      (preference) => ({ ...preference })
    ),
    siteExtractionPreferences: EMPTY_SETTINGS.siteExtractionPreferences.map(
      (preference) => ({ ...preference })
    )
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
    warnings.push(
      `The saved ${label} was invalid and has been reset to its default.`
    )
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
      warnings.push(
        `The saved ${label} was invalid and has been reset to its default.`
      )
      return fallback
    }
  }
  const integerBetween =
    (minimum: number, maximum: number) =>
    (value: unknown): value is number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum

  const settings: AppSettings = {
    libraryRoot: setting(
      'libraryRoot',
      'library folder',
      defaults.libraryRoot,
      (value): value is string => typeof value === 'string'
    ),
    trackerCsvPath: setting(
      'trackerCsvPath',
      'tracker CSV path',
      defaults.trackerCsvPath,
      (value): value is string => typeof value === 'string'
    ),
    outputDirectory: setting(
      'outputDirectory',
      'EPUB output folder',
      defaults.outputDirectory,
      (value): value is string => typeof value === 'string'
    ),
    scanOldFolder: setting(
      'scanOldFolder',
      'Old-folder scan option',
      defaults.scanOldFolder,
      (value): value is boolean => typeof value === 'boolean'
    ),
    scanOldCompletedFolder: setting(
      'scanOldCompletedFolder',
      'Old Completed-folder scan option',
      defaults.scanOldCompletedFolder,
      (value): value is boolean => typeof value === 'boolean'
    ),
    omitHttp404Chapters: setting(
      'omitHttp404Chapters',
      'HTTP 404 chapter omission policy',
      defaults.omitHttp404Chapters,
      (value): value is boolean => typeof value === 'boolean'
    ),
    maxSimultaneousDownloads: setting(
      'maxSimultaneousDownloads',
      'download concurrency',
      defaults.maxSimultaneousDownloads,
      integerBetween(MIN_SIMULTANEOUS_DOWNLOADS, MAX_SIMULTANEOUS_DOWNLOADS)
    ),
    maxDownloadRetryAttempts: setting(
      'maxDownloadRetryAttempts',
      'download retry attempts',
      defaults.maxDownloadRetryAttempts,
      integerBetween(MIN_DOWNLOAD_RETRY_ATTEMPTS, MAX_DOWNLOAD_RETRY_ATTEMPTS)
    ),
    httpConnectTimeoutMs: setting(
      'httpConnectTimeoutMs',
      'HTTP connection timeout',
      defaults.httpConnectTimeoutMs,
      integerBetween(MIN_HTTP_CONNECT_TIMEOUT_MS, MAX_HTTP_CONNECT_TIMEOUT_MS)
    ),
    httpResponseReadTimeoutMs: setting(
      'httpResponseReadTimeoutMs',
      'HTTP response timeout',
      defaults.httpResponseReadTimeoutMs,
      integerBetween(
        MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
        MAX_HTTP_RESPONSE_READ_TIMEOUT_MS
      )
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
      integerBetween(
        MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
        MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL
      )
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
      integerBetween(
        MIN_DISCOVERY_FRESHNESS_HOURS,
        MAX_DISCOVERY_FRESHNESS_HOURS
      )
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
      (value): value is string =>
        typeof value === 'string' && value.length <= MAX_EPUB_CSS_LENGTH
    ),
    epubOutputPreferences: normalizedSetting(
      'epubOutputPreferences',
      'EPUB output preferences',
      defaults.epubOutputPreferences,
      normalizeEpubOutputPreferences
    ),
    appTheme: setting(
      'appTheme',
      'app theme',
      defaults.appTheme,
      (value): value is AppSettings['appTheme'] =>
        value === 'light' || value === 'dark' || value === 'system'
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

export function writeSettings(
  dataDirectory: string,
  settings: AppSettings
): Promise<void> {
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
      ...(file.stableBookId ? { stableBookId: file.stableBookId } : {}),
      ...(file.volumeIndex ? { volumeIndex: file.volumeIndex } : {}),
      author: file.author,
      language: file.language,
      chapterTitles: file.chapterTitles,
      chapterTitleKeys: file.chapterTitleKeys,
      chapterNumbers: file.chapterNumbers,
      filenameRange: file.filenameRange,
      coverageConfidence: file.coverageConfidence,
      coverPath: file.coverPath,
      inspectionError: file.inspectionError
    }))
  return { ...index, files }
}

export async function readLibraryIndex(
  dataDirectory: string
): Promise<LibraryIndex | null> {
  const path = join(dataDirectory, 'library-index.json')
  let details
  try {
    details = await stat(path)
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
    if (libraryIndexCache?.path === path) libraryIndexCache = undefined
    return null
  }
  if (
    libraryIndexCache?.path === path &&
    libraryIndexCache.size === details.size &&
    libraryIndexCache.modifiedAtMs === details.mtimeMs &&
    libraryIndexCache.changedAtMs === details.ctimeMs
  ) {
    return libraryIndexCache.index
  }

  const index = supportedEbookIndex(
    await readJson<LibraryIndex | null>(path, null)
  )
  libraryIndexCache = {
    path,
    size: details.size,
    modifiedAtMs: details.mtimeMs,
    changedAtMs: details.ctimeMs,
    index
  }
  return index
}

export async function readLibraryIndexBackup(
  dataDirectory: string
): Promise<LibraryIndex | null> {
  return supportedEbookIndex(
    await readJson<LibraryIndex | null>(
      join(dataDirectory, 'library-index.backup.json'),
      null
    )
  )
}

export async function readLibraryIndexBackupDate(
  dataDirectory: string
): Promise<string | null> {
  try {
    const details = await stat(join(dataDirectory, 'library-index.backup.json'))
    return details.isFile() ? details.mtime.toISOString() : null
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function copyDownloadHistory(
  history: DownloadHistoryEntry[]
): DownloadHistoryEntry[] {
  return history.map((entry) => ({
    ...entry,
    ...(entry.trackerRow ? { trackerRow: { ...entry.trackerRow } } : {})
  }))
}

export async function readArchivedDownloadHistory(
  dataDirectory: string
): Promise<DownloadHistoryEntry[]> {
  const path = join(dataDirectory, 'download-history.json')
  if (downloadHistoryCachePath !== path || !downloadHistoryCache) {
    downloadHistoryCache = await readJsonWithQuarantine(
      path,
      [],
      isDownloadHistoryArray
    )
    downloadHistoryCachePath = path
  }
  return copyDownloadHistory(downloadHistoryCache)
}

function isLibraryOperation(value: unknown): value is LibraryOperation {
  if (typeof value !== 'object' || value === null) return false
  const operation = value as Partial<LibraryOperation>
  return (
    typeof operation.id === 'string' &&
    ['merge-epubs', 'repair-epub'].includes(operation.kind ?? '') &&
    ['running', 'completed', 'failed', 'interrupted'].includes(
      operation.status ?? ''
    ) &&
    Array.isArray(operation.inputFiles) &&
    operation.inputFiles.every((path) => typeof path === 'string') &&
    typeof operation.outputPath === 'string' &&
    (operation.progress === null ||
      (typeof operation.progress === 'number' &&
        Number.isFinite(operation.progress) &&
        operation.progress >= 0 &&
        operation.progress <= 100)) &&
    typeof operation.message === 'string' &&
    typeof operation.error === 'string' &&
    typeof operation.startedAt === 'string' &&
    typeof operation.updatedAt === 'string'
  )
}

function isLegacyConversionOperation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('kind' in value))
    return false
  return value.kind === 'epub-to-azw3' || value.kind === 'azw3-to-epub'
}

export async function readLibraryOperations(
  dataDirectory: string
): Promise<LibraryOperation[]> {
  const saved = await readJsonWithQuarantine(
    join(dataDirectory, 'library-operations.json'),
    [],
    isJsonArray
  )
  const nonLegacySaved = saved.filter(
    (operation) => !isLegacyConversionOperation(operation)
  )
  const operations = nonLegacySaved.filter(isLibraryOperation)
  if (operations.length !== nonLegacySaved.length) {
    console.warn('Invalid entries in library operation history were ignored.')
  }
  return operations.slice(0, 30)
}

export function writeLibraryOperations(
  dataDirectory: string,
  operations: LibraryOperation[]
): Promise<void> {
  return writeJson(
    join(dataDirectory, 'library-operations.json'),
    operations.slice(0, 30)
  )
}

function serializeDownloadHistoryWrite<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = downloadHistoryWriteTail.then(operation)
  downloadHistoryWriteTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

export async function readDiscoveryQueue(
  dataDirectory: string
): Promise<DiscoveryQueueItem[]> {
  return readJsonWithQuarantine(
    join(dataDirectory, 'discovery-queue.json'),
    [],
    isDiscoveryQueueArray
  )
}

export function writeDiscoveryQueue(
  dataDirectory: string,
  items: DiscoveryQueueItem[]
): Promise<void> {
  return writeJson(join(dataDirectory, 'discovery-queue.json'), items)
}

export function discoveryQueueChaptersPath(
  dataDirectory: string,
  queueItemId: string
): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId))
    throw new Error('Invalid download queue identifier.')
  return join(
    dataDirectory,
    'download-artifacts',
    queueItemId,
    'queue-chapters.json'
  )
}

export function discoveryQueueSelectionPath(
  dataDirectory: string,
  queueItemId: string
): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId))
    throw new Error('Invalid download queue identifier.')
  return join(
    dataDirectory,
    'download-artifacts',
    queueItemId,
    'queue-selection.json'
  )
}

export async function readDiscoveryQueueItemChapters(
  dataDirectory: string,
  queueItemId: string
): Promise<QueueChapter[] | null> {
  const chaptersPath = discoveryQueueChaptersPath(dataDirectory, queueItemId)
  const selectionPath = discoveryQueueSelectionPath(dataDirectory, queueItemId)
  const chapters = await readJson<QueueChapter[] | null>(chaptersPath, null)
  if (chapters !== null && !Array.isArray(chapters)) {
    throw new Error('The saved queue chapter list is invalid.')
  }
  if (!chapters) return null

  const savedSelection = await readJson<string[] | null>(selectionPath, null)
  if (
    savedSelection !== null &&
    (!Array.isArray(savedSelection) ||
      savedSelection.some((id) => typeof id !== 'string'))
  ) {
    throw new Error('The saved queue chapter selection is invalid.')
  }
  const selectedIds =
    savedSelection ??
    chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.id)
  if (savedSelection === null) {
    await writeJson(selectionPath, selectedIds)
    await writeJson(
      chaptersPath,
      chapters.map(({ selected: _selected, ...chapter }) => chapter)
    )
  }
  const selectedIdSet = new Set(selectedIds)
  return chapters.map((chapter) => ({
    ...chapter,
    selected: selectedIdSet.has(chapter.id)
  }))
}

export function writeDiscoveryQueueItemChapters(
  dataDirectory: string,
  queueItemId: string,
  chapters: QueueChapter[]
): Promise<void> {
  const selectedIds = chapters
    .filter((chapter) => chapter.selected)
    .map((chapter) => chapter.id)
  const chapterData = chapters.map(
    ({ selected: _selected, ...chapter }) => chapter
  )
  return Promise.all([
    writeJson(
      discoveryQueueChaptersPath(dataDirectory, queueItemId),
      chapterData
    ),
    writeJson(
      discoveryQueueSelectionPath(dataDirectory, queueItemId),
      selectedIds
    )
  ]).then(() => undefined)
}

export function writeDiscoveryQueueItemSelection(
  dataDirectory: string,
  queueItemId: string,
  selectedChapterIds: string[]
): Promise<void> {
  return writeJson(discoveryQueueSelectionPath(dataDirectory, queueItemId), [
    ...new Set(selectedChapterIds)
  ])
}

function chapterArtifactPath(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string
): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId))
    throw new Error('Invalid download queue identifier.')
  const filename = `${createHash('sha256').update(chapterUrl).digest('hex')}.json`
  return join(dataDirectory, 'download-artifacts', queueItemId, filename)
}

export function chapterArtifactReference(
  queueItemId: string,
  chapterUrl: string
): string {
  return chapterArtifactPath('', queueItemId, chapterUrl)
}

export async function chapterArtifactFileExists(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string
): Promise<boolean> {
  try {
    const details = await lstat(
      chapterArtifactPath(dataDirectory, queueItemId, chapterUrl)
    )
    return details.isFile() && !details.isSymbolicLink()
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function chapterImageArtifactPath(
  chapterPath: string,
  imageHash: string
): string {
  if (!/^[\da-f]{64}$/i.test(imageHash))
    throw new Error('Invalid chapter image identifier.')
  return join(`${chapterPath}.images`, `image-${imageHash}.bin`)
}

function coverArtifactPath(dataDirectory: string, queueItemId: string): string {
  if (!/^[\da-f-]{36}$/i.test(queueItemId))
    throw new Error('Invalid download queue identifier.')
  return join(dataDirectory, 'download-artifacts', queueItemId, 'cover.json')
}

interface StoredChapterImage {
  sourceUrl: string
  mediaType: ChapterImage['mediaType']
  sha256: string
}

interface StoredChapterArtifactV2 {
  artifactVersion: 2
  title: string
  url: string
  paragraphs?: string[]
  blocks?: ChapterContentBlock[]
  images: StoredChapterImage[]
}

export interface ChapterArtifactImageFile extends Omit<
  StoredChapterImage,
  'sha256'
> {
  path: string
  sha256: string
}

export interface ChapterArtifactDescriptor {
  title: string
  url: string
  paragraphs: string[]
  blocks?: ChapterContentBlock[]
  images: ChapterArtifactImageFile[]
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactValidationError'
  }
}

function isValidChapterBlocks(
  value: unknown,
  imageCount: number
): value is ChapterContentBlock[] {
  return chapterContentBlocksSchema(imageCount).safeParse(value).success
}

function chapterBlockText(block: ChapterContentBlock): string[] {
  if (
    block.type === 'paragraph' ||
    block.type === 'heading' ||
    block.type === 'blockquote'
  )
    return [block.text]
  if (block.type === 'list') return block.items.map((item) => item.text)
  return []
}

function hasReadableChapterContent(
  paragraphs: string[] | undefined,
  blocks: ChapterContentBlock[] | undefined,
  imageCount: number
): boolean {
  if (blocks !== undefined) {
    return blocks.some(
      (block) =>
        block.type === 'image' ||
        chapterBlockText(block).some((text) => text.trim().length > 0)
    )
  }
  return (
    (paragraphs?.some((paragraph) => paragraph.trim().length > 0) ?? false) ||
    imageCount > 0
  )
}

function isEpubImageMediaType(
  value: unknown
): value is ChapterImage['mediaType'] {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(EPUB_IMAGE_TYPES, value)
  )
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
    !isEpubImageMediaType(value.mediaType) ||
    typeof value.dataBase64 !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.dataBase64
    )
  )
    return false
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

async function readChapterArtifact(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string
): Promise<ChapterContent | null> {
  const path = chapterArtifactPath(dataDirectory, queueItemId, chapterUrl)
  const artifact = await readJson<unknown>(path, null)
  if (artifact === null) return null

  if (
    typeof artifact === 'object' &&
    artifact !== null &&
    'artifactVersion' in artifact &&
    artifact.artifactVersion === 2
  ) {
    const stored = artifact as Partial<StoredChapterArtifactV2>
    const images = stored.images
    const validImageMetadata =
      Array.isArray(images) &&
      images.length <= MAX_CHAPTER_IMAGES &&
      images.every((image) => {
        if (
          typeof image !== 'object' ||
          image === null ||
          typeof image.sourceUrl !== 'string' ||
          !isEpubImageMediaType(image.mediaType) ||
          typeof image.sha256 !== 'string' ||
          !/^[\da-f]{64}$/i.test(image.sha256)
        )
          return false
        try {
          const source = new URL(image.sourceUrl)
          return (
            (source.protocol === 'http:' || source.protocol === 'https:') &&
            !source.username &&
            !source.password
          )
        } catch {
          return false
        }
      })
    const validContent =
      typeof stored.title === 'string' &&
      typeof stored.url === 'string' &&
      (stored.blocks !== undefined
        ? isValidChapterBlocks(stored.blocks, images?.length ?? 0)
        : Array.isArray(stored.paragraphs) &&
          stored.paragraphs.every((paragraph) => typeof paragraph === 'string'))
    const hasContent = hasReadableChapterContent(
      stored.paragraphs,
      stored.blocks,
      images?.length ?? 0
    )
    if (!validImageMetadata || !validContent || !hasContent) {
      throw new ArtifactValidationError(
        'A saved chapter artifact is invalid and must be fetched again.'
      )
    }

    let totalImageBytes = 0
    const loadedImages: ChapterImage[] = []
    for (const image of images) {
      const data = await readFile(chapterImageArtifactPath(path, image.sha256))
      totalImageBytes += data.length
      if (
        data.length === 0 ||
        data.length > MAX_IMAGE_BYTES ||
        totalImageBytes > MAX_CHAPTER_IMAGE_BYTES ||
        createHash('sha256').update(data).digest('hex') !== image.sha256
      ) {
        throw new ArtifactValidationError(
          'A saved chapter artifact contains invalid image data and must be fetched again.'
        )
      }
      loadedImages.push({
        sourceUrl: image.sourceUrl,
        mediaType: image.mediaType,
        dataBase64: data.toString('base64')
      })
    }

    const blocks = stored.blocks
    const paragraphs =
      blocks !== undefined
        ? blocks.flatMap(chapterBlockText)
        : stored.paragraphs!
    return {
      title: stored.title!,
      url: stored.url!,
      paragraphs,
      images: loadedImages,
      ...(blocks !== undefined ? { blocks } : {})
    }
  }

  const legacyArtifact = artifact as ChapterContent
  const legacyImages = legacyArtifact.images ?? []
  if (
    typeof legacyArtifact.title !== 'string' ||
    typeof legacyArtifact.url !== 'string' ||
    !Array.isArray(legacyArtifact.paragraphs) ||
    legacyArtifact.paragraphs.some(
      (paragraph) => typeof paragraph !== 'string'
    ) ||
    !Array.isArray(legacyImages) ||
    legacyImages.length > MAX_CHAPTER_IMAGES
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact is invalid and must be fetched again.'
    )
  }
  let totalImageBytes = 0
  for (const image of legacyImages) {
    if (!isValidChapterImage(image)) {
      throw new ArtifactValidationError(
        'A saved chapter artifact contains invalid image data and must be fetched again.'
      )
    }
    const imageBytes = Buffer.byteLength(image.dataBase64, 'base64')
    totalImageBytes += imageBytes
    if (totalImageBytes > MAX_CHAPTER_IMAGE_BYTES) {
      throw new ArtifactValidationError(
        'A saved chapter artifact exceeds its image size limit and must be fetched again.'
      )
    }
  }
  if (
    legacyArtifact.blocks !== undefined &&
    !isValidChapterBlocks(legacyArtifact.blocks, legacyImages.length)
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact has invalid content blocks and must be fetched again.'
    )
  }
  if (
    !hasReadableChapterContent(
      legacyArtifact.paragraphs,
      legacyArtifact.blocks,
      legacyImages.length
    )
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact contains no readable content.'
    )
  }
  return legacyArtifact
}

export async function readChapterArtifactDescriptor(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string,
  options: { verifyImages?: boolean } = {}
): Promise<ChapterArtifactDescriptor | null> {
  const path = chapterArtifactPath(dataDirectory, queueItemId, chapterUrl)
  const stored = await readJson<unknown>(path, null)
  if (stored === null) return null
  if (
    !isRecord(stored) ||
    stored.artifactVersion !== 2 ||
    !Array.isArray(stored.images)
  ) {
    const legacy = await readChapterArtifact(
      dataDirectory,
      queueItemId,
      chapterUrl
    )
    if (!legacy) return null
    await writeChapterArtifact(dataDirectory, queueItemId, legacy)
    return readChapterArtifactDescriptor(
      dataDirectory,
      queueItemId,
      chapterUrl,
      options
    )
  }

  const artifact = stored as Partial<StoredChapterArtifactV2>
  const artifactImages = artifact.images
  if (
    !Array.isArray(artifactImages) ||
    artifactImages.length > MAX_CHAPTER_IMAGES
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact is invalid and must be fetched again.'
    )
  }
  if (
    typeof artifact.title !== 'string' ||
    typeof artifact.url !== 'string' ||
    (artifact.blocks !== undefined
      ? !isValidChapterBlocks(artifact.blocks, artifactImages.length)
      : !Array.isArray(artifact.paragraphs) ||
        artifact.paragraphs.some((paragraph) => typeof paragraph !== 'string'))
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact is invalid and must be fetched again.'
    )
  }
  if (
    !hasReadableChapterContent(
      artifact.paragraphs,
      artifact.blocks,
      artifactImages.length
    )
  ) {
    throw new ArtifactValidationError(
      'A saved chapter artifact contains no readable content.'
    )
  }

  const images: ChapterArtifactImageFile[] = []
  let totalImageBytes = 0
  for (const value of artifactImages as unknown[]) {
    if (!isRecord(value)) {
      throw new ArtifactValidationError(
        'A saved chapter artifact contains invalid image metadata.'
      )
    }
    const sourceUrl = value.sourceUrl
    const mediaType = value.mediaType
    const sha256 = value.sha256
    if (
      typeof sourceUrl !== 'string' ||
      !isEpubImageMediaType(mediaType) ||
      typeof sha256 !== 'string' ||
      !/^[\da-f]{64}$/i.test(sha256)
    ) {
      throw new ArtifactValidationError(
        'A saved chapter artifact contains invalid image metadata.'
      )
    }
    let source: URL
    try {
      source = new URL(sourceUrl)
    } catch {
      throw new ArtifactValidationError(
        'A saved chapter artifact contains invalid image metadata.'
      )
    }
    if (
      (source.protocol !== 'http:' && source.protocol !== 'https:') ||
      source.username ||
      source.password
    ) {
      throw new ArtifactValidationError(
        'A saved chapter artifact contains invalid image metadata.'
      )
    }

    const imagePath = chapterImageArtifactPath(path, sha256)
    const details = await stat(imagePath)
    totalImageBytes += details.size
    if (
      details.size === 0 ||
      details.size > MAX_IMAGE_BYTES ||
      totalImageBytes > MAX_CHAPTER_IMAGE_BYTES
    ) {
      throw new ArtifactValidationError(
        'A saved chapter artifact exceeds its image size limit.'
      )
    }
    if (options.verifyImages !== false) {
      const hash = createHash('sha256')
      for await (const value of createReadStream(imagePath)) {
        const chunk: unknown = value
        if (!Buffer.isBuffer(chunk)) {
          throw new ArtifactValidationError(
            'A saved chapter artifact contains invalid image data.'
          )
        }
        hash.update(chunk)
      }
      if (hash.digest('hex') !== sha256) {
        throw new ArtifactValidationError(
          'A saved chapter artifact contains invalid image data and must be fetched again.'
        )
      }
    }
    images.push({
      sourceUrl,
      mediaType,
      sha256,
      path: imagePath
    })
  }

  return {
    title: artifact.title,
    url: artifact.url,
    paragraphs: artifact.blocks !== undefined ? [] : artifact.paragraphs!,
    ...(artifact.blocks !== undefined ? { blocks: artifact.blocks } : {}),
    images
  }
}

export async function chapterArtifactIsUsable(
  dataDirectory: string,
  queueItemId: string,
  chapterUrl: string
): Promise<boolean> {
  try {
    const descriptor = await readChapterArtifactDescriptor(
      dataDirectory,
      queueItemId,
      chapterUrl,
      { verifyImages: false }
    )
    return descriptor !== null && descriptor.url === chapterUrl
  } catch (error) {
    if (
      error instanceof ArtifactValidationError ||
      error instanceof SyntaxError ||
      (isNodeError(error) && error.code === 'ENOENT')
    ) {
      return false
    }
    throw error
  }
}

export async function readCoverArtifact(
  dataDirectory: string,
  queueItemId: string
): Promise<ChapterImage | null> {
  const cover = await readJson<ChapterImage | null>(
    coverArtifactPath(dataDirectory, queueItemId),
    null
  )
  if (cover !== null && !isValidChapterImage(cover)) {
    throw new Error(
      'The saved cover artifact is invalid and must be fetched again.'
    )
  }
  return cover
}

export function writeCoverArtifact(
  dataDirectory: string,
  queueItemId: string,
  cover: ChapterImage
): Promise<void> {
  if (!isValidChapterImage(cover))
    throw new Error(
      'The cover image cannot be saved because its data is invalid.'
    )
  return writeJson(coverArtifactPath(dataDirectory, queueItemId), cover)
}

export function writeChapterArtifact(
  dataDirectory: string,
  queueItemId: string,
  chapter: ChapterContent
): Promise<void> {
  return (async () => {
    if (
      typeof chapter.title !== 'string' ||
      typeof chapter.url !== 'string' ||
      !Array.isArray(chapter.paragraphs) ||
      chapter.paragraphs.some((paragraph) => typeof paragraph !== 'string')
    ) {
      throw new ArtifactValidationError(
        'The chapter cannot be saved because its content is invalid.'
      )
    }

    const images = chapter.images ?? []
    if (!Array.isArray(images) || images.length > MAX_CHAPTER_IMAGES) {
      throw new ArtifactValidationError(
        'The chapter cannot be saved because its image list is invalid.'
      )
    }
    if (
      chapter.blocks !== undefined &&
      !isValidChapterBlocks(chapter.blocks, images.length)
    ) {
      throw new ArtifactValidationError(
        'The chapter cannot be saved because its content blocks are invalid.'
      )
    }
    if (
      !hasReadableChapterContent(
        chapter.paragraphs,
        chapter.blocks,
        images.length
      )
    ) {
      throw new ArtifactValidationError(
        'The chapter cannot be saved because it contains no readable content.'
      )
    }

    const path = chapterArtifactPath(dataDirectory, queueItemId, chapter.url)
    const storedImages: StoredChapterImage[] = []
    let totalImageBytes = 0
    for (const image of images) {
      if (!isValidChapterImage(image)) {
        throw new ArtifactValidationError(
          'The chapter cannot be saved because an image is invalid.'
        )
      }
      const data = Buffer.from(image.dataBase64, 'base64')
      totalImageBytes += data.length
      if (totalImageBytes > MAX_CHAPTER_IMAGE_BYTES) {
        throw new ArtifactValidationError(
          'The chapter cannot be saved because its images exceed the size limit.'
        )
      }
      const sha256 = createHash('sha256').update(data).digest('hex')
      await atomicWriteFile(chapterImageArtifactPath(path, sha256), data)
      storedImages.push({
        sourceUrl: image.sourceUrl,
        mediaType: image.mediaType,
        sha256
      })
    }

    const stored: StoredChapterArtifactV2 = {
      artifactVersion: 2,
      title: chapter.title,
      url: chapter.url,
      ...(chapter.blocks !== undefined
        ? { blocks: chapter.blocks }
        : { paragraphs: chapter.paragraphs }),
      images: storedImages
    }
    await writeJson(path, stored)
  })()
}

export async function removeChapterArtifacts(
  dataDirectory: string,
  queueItemId: string
): Promise<void> {
  if (!/^[\da-f-]{36}$/i.test(queueItemId))
    throw new Error('Invalid download queue identifier.')
  await rm(join(dataDirectory, 'download-artifacts', queueItemId), {
    recursive: true,
    force: true
  })
}

export async function archiveDownloadJobs(
  dataDirectory: string,
  entries: readonly DownloadHistoryEntry[]
): Promise<DownloadHistoryEntry[]> {
  return serializeDownloadHistoryWrite(async () => {
    const history = await readArchivedDownloadHistory(dataDirectory)
    for (const entry of entries) {
      const existingIndex = history.findIndex((item) => item.id === entry.id)
      if (existingIndex >= 0) history[existingIndex] = entry
      else history.push(entry)
    }
    history.sort((left, right) =>
      (right.startedAt || right.updatedAt).localeCompare(
        left.startedAt || left.updatedAt
      )
    )
    const retained = history.slice(0, 50)
    await writeJson(join(dataDirectory, 'download-history.json'), retained)
    downloadHistoryCachePath = join(dataDirectory, 'download-history.json')
    downloadHistoryCache = copyDownloadHistory(retained)
    return copyDownloadHistory(retained)
  })
}
