import { access, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type {
  CoverageConfidence,
  LibraryFileCorrection,
  LibraryFileFormat,
  LibraryFileRecord,
  LibraryFileSearchPage,
  LibraryFolderState,
  LibraryIndex,
  LibraryIndexOverview,
  LibraryNovelSearchPage,
  DownloadedNovelLookupResult
} from '../../../shared/contracts'
import type { ArchiveRecommendationTarget } from '../../../shared/archiveRecommendation'
import {
  getArchiveRecommendationTitleKeys,
  normalizeNovelTitleAliases
} from '../../../shared/archiveRecommendation'
import {
  searchLibraryFileSummaries,
  summarizeLibraryIndex
} from '../../../shared/libraryIndexSummary'
import {
  normalizeNovelTitleForGrouping,
  normalizeNovelTitleForMatching
} from '../../../shared/novelTitle'
import { backupLegacyJsonFile } from '../../infra/jsonMigrationBackup'
import { withSqliteTransaction } from '../../infra/sqliteDatabase'
import type { SqliteDatabase } from '../../infra/sqliteDatabase'
import { samePath } from '../pathUtils'
import {
  extractNovelNameFromUrl,
  normalizeNovelLookupName,
  normalizeNovelSourceUrl
} from '../../../shared/downloadedNovelLookup'
import {
  clearLibraryIndexCache,
  readLibraryIndex,
  readLibraryIndexBackup,
  readLibraryIndexBackupDate
} from '../localStore'
import {
  applyLibraryFileCorrection,
  type LibraryIndexRepository
} from './libraryIndexRepository'

const LIBRARY_JSON_MIGRATION = 'library-json-v1'
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileFormat(value: unknown): value is LibraryFileFormat {
  return value === 'EPUB' || value === 'AZW3'
}

function isFolderState(value: unknown): value is LibraryFolderState {
  return (
    value === 'Completed' ||
    value === 'Downloaded' ||
    value === 'Sent' ||
    value === 'Old' ||
    value === 'Old Completed'
  )
}

function isCoverageConfidence(value: unknown): value is CoverageConfidence {
  return (
    value === 'extracted-toc' ||
    value === 'filename' ||
    value === 'user-corrected' ||
    value === 'unknown'
  )
}

function getString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`The saved library index has invalid ${field} data.`)
  }
  return value
}

function getNumber(value: SQLOutputValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The saved library index has invalid ${field} data.`)
  }
  return value
}

function getNullableString(
  value: SQLOutputValue | undefined,
  field: string
): string | null {
  if (value === null) return null
  return getString(value, field)
}

function getNullableNumber(
  value: SQLOutputValue | undefined,
  field: string
): number | null {
  if (value === null) return null
  return getNumber(value, field)
}

function isLibraryFileRecord(value: unknown): value is LibraryFileRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.path === 'string' &&
    typeof value.relativePath === 'string' &&
    typeof value.filename === 'string' &&
    isFileFormat(value.format) &&
    isFolderState(value.folderState) &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    typeof value.modifiedAt === 'string' &&
    typeof value.novelTitle === 'string' &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === 'string') &&
    typeof value.author === 'string' &&
    typeof value.language === 'string' &&
    Array.isArray(value.chapterTitles) &&
    value.chapterTitles.every((title) => typeof title === 'string') &&
    (value.chapterTitleKeys === undefined ||
      (Array.isArray(value.chapterTitleKeys) &&
        value.chapterTitleKeys.every((key) => typeof key === 'string'))) &&
    Array.isArray(value.chapterNumbers) &&
    value.chapterNumbers.every(
      (number) => typeof number === 'number' && Number.isFinite(number)
    ) &&
    (value.filenameRange === null ||
      (isRecord(value.filenameRange) &&
        typeof value.filenameRange.start === 'number' &&
        typeof value.filenameRange.end === 'number')) &&
    isCoverageConfidence(value.coverageConfidence) &&
    (value.coverPath === null || typeof value.coverPath === 'string') &&
    typeof value.inspectionError === 'string'
  )
}

function isLibraryIndex(value: unknown): value is LibraryIndex {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.libraryRoot === 'string' &&
    typeof value.scannedAt === 'string' &&
    Array.isArray(value.files) &&
    value.files.every(isLibraryFileRecord) &&
    isRecord(value.corrections) &&
    Object.values(value.corrections).every(
      (correction) =>
        isRecord(correction) &&
        (correction.novelTitle === undefined ||
          typeof correction.novelTitle === 'string') &&
        (correction.chapterNumbers === undefined ||
          (Array.isArray(correction.chapterNumbers) &&
            correction.chapterNumbers.every(
              (number) =>
                typeof number === 'number' && Number.isFinite(number)
            )))
    ) &&
    typeof value.scanErrors === 'number' &&
    Number.isSafeInteger(value.scanErrors) &&
    (value.scanSummary === undefined ||
      (isRecord(value.scanSummary) &&
        typeof value.scanSummary.reusedFiles === 'number' &&
        typeof value.scanSummary.inspectedFiles === 'number'))
  )
}

function decodeBackup(payload: string): LibraryIndex {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error) {
    throw new Error('The saved library index backup is malformed.', {
      cause: error
    })
  }
  if (!isLibraryIndex(value)) {
    throw new Error('The saved library index backup is invalid.')
  }
  return value
}

function parseFileRow(row: Record<string, SQLOutputValue>): LibraryFileRecord {
  const format = getString(row.format, 'file format')
  const folderState = getString(row.folder_state, 'folder state')
  const coverageConfidence = getString(row.coverage_confidence, 'coverage confidence')
  const rangeStart = getNullableNumber(row.filename_range_start, 'filename range')
  const rangeEnd = getNullableNumber(row.filename_range_end, 'filename range')
  if (
    !isFileFormat(format) ||
    !isFolderState(folderState) ||
    !isCoverageConfidence(coverageConfidence) ||
    (rangeStart === null) !== (rangeEnd === null)
  ) {
    throw new Error('The saved library index contains an invalid file record.')
  }
  const file: LibraryFileRecord = {
    id: getString(row.id, 'file identifier'),
    path: getString(row.path, 'file path'),
    relativePath: getString(row.relative_path, 'relative file path'),
    filename: getString(row.filename, 'filename'),
    format,
    folderState,
    size: getNumber(row.size, 'file size'),
    modifiedAt: getString(row.modified_at, 'file modification date'),
    novelTitle: getString(row.novel_title, 'novel title'),
    ...(typeof row.source_url === 'string' && row.source_url
      ? { sourceUrl: getString(row.source_url, 'source URL') }
      : {}),
    ...(row.stable_book_id === null || row.stable_book_id === undefined
      ? {}
      : { stableBookId: getString(row.stable_book_id, 'stable book identifier') }),
    ...(row.volume_index === null || row.volume_index === undefined
      ? {}
      : { volumeIndex: getNumber(row.volume_index, 'volume index') }),
    author: getString(row.author, 'author'),
    language: getString(row.language, 'language'),
    chapterTitles: [],
    chapterTitleKeys: [],
    chapterNumbers: [],
    filenameRange:
      rangeStart === null || rangeEnd === null
        ? null
        : { start: rangeStart, end: rangeEnd },
    coverageConfidence,
    coverPath: getNullableString(row.cover_path, 'cover path'),
    inspectionError: getString(row.inspection_error, 'inspection error')
  }
  return file
}

function readFilesByNovelIds(
  database: DatabaseSync,
  novelIds: string[]
): Map<string, LibraryFileRecord[]> {
  const filesByNovel = new Map<string, LibraryFileRecord[]>()
  if (novelIds.length === 0) return filesByNovel

  const placeholders = novelIds.map(() => '?').join(', ')
  const fileRows = database
    .prepare(
      `SELECT novel_id, id, path, relative_path, filename, format,
              folder_state, size, modified_at, novel_title, source_url, stable_book_id, volume_index, author, language,
              filename_range_start, filename_range_end, coverage_confidence,
              cover_path, inspection_error
       FROM library_files
       WHERE novel_id IN (${placeholders})
       ORDER BY ordinal`
    )
    .all(...novelIds)
  const filesById = new Map<string, LibraryFileRecord>()
  for (const row of fileRows) {
    const novelId = getString(row.novel_id, 'novel identifier')
    const file = parseFileRow(row)
    const files = filesByNovel.get(novelId) ?? []
    files.push(file)
    filesByNovel.set(novelId, files)
    filesById.set(file.id, file)
  }

  const chapterRows = database
    .prepare(
      `SELECT file_id, chapter_number, title_key
       FROM library_chapters
       WHERE file_id IN (
         SELECT id FROM library_files
         WHERE novel_id IN (${placeholders})
       )
       ORDER BY file_id, ordinal`
    )
    .all(...novelIds)
  for (const row of chapterRows) {
    const fileId = getString(row.file_id, 'chapter file identifier')
    const file = filesById.get(fileId)
    if (!file) {
      throw new Error(`Saved chapters refer to missing library file ${fileId}.`)
    }
    if (row.chapter_number !== null) {
      file.chapterNumbers.push(getNumber(row.chapter_number, 'chapter number'))
    }
    if (row.title_key !== null) {
      file.chapterTitleKeys?.push(getString(row.title_key, 'chapter title key'))
    }
  }
  return filesByNovel
}

function readFileRecordsByIds(
  database: DatabaseSync,
  fileIds: string[]
): LibraryFileRecord[] {
  const filesById = new Map<string, LibraryFileRecord>()
  const uniqueFileIds = [...new Set(fileIds)]
  for (let offset = 0; offset < uniqueFileIds.length; offset += 500) {
    const batch = uniqueFileIds.slice(offset, offset + 500)
    const placeholders = batch.map(() => '?').join(', ')
    const fileRows = database
      .prepare(
        `SELECT id, path, relative_path, filename, format, folder_state, size,
                modified_at, novel_title, source_url, stable_book_id, volume_index, author, language, filename_range_start,
                filename_range_end, coverage_confidence, cover_path, inspection_error
         FROM library_files WHERE id IN (${placeholders})`
      )
      .all(...batch)
    for (const row of fileRows) {
      const file = parseFileRow(row)
      filesById.set(file.id, file)
    }

    const chapterRows = database
      .prepare(
        `SELECT file_id, chapter_number, title_key
         FROM library_chapters
         WHERE file_id IN (${placeholders})
         ORDER BY file_id, ordinal`
      )
      .all(...batch)
    for (const row of chapterRows) {
      const fileId = getString(row.file_id, 'chapter file identifier')
      const file = filesById.get(fileId)
      if (!file) {
        throw new Error(`Saved chapters refer to missing library file ${fileId}.`)
      }
      if (row.chapter_number !== null) {
        file.chapterNumbers.push(getNumber(row.chapter_number, 'chapter number'))
      }
      if (row.title_key !== null) {
        file.chapterTitleKeys?.push(getString(row.title_key, 'chapter title key'))
      }
    }
  }

  return fileIds.flatMap((fileId) => {
    const file = filesById.get(fileId)
    return file ? [file] : []
  })
}

function createSummaryIndex(
  overview: LibraryIndexOverview,
  files: LibraryFileRecord[]
): LibraryIndex {
  return {
    schemaVersion: 1,
    libraryRoot: overview.libraryRoot,
    scannedAt: overview.scannedAt,
    files,
    corrections: {},
    scanErrors: overview.scanErrors,
    ...(overview.scanSummary ? { scanSummary: overview.scanSummary } : {})
  }
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((value, index) => value === right[index]))
  )
}

function sameFileContent(
  previous: LibraryFileRecord,
  next: LibraryFileRecord
): boolean {
  const previousTitleKeys =
    previous.chapterTitleKeys ??
    previous.chapterTitles
      .map(normalizeNovelTitleForMatching)
      .filter((titleKey) => titleKey.length > 0)
  const nextTitleKeys =
    next.chapterTitleKeys ??
    next.chapterTitles
      .map(normalizeNovelTitleForMatching)
      .filter((titleKey) => titleKey.length > 0)
  const sameFilenameRange =
    previous.filenameRange === null || next.filenameRange === null
      ? previous.filenameRange === next.filenameRange
      : previous.filenameRange.start === next.filenameRange.start &&
        previous.filenameRange.end === next.filenameRange.end

  return (
    previous.id === next.id &&
    previous.path === next.path &&
    previous.relativePath === next.relativePath &&
    previous.filename === next.filename &&
    previous.format === next.format &&
    previous.folderState === next.folderState &&
    previous.size === next.size &&
    previous.modifiedAt === next.modifiedAt &&
    previous.novelTitle === next.novelTitle &&
    previous.author === next.author &&
    previous.language === next.language &&
    sameArray(previous.chapterNumbers, next.chapterNumbers) &&
    sameArray(previousTitleKeys, nextTitleKeys) &&
    sameFilenameRange &&
    previous.coverageConfidence === next.coverageConfidence &&
    previous.coverPath === next.coverPath &&
    previous.inspectionError === next.inspectionError
  )
}

function sameCorrections(
  previous: LibraryIndex['corrections'],
  next: LibraryIndex['corrections']
): boolean {
  const previousIds = Object.keys(previous)
  if (previousIds.length !== Object.keys(next).length) return false
  return previousIds.every((fileId) => {
    const previousCorrection = previous[fileId]
    const nextCorrection = next[fileId]
    return (
      nextCorrection !== undefined &&
      previousCorrection.novelTitle === nextCorrection.novelTitle &&
      sameArray(
        previousCorrection.chapterNumbers ?? [],
        nextCorrection.chapterNumbers ?? []
      )
    )
  })
}

function sameLibraryContent(previous: LibraryIndex, next: LibraryIndex): boolean {
  return (
    previous.files.length === next.files.length &&
    previous.files.every((file, index) => {
      const nextFile = next.files[index]
      return nextFile !== undefined && sameFileContent(file, nextFile)
    }) &&
    sameCorrections(previous.corrections, next.corrections)
  )
}

function updateIndexMetadata(database: DatabaseSync, index: LibraryIndex): void {
  const result = database
    .prepare(
      `UPDATE library_index_metadata
       SET library_root = ?, scanned_at = ?, scan_errors = ?,
           reused_files = ?, inspected_files = ?
       WHERE id = 1`
    )
    .run(
      index.libraryRoot,
      index.scannedAt,
      index.scanErrors,
      index.scanSummary?.reusedFiles ?? null,
      index.scanSummary?.inspectedFiles ?? null
    )
  if (Number(result.changes) !== 1) {
    throw new Error('The saved library index metadata could not be updated.')
  }
}

function replaceIndex(database: DatabaseSync, index: LibraryIndex): void {
  database.exec('DELETE FROM library_files; DELETE FROM library_novels;')
  database.prepare('DELETE FROM library_index_metadata').run()

  database
    .prepare(
      `INSERT INTO library_index_metadata
       (id, library_root, scanned_at, scan_errors, reused_files, inspected_files)
       VALUES (1, ?, ?, ?, ?, ?)`
    )
    .run(
      index.libraryRoot,
      index.scannedAt,
      index.scanErrors,
      index.scanSummary?.reusedFiles ?? null,
      index.scanSummary?.inspectedFiles ?? null
    )

  const novels = new Map<string, string>()
  const novelSources = new Map<string, string>()
  for (const file of index.files) {
    const key = normalizeNovelTitleForGrouping(file.novelTitle)
    if (!novels.has(key)) novels.set(key, file.novelTitle)
    const sourceUrl = file.sourceUrl ? normalizeNovelSourceUrl(file.sourceUrl) : null
    if (sourceUrl && !novelSources.has(key)) novelSources.set(key, sourceUrl)
  }
  const insertNovel = database.prepare(
    `INSERT INTO library_novels (id, display_title, normalized_title, source_url, source_url_key)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insertAlias = database.prepare(
    'INSERT OR IGNORE INTO library_novel_aliases (novel_id, alias_key) VALUES (?, ?)'
  )
  for (const [key, title] of novels) {
    const sourceUrl = novelSources.get(key) ?? null
    insertNovel.run(key, title, key, sourceUrl, sourceUrl)
    const alias = normalizeNovelTitleForMatching(title)
    if (alias) insertAlias.run(key, alias)
  }

  const insertFile = database.prepare(
    `INSERT INTO library_files (
       id, ordinal, path, relative_path, filename, format, folder_state, size,
       modified_at, novel_id, novel_title, source_url, stable_book_id, volume_index, author, language,
       filename_range_start, filename_range_end, coverage_confidence,
       cover_path, inspection_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertChapter = database.prepare(
    `INSERT INTO library_chapters
     (file_id, ordinal, chapter_number, title_key)
     VALUES (?, ?, ?, ?)`
  )
  index.files.forEach((file, ordinal) => {
    const novelId = normalizeNovelTitleForGrouping(file.novelTitle)
    insertFile.run(
      file.id,
      ordinal,
      file.path,
      file.relativePath,
      file.filename,
      file.format,
      file.folderState,
      file.size,
      file.modifiedAt,
      novelId,
      file.novelTitle,
      file.sourceUrl ?? null,
      file.stableBookId ?? null,
      file.volumeIndex ?? null,
      file.author,
      file.language,
      file.filenameRange?.start ?? null,
      file.filenameRange?.end ?? null,
      file.coverageConfidence,
      file.coverPath,
      file.inspectionError
    )
    const titleKeys =
      file.chapterTitleKeys ??
      file.chapterTitles
        .map(normalizeNovelTitleForMatching)
        .filter((titleKey) => titleKey.length > 0)
    const rowCount = Math.max(file.chapterNumbers.length, titleKeys.length)
    for (let chapterOrdinal = 0; chapterOrdinal < rowCount; chapterOrdinal += 1) {
      const chapterNumber = file.chapterNumbers[chapterOrdinal] ?? null
      const titleKey = titleKeys[chapterOrdinal] ?? null
      if (chapterNumber === null && titleKey === null) continue
      insertChapter.run(file.id, chapterOrdinal, chapterNumber, titleKey)
    }
  })

  const insertCorrection = database.prepare(
    `INSERT INTO library_file_corrections (file_id, novel_title)
     VALUES (?, ?)`
  )
  const insertCorrectedChapter = database.prepare(
    `INSERT INTO library_correction_chapters (file_id, ordinal, chapter_number)
     VALUES (?, ?, ?)`
  )
  for (const [fileId, correction] of Object.entries(index.corrections ?? {})) {
    insertCorrection.run(fileId, correction.novelTitle ?? null)
    for (const [ordinal, chapterNumber] of (
      correction.chapterNumbers ?? []
    ).entries()) {
      insertCorrectedChapter.run(fileId, ordinal, chapterNumber)
    }
  }
}

function readIndex(database: DatabaseSync, includeChapterRows = true): LibraryIndex | null {
  const metadata = database
    .prepare(
      `SELECT library_root, scanned_at, scan_errors, reused_files, inspected_files
       FROM library_index_metadata WHERE id = 1`
    )
    .get()
  if (!metadata) return null

  const files = database
    .prepare(
      `SELECT id, path, relative_path, filename, format, folder_state, size,
              modified_at, novel_title, source_url, stable_book_id, volume_index, author, language, filename_range_start,
              filename_range_end, coverage_confidence, cover_path, inspection_error
       FROM library_files ORDER BY ordinal`
    )
    .all()
    .map(parseFileRow)
  const filesById = new Map(files.map((file) => [file.id, file]))
  const chapters = includeChapterRows
    ? database
        .prepare(
          `SELECT file_id, chapter_number, title_key
           FROM library_chapters ORDER BY file_id, ordinal`
        )
        .all()
    : database
        .prepare(
          `SELECT file_id, MIN(chapter_number) AS first_number,
                  MAX(chapter_number) AS last_number
           FROM library_chapters WHERE chapter_number IS NOT NULL
           GROUP BY file_id`
        )
        .all()
  for (const row of chapters) {
    const fileId = getString(row.file_id, 'chapter file identifier')
    const file = filesById.get(fileId)
    if (!file) {
      throw new Error(`Saved chapters refer to missing library file ${fileId}.`)
    }
    if (includeChapterRows) {
      if (row.chapter_number !== null) {
        file.chapterNumbers.push(getNumber(row.chapter_number, 'chapter number'))
      }
      if (row.title_key !== null) {
        file.chapterTitleKeys?.push(getString(row.title_key, 'chapter title key'))
      }
    } else {
      const first = getNumber(row.first_number, 'first chapter number')
      const last = getNumber(row.last_number, 'last chapter number')
      file.chapterNumbers = first === last ? [first] : [first, last]
    }
  }

  const corrections: LibraryIndex['corrections'] = {}
  const correctionRows = database
    .prepare(
      'SELECT file_id, novel_title FROM library_file_corrections'
    )
    .all()
  for (const row of correctionRows) {
    const fileId = getString(row.file_id, 'correction file identifier')
    corrections[fileId] = {}
    const novelTitle = getNullableString(row.novel_title, 'corrected novel title')
    if (novelTitle !== null) corrections[fileId].novelTitle = novelTitle
  }
  const correctedChapters = database
    .prepare(
      `SELECT file_id, chapter_number
       FROM library_correction_chapters ORDER BY file_id, ordinal`
    )
    .all()
  for (const row of correctedChapters) {
    const fileId = getString(row.file_id, 'correction file identifier')
    const correction = corrections[fileId]
    if (!correction) {
      throw new Error(`Chapter corrections refer to missing library file ${fileId}.`)
    }
    correction.chapterNumbers ??= []
    correction.chapterNumbers.push(
      getNumber(row.chapter_number, 'corrected chapter number')
    )
  }

  const scanSummary =
    metadata.reused_files === null || metadata.inspected_files === null
      ? undefined
      : {
          reusedFiles: getNumber(metadata.reused_files, 'reused file count'),
          inspectedFiles: getNumber(
            metadata.inspected_files,
            'inspected file count'
          )
        }
  return {
    schemaVersion: 1,
    libraryRoot: getString(metadata.library_root, 'library root'),
    scannedAt: getString(metadata.scanned_at, 'scan date'),
    files,
    corrections,
    scanErrors: getNumber(metadata.scan_errors, 'scan error count'),
    ...(scanSummary ? { scanSummary } : {})
  }
}

function readOverview(database: DatabaseSync): LibraryIndexOverview | null {
  const metadata = database
    .prepare(
      `SELECT library_root, scanned_at, scan_errors, reused_files, inspected_files
       FROM library_index_metadata WHERE id = 1`
    )
    .get()
  if (!metadata) return null

  const scanSummary =
    metadata.reused_files === null || metadata.inspected_files === null
      ? undefined
      : {
          reusedFiles: getNumber(metadata.reused_files, 'reused file count'),
          inspectedFiles: getNumber(
            metadata.inspected_files,
            'inspected file count'
          )
        }
  const overview: LibraryIndexOverview = {
    libraryRoot: getString(metadata.library_root, 'library root'),
    scannedAt: getString(metadata.scanned_at, 'scan date'),
    fileCount: getNumber(
      database.prepare('SELECT COUNT(*) AS count FROM library_files').get()?.count,
      'file count'
    ),
    scanErrors: getNumber(metadata.scan_errors, 'scan error count')
  }
  if (scanSummary) overview.scanSummary = scanSummary
  return overview
}

export function createSqliteLibraryIndexRepository(
  database: SqliteDatabase,
  dataDirectory: () => string
): LibraryIndexRepository {
  return new SqliteLibraryIndexRepository(database, dataDirectory)
}

class SqliteLibraryIndexRepository implements LibraryIndexRepository {
  private initialization: Promise<void> | null = null

  constructor(
    private readonly database: SqliteDatabase,
    private readonly dataDirectory: () => string
  ) {}

  async read(): Promise<LibraryIndex | null> {
    await this.ensureInitialized()
    return readIndex(await this.database.open())
  }

  async readScanCache(): Promise<LibraryIndex | null> {
    await this.ensureInitialized()
    return readIndex(await this.database.open(), false)
  }

  async readOverview(): Promise<LibraryIndexOverview | null> {
    await this.ensureInitialized()
    return readOverview(await this.database.open())
  }

  async lookupDownloadedNovels(urls: string[]): Promise<DownloadedNovelLookupResult[] | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    if (!readOverview(database)) return null
    const byUrl = database.prepare(
      `SELECT n.id, n.display_title, n.source_url, f.path
       FROM library_novels n
       JOIN library_files f ON f.novel_id = n.id
       WHERE f.source_url = ?
       ORDER BY n.id, f.ordinal`
    )
    const byName = database.prepare(
      `SELECT n.id, n.display_title, n.source_url, f.path
       FROM library_novels n
       JOIN library_files f ON f.novel_id = n.id
       WHERE n.normalized_title = ? OR EXISTS (
         SELECT 1 FROM library_novel_aliases a
         WHERE a.novel_id = n.id AND a.alias_key = ?
       )
       ORDER BY n.id, f.ordinal`
    )
    return urls.map((url) => {
      const normalizedUrl = normalizeNovelSourceUrl(url)
      const extractedName = extractNovelNameFromUrl(url)
      const nameKey = normalizeNovelLookupName(extractedName)
      const urlRows = normalizedUrl ? byUrl.all(normalizedUrl) : []
      const matchType = urlRows.length > 0 ? 'url' : 'name'
      const rows = urlRows.length > 0
        ? urlRows
        : nameKey
          ? byName.all(normalizeNovelTitleForGrouping(extractedName), nameKey)
          : []
      const matches = new Map<string, DownloadedNovelLookupResult['matches'][number]>()
      for (const row of rows) {
        const id = getString(row.id, 'novel identifier')
        let match = matches.get(id)
        if (!match) {
          match = {
            novelName: getString(row.display_title, 'novel title'),
            sourceUrl: typeof row.source_url === 'string' ? row.source_url : '',
            localPaths: []
          }
          matches.set(id, match)
        }
        const path = getString(row.path, 'local EPUB path')
        if (!match.localPaths.includes(path)) match.localPaths.push(path)
      }
      return {
        url,
        extractedName,
        matchType: matches.size > 0 ? matchType : null,
        matches: [...matches.values()]
      }
    })
  }

  async searchNovels(
    query: string,
    multipleFilesOnly: boolean,
    offset: number,
    limit: number,
    selectedNovelKey?: string
  ): Promise<LibraryNovelSearchPage | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const overview = readOverview(database)
    if (!overview) return null

    const novelRows = database
      .prepare(
        `SELECT n.id, n.display_title, COUNT(f.id) AS file_count
         FROM library_novels n
         JOIN library_files f ON f.novel_id = n.id
         GROUP BY n.id, n.display_title`
      )
      .all()
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const filenamesByNovel = new Map<string, string[]>()
    if (normalizedQuery) {
      const fileRows = database
        .prepare('SELECT novel_id, filename FROM library_files')
        .all()
      for (const row of fileRows) {
        const novelId = getString(row.novel_id, 'novel identifier')
        const filenames = filenamesByNovel.get(novelId) ?? []
        filenames.push(getString(row.filename, 'filename'))
        filenamesByNovel.set(novelId, filenames)
      }
    }

    const matchingNovels = novelRows
      .map((row) => ({
        key: getString(row.id, 'novel identifier'),
        title: getString(row.display_title, 'novel title'),
        fileCount: getNumber(row.file_count, 'novel file count')
      }))
      .filter(
        (novel) =>
          (!multipleFilesOnly || novel.fileCount > 1) &&
          (!normalizedQuery ||
            novel.title.toLocaleLowerCase().includes(normalizedQuery) ||
            (filenamesByNovel.get(novel.key) ?? []).some((filename) =>
              filename.toLocaleLowerCase().includes(normalizedQuery)
            ))
      )
      .sort((left, right) => left.title.localeCompare(right.title))
    const pageNovels = matchingNovels.slice(offset, offset + limit)
    const selectedNovel =
      selectedNovelKey
        ? matchingNovels.find((novel) => novel.key === selectedNovelKey) ?? null
        : null
    const novelIds = [
      ...new Set([
        ...pageNovels.map((novel) => novel.key),
        ...(selectedNovel ? [selectedNovel.key] : [])
      ])
    ]
    const filesByNovel = readFilesByNovelIds(database, novelIds)
    const summariesByNovel = new Map(
      novelIds.map((novelId) => {
        const files = filesByNovel.get(novelId) ?? []
        const summary = summarizeLibraryIndex(
          createSummaryIndex(overview, files)
        ).novels.find((novel) => novel.key === novelId)
        if (!summary) {
          throw new Error(
            `The saved library index has no files for novel ${novelId}.`
          )
        }
        return [novelId, summary] as const
      })
    )
    const getSummary = (novelId: string) => {
      const summary = summariesByNovel.get(novelId)
      if (!summary) {
        throw new Error(`The library summary for novel ${novelId} is missing.`)
      }
      return summary
    }
    return {
      total: matchingNovels.length,
      offset,
      items: pageNovels.map((novel) => getSummary(novel.key)),
      selectedNovel: selectedNovel ? getSummary(selectedNovel.key) : null
    }
  }

  async searchNovelFiles(
    novelKey: string,
    query: string,
    offset: number,
    limit: number
  ): Promise<LibraryFileSearchPage | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const overview = readOverview(database)
    if (!overview) return null
    const files = readFilesByNovelIds(database, [novelKey]).get(novelKey) ?? []
    return searchLibraryFileSummaries(
      createSummaryIndex(overview, files),
      novelKey,
      query,
      offset,
      limit
    )
  }

  async readNovelFiles(novelKey: string): Promise<LibraryFileRecord[] | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    if (!readOverview(database)) return null
    return readFilesByNovelIds(database, [novelKey]).get(novelKey) ?? []
  }

  async readFilesByIds(fileIds: string[]): Promise<LibraryFileRecord[] | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    if (!readOverview(database)) return null
    return readFileRecordsByIds(database, fileIds)
  }

  async readRecommendationFiles(
    item: ArchiveRecommendationTarget
  ): Promise<LibraryFileRecord[] | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    if (!readOverview(database)) return null

    const titleKeys = new Set(getArchiveRecommendationTitleKeys(item))
    if (titleKeys.size === 0) return []

    const matchingFileIds = new Set<string>()
    const matchingNovelIds = new Set<string>()
    const fileRows = database
      .prepare(
        `SELECT id, novel_id, novel_title
         FROM library_files ORDER BY ordinal`
      )
      .all()
    for (const row of fileRows) {
      const fileId = getString(row.id, 'file identifier')
      const novelTitle = getString(row.novel_title, 'novel title')
      if (
        !normalizeNovelTitleAliases(novelTitle).some((title) =>
          titleKeys.has(title)
        )
      ) {
        continue
      }
      matchingFileIds.add(fileId)
      matchingNovelIds.add(getString(row.novel_id, 'novel identifier'))
    }
    if (matchingNovelIds.size === 0) return []

    const novelIds = [...matchingNovelIds]
    const files: LibraryFileRecord[] = []
    for (let offset = 0; offset < novelIds.length; offset += 500) {
      const filesByNovel = readFilesByNovelIds(
        database,
        novelIds.slice(offset, offset + 500)
      )
      for (const novelFiles of filesByNovel.values()) files.push(...novelFiles)
    }
    const filesById = new Map(files.map((file) => [file.id, file]))
    return [...matchingFileIds].map((fileId) => {
      const file = filesById.get(fileId)
      if (!file) {
        throw new Error(
          `Saved recommendation files refer to missing library file ${fileId}.`
        )
      }
      return file
    })
  }

  async readBackup(): Promise<LibraryIndex | null> {
    await this.ensureInitialized()
    const row = (await this.database.open())
      .prepare('SELECT payload_json FROM library_index_backup WHERE id = 1')
      .get()
    if (!row) return null
    const payload = getString(row.payload_json, 'backup payload')
    if (payload) return decodeBackup(payload)
    const backupDatabasePath = join(this.dataDirectory(), 'library-index.backup.sqlite')
    try {
      await access(backupDatabasePath)
    } catch {
      return null
    }
    const backupDatabase = new DatabaseSync(backupDatabasePath, { readOnly: true })
    try {
      return readIndex(backupDatabase)
    } finally {
      backupDatabase.close()
    }
  }

  async readBackupDate(): Promise<string | null> {
    await this.ensureInitialized()
    const row = (await this.database.open())
      .prepare('SELECT saved_at FROM library_index_backup WHERE id = 1')
      .get()
    return row
      ? getString(row.saved_at, 'backup date')
      : null
  }

  async write(index: LibraryIndex, previousIndex?: LibraryIndex | null): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const backupCandidate =
      previousIndex === undefined ? await this.read() : previousIndex
    const contentChanged =
      !backupCandidate || !sameLibraryContent(backupCandidate, index)
    if (backupCandidate && contentChanged) {
      await this.writeBackupSnapshot(database)
    }
    withSqliteTransaction(database, () => {
      if (backupCandidate && contentChanged) this.updateBackupDate(database)
      if (backupCandidate && sameLibraryContent(backupCandidate, index)) {
        updateIndexMetadata(database, index)
      } else {
        replaceIndex(database, index)
      }
    })
  }

  async writeScan(index: LibraryIndex): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const metadata = database.prepare('SELECT library_root FROM library_index_metadata WHERE id = 1').get()
    const existingRoot = typeof metadata?.library_root === 'string' ? metadata.library_root : null
    const sameRoot = existingRoot !== null && samePath(existingRoot, index.libraryRoot)
    const contentChanged = index.scanSummary?.contentChanged !== false
    if (existingRoot && contentChanged) await this.writeBackupSnapshot(database)

    if (sameRoot && !contentChanged) {
      withSqliteTransaction(database, () => updateIndexMetadata(database, index))
      clearLibraryIndexCache()
      return
    }

    withSqliteTransaction(database, () => {
      if (!sameRoot || !index.scanSummary?.scannedFolders) {
        replaceIndex(database, index)
        if (existingRoot && contentChanged) this.updateBackupDate(database)
        return
      }

      const scannedFolders = new Set(index.scanSummary.scannedFolders)
      const filesById = new Map(index.files.map((file) => [file.id, file]))
      const existingFiles = database.prepare('SELECT id, folder_state, modified_at FROM library_files').all()
      const deleteFile = database.prepare('DELETE FROM library_files WHERE id = ?')
      for (const row of existingFiles) {
        const id = getString(row.id, 'file identifier')
        const folder = getString(row.folder_state, 'folder state')
        if (scannedFolders.has(folder as LibraryFolderState) && !filesById.has(id)) {
          const modifiedAt = getString(row.modified_at, 'file modification date')
          const wasIndexedDuringScan = index.scanSummary?.scanStartedAt !== undefined &&
            Date.parse(modifiedAt) > Date.parse(index.scanSummary.scanStartedAt)
          if (!wasIndexedDuringScan) deleteFile.run(id)
        }
      }

      const reusedFileIds = new Set(index.scanSummary.reusedFileIds ?? [])
      const insertNovel = database.prepare(
        `INSERT INTO library_novels (
           id, display_title, normalized_title, source_url, source_url_key
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_title = excluded.display_title,
           normalized_title = excluded.normalized_title,
           source_url = COALESCE(excluded.source_url, library_novels.source_url),
           source_url_key = COALESCE(excluded.source_url_key, library_novels.source_url_key)`
      )
      const insertAlias = database.prepare(
        'INSERT OR IGNORE INTO library_novel_aliases (novel_id, alias_key) VALUES (?, ?)'
      )
      const upsertFile = database.prepare(
        `INSERT INTO library_files (
           id, ordinal, path, relative_path, filename, format, folder_state, size,
           modified_at, novel_id, novel_title, source_url, stable_book_id, volume_index, author,
           language, filename_range_start, filename_range_end, coverage_confidence,
           cover_path, inspection_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ordinal = excluded.ordinal,
           path = excluded.path, relative_path = excluded.relative_path,
           filename = excluded.filename, format = excluded.format,
           folder_state = excluded.folder_state, size = excluded.size,
           modified_at = excluded.modified_at, novel_id = excluded.novel_id,
           novel_title = excluded.novel_title, source_url = excluded.source_url,
           stable_book_id = excluded.stable_book_id,
           volume_index = excluded.volume_index, author = excluded.author,
           language = excluded.language, filename_range_start = excluded.filename_range_start,
           filename_range_end = excluded.filename_range_end,
           coverage_confidence = excluded.coverage_confidence,
           cover_path = excluded.cover_path, inspection_error = excluded.inspection_error`
      )
      const deleteChapters = database.prepare('DELETE FROM library_chapters WHERE file_id = ?')
      const insertChapter = database.prepare(
        `INSERT INTO library_chapters (file_id, ordinal, chapter_number, title_key)
         VALUES (?, ?, ?, ?)`
      )
      index.files.forEach((file, ordinal) => {
        const novelId = normalizeNovelTitleForGrouping(file.novelTitle)
        const sourceUrl = file.sourceUrl ? normalizeNovelSourceUrl(file.sourceUrl) : null
        insertNovel.run(novelId, file.novelTitle, novelId, sourceUrl, sourceUrl)
        const alias = normalizeNovelTitleForMatching(file.novelTitle)
        if (alias) insertAlias.run(novelId, alias)
        upsertFile.run(
          file.id, ordinal, file.path, file.relativePath, file.filename, file.format,
          file.folderState, file.size, file.modifiedAt, novelId, file.novelTitle,
          file.sourceUrl ?? null, file.stableBookId ?? null, file.volumeIndex ?? null,
          file.author, file.language,
          file.filenameRange?.start ?? null, file.filenameRange?.end ?? null,
          file.coverageConfidence, file.coverPath, file.inspectionError
        )
        if (reusedFileIds.has(file.id)) return
        deleteChapters.run(file.id)
        const titleKeys = file.chapterTitleKeys ??
          file.chapterTitles.map(normalizeNovelTitleForMatching).filter((key) => key.length > 0)
        const rowCount = Math.max(file.chapterNumbers.length, titleKeys.length)
        for (let chapterOrdinal = 0; chapterOrdinal < rowCount; chapterOrdinal += 1) {
          const chapterNumber = file.chapterNumbers[chapterOrdinal] ?? null
          const titleKey = titleKeys[chapterOrdinal] ?? null
          if (chapterNumber !== null || titleKey !== null) {
            insertChapter.run(file.id, chapterOrdinal, chapterNumber, titleKey)
          }
        }
      })

      database.exec('DELETE FROM library_file_corrections')
      const insertCorrection = database.prepare(
        'INSERT INTO library_file_corrections (file_id, novel_title) VALUES (?, ?)'
      )
      const insertCorrectedChapter = database.prepare(
        `INSERT INTO library_correction_chapters (file_id, ordinal, chapter_number)
         VALUES (?, ?, ?)`
      )
      for (const [fileId, correction] of Object.entries(index.corrections)) {
        if (!filesById.has(fileId)) continue
        insertCorrection.run(fileId, correction.novelTitle ?? null)
        for (const [ordinal, chapterNumber] of (correction.chapterNumbers ?? []).entries()) {
          insertCorrectedChapter.run(fileId, ordinal, chapterNumber)
        }
      }

      database.exec('DELETE FROM library_novel_aliases; DELETE FROM library_novels;')
      const novelRows = database.prepare(
        'SELECT novel_title, source_url FROM library_files ORDER BY ordinal'
      ).all()
      const novelSources = new Map<string, string>()
      const novelTitles = new Map<string, string>()
      for (const row of novelRows) {
        const title = getString(row.novel_title, 'novel title')
        const novelId = normalizeNovelTitleForGrouping(title)
        if (!novelTitles.has(novelId)) novelTitles.set(novelId, title)
        const sourceUrl = typeof row.source_url === 'string'
          ? normalizeNovelSourceUrl(row.source_url)
          : null
        if (sourceUrl && !novelSources.has(novelId)) novelSources.set(novelId, sourceUrl)
      }
      const updateNovel = database.prepare('UPDATE library_files SET novel_id = ? WHERE novel_title = ?')
      for (const [novelId, title] of novelTitles) {
        const sourceUrl = novelSources.get(novelId) ?? null
        insertNovel.run(novelId, title, novelId, sourceUrl, sourceUrl)
        const alias = normalizeNovelTitleForMatching(title)
        if (alias) insertAlias.run(novelId, alias)
      }
      for (const row of novelRows) {
        const title = getString(row.novel_title, 'novel title')
        updateNovel.run(normalizeNovelTitleForGrouping(title), title)
      }
      database.prepare(
        `UPDATE library_index_metadata
         SET library_root = ?, scanned_at = ?, scan_errors = ?, reused_files = ?, inspected_files = ?
         WHERE id = 1`
      ).run(
        index.libraryRoot, index.scannedAt, index.scanErrors,
        index.scanSummary?.reusedFiles ?? null,
        index.scanSummary?.inspectedFiles ?? null
      )
      if (existingRoot && contentChanged) this.updateBackupDate(database)
    })
    clearLibraryIndexCache()
  }

  async upsertFile(
    file: LibraryFileRecord,
    libraryRoot: string
  ): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const previous = readIndex(database)
    if (previous && !samePath(previous.libraryRoot, libraryRoot)) {
      throw new Error(
        'The saved library index belongs to a different folder. Scan the configured library folder before indexing this EPUB.'
      )
    }

    const indexedFile = applyLibraryFileCorrection(
      file,
      previous?.corrections[file.id]
    )
    const novelId = normalizeNovelTitleForGrouping(indexedFile.novelTitle)
    if (!novelId) {
      throw new Error('The EPUB has no usable title for the library index.')
    }
    const savedAt = new Date().toISOString()
    const oldFile = database
      .prepare('SELECT ordinal, novel_id FROM library_files WHERE id = ?')
      .get(indexedFile.id)
    const ordinal =
      typeof oldFile?.ordinal === 'number'
        ? oldFile.ordinal
        : getNumber(
            database
              .prepare(
                'SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal FROM library_files'
              )
              .get()?.next_ordinal,
            'next file ordinal'
          )
    const oldNovelId =
      typeof oldFile?.novel_id === 'string' ? oldFile.novel_id : null
    const insertTitleKeys =
      indexedFile.chapterTitleKeys ??
      indexedFile.chapterTitles
        .map(normalizeNovelTitleForMatching)
        .filter((titleKey) => titleKey.length > 0)

    if (previous) await this.writeBackupSnapshot(database)

    withSqliteTransaction(database, () => {
      if (previous) {
        this.updateBackupDate(database)
        database
          .prepare(
            'UPDATE library_index_metadata SET scanned_at = ? WHERE id = 1'
          )
          .run(savedAt)
      } else {
        database
          .prepare(
            `INSERT INTO library_index_metadata
             (id, library_root, scanned_at, scan_errors, reused_files, inspected_files)
             VALUES (1, ?, ?, 0, NULL, NULL)`
          )
          .run(libraryRoot, savedAt)
      }

      database
        .prepare(
          `INSERT INTO library_novels (
             id, display_title, normalized_title, source_url, source_url_key
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_title = excluded.display_title,
             normalized_title = excluded.normalized_title,
             source_url = COALESCE(excluded.source_url, library_novels.source_url),
             source_url_key = COALESCE(excluded.source_url_key, library_novels.source_url_key)`
        )
        .run(
          novelId,
          indexedFile.novelTitle,
          novelId,
          indexedFile.sourceUrl ?? null,
          indexedFile.sourceUrl ? normalizeNovelSourceUrl(indexedFile.sourceUrl) : null
        )
      const alias = normalizeNovelTitleForMatching(indexedFile.novelTitle)
      if (alias) {
        database
          .prepare(
            'INSERT OR IGNORE INTO library_novel_aliases (novel_id, alias_key) VALUES (?, ?)'
          )
          .run(novelId, alias)
      }

      database
        .prepare(
          `INSERT INTO library_files (
             id, ordinal, path, relative_path, filename, format, folder_state, size,
             modified_at, novel_id, novel_title, source_url, stable_book_id, volume_index, author, language,
             filename_range_start, filename_range_end, coverage_confidence,
             cover_path, inspection_error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             ordinal = excluded.ordinal,
             path = excluded.path,
             relative_path = excluded.relative_path,
             filename = excluded.filename,
             format = excluded.format,
             folder_state = excluded.folder_state,
             size = excluded.size,
             modified_at = excluded.modified_at,
             novel_id = excluded.novel_id,
             novel_title = excluded.novel_title,
             source_url = excluded.source_url,
             stable_book_id = excluded.stable_book_id,
             volume_index = excluded.volume_index,
             author = excluded.author,
             language = excluded.language,
             filename_range_start = excluded.filename_range_start,
             filename_range_end = excluded.filename_range_end,
             coverage_confidence = excluded.coverage_confidence,
             cover_path = excluded.cover_path,
             inspection_error = excluded.inspection_error`
        )
        .run(
          indexedFile.id,
          ordinal,
          indexedFile.path,
          indexedFile.relativePath,
          indexedFile.filename,
          indexedFile.format,
          indexedFile.folderState,
          indexedFile.size,
          indexedFile.modifiedAt,
          novelId,
          indexedFile.novelTitle,
          indexedFile.sourceUrl ?? null,
          indexedFile.stableBookId ?? null,
          indexedFile.volumeIndex ?? null,
          indexedFile.author,
          indexedFile.language,
          indexedFile.filenameRange?.start ?? null,
          indexedFile.filenameRange?.end ?? null,
          indexedFile.coverageConfidence,
          indexedFile.coverPath,
          indexedFile.inspectionError
        )
      database
        .prepare('DELETE FROM library_chapters WHERE file_id = ?')
        .run(indexedFile.id)
      const insertChapter = database.prepare(
        `INSERT INTO library_chapters
         (file_id, ordinal, chapter_number, title_key)
         VALUES (?, ?, ?, ?)`
      )
      const chapterCount = Math.max(
        indexedFile.chapterNumbers.length,
        insertTitleKeys.length
      )
      for (let chapterOrdinal = 0; chapterOrdinal < chapterCount; chapterOrdinal += 1) {
        const chapterNumber =
          indexedFile.chapterNumbers[chapterOrdinal] ?? null
        const titleKey = insertTitleKeys[chapterOrdinal] ?? null
        if (chapterNumber === null && titleKey === null) continue
        insertChapter.run(
          indexedFile.id,
          chapterOrdinal,
          chapterNumber,
          titleKey
        )
      }

      if (oldNovelId && oldNovelId !== novelId) {
        database
          .prepare(
            `DELETE FROM library_novels
             WHERE id = ? AND NOT EXISTS (
               SELECT 1 FROM library_files WHERE novel_id = ?
             )`
          )
          .run(oldNovelId, oldNovelId)
      }
    })
  }

  async writeCorrection(
    fileId: string,
    correction: LibraryFileCorrection
  ): Promise<LibraryFileRecord> {
    const previousIndex = await this.read()
    if (!previousIndex) {
      throw new Error('Scan the library before correcting a file.')
    }
    const index = structuredClone(previousIndex)

    const file = index.files.find((candidate) => candidate.id === fileId)
    if (!file) {
      throw new Error('The selected library file is no longer indexed. Rescan the library.')
    }
    const saved = { ...(index.corrections[fileId] ?? {}) }
    if (correction.novelTitle !== undefined) {
      saved.novelTitle = correction.novelTitle.trim()
    }
    if (correction.chapterNumbers !== undefined) {
      saved.chapterNumbers = [...new Set(correction.chapterNumbers)]
    }
    index.corrections[fileId] = saved
    if (saved.novelTitle) file.novelTitle = saved.novelTitle
    if (saved.chapterNumbers) {
      file.chapterNumbers = [...saved.chapterNumbers].sort(
        (left, right) => left - right
      )
      file.coverageConfidence = 'user-corrected'
    }
    await this.write(index, previousIndex)
    return file
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) this.initialization = this.initialize()
    return this.initialization.catch((error: unknown) => {
      this.initialization = null
      throw error
    })
  }

  private async initialize(): Promise<void> {
    const database = await this.database.open()
    const marker = database
      .prepare('SELECT migration_id FROM storage_migrations WHERE migration_id = ?')
      .get(LIBRARY_JSON_MIGRATION)
    if (marker) return

    const dataDirectory = this.dataDirectory()
    const indexPath = join(dataDirectory, 'library-index.json')
    const backupPath = join(dataDirectory, 'library-index.backup.json')
    await backupLegacyJsonFile(indexPath, `${indexPath}.pre-sqlite.bak`)
    await backupLegacyJsonFile(backupPath, `${backupPath}.pre-sqlite.bak`)
    try {
      const legacyIndex = await readLibraryIndex(dataDirectory)
      const legacyBackup = await readLibraryIndexBackup(dataDirectory)
      const legacyBackupDate = await readLibraryIndexBackupDate(dataDirectory)

      withSqliteTransaction(database, () => {
        const completed = database
          .prepare(
            'SELECT migration_id FROM storage_migrations WHERE migration_id = ?'
          )
          .get(LIBRARY_JSON_MIGRATION)
        if (completed) return

        const existingIndexCount = database
          .prepare('SELECT COUNT(*) AS count FROM library_index_metadata')
          .get()?.count
        if (typeof existingIndexCount !== 'number' || existingIndexCount !== 0) {
          throw new Error(
            'SQLite library data exists without a completed JSON migration marker; refusing to overwrite it.'
          )
        }

        if (legacyIndex) replaceIndex(database, legacyIndex)
        if (legacyBackup) {
          this.writeLegacyJsonBackup(
            database,
            legacyBackup,
            legacyBackupDate ?? new Date().toISOString()
          )
        }
        database
          .prepare(
            'INSERT INTO storage_migrations (migration_id, completed_at) VALUES (?, ?)'
          )
          .run(LIBRARY_JSON_MIGRATION, new Date().toISOString())
      })
    } finally {
      clearLibraryIndexCache()
    }
  }

  private writeLegacyJsonBackup(
    database: DatabaseSync,
    index: LibraryIndex,
    savedAt = new Date().toISOString()
  ): void {
    const payload = JSON.stringify(index)
    if (payload === undefined) {
      throw new Error('The library index backup could not be serialized.')
    }
    database
      .prepare(
        `INSERT INTO library_index_backup (id, payload_json, saved_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           saved_at = excluded.saved_at`
      )
      .run(payload, savedAt)
  }

  private async writeBackupSnapshot(database: DatabaseSync): Promise<void> {
    const dataDirectory = this.dataDirectory()
    const backupPath = join(dataDirectory, 'library-index.backup.sqlite')
    const temporaryPath = `${backupPath}.tmp`
    await rm(temporaryPath, { force: true })
    const quotedPath = temporaryPath.replace(/'/g, "''")
    database.exec(`VACUUM INTO '${quotedPath}'`)
    await rm(backupPath, { force: true })
    await rename(temporaryPath, backupPath)
    this.updateBackupDate(database)
  }

  private updateBackupDate(database: DatabaseSync): void {
    database
      .prepare(
        `INSERT INTO library_index_backup (id, payload_json, saved_at)
         VALUES (1, '', ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = '',
           saved_at = excluded.saved_at`
      )
      .run(new Date().toISOString())
  }
}
