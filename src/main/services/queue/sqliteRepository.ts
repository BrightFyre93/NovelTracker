import { join } from 'node:path'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type {
  DiscoveryQueueItem,
  QueueChapter
} from '../../../shared/contracts'
import { backupLegacyJsonFile } from '../../infra/jsonMigrationBackup'
import {
  discoveryQueueChaptersPath,
  discoveryQueueSelectionPath,
  isDiscoveryQueueArray,
  readDiscoveryQueue,
  readDiscoveryQueueItemChapters
} from '../localStore'
import {
  withSqliteTransaction,
  withSqliteTransactionAsync
} from '../../infra/sqliteDatabase'
import type { SqliteDatabase } from '../../infra/sqliteDatabase'
import type {
  QueueChapterDownloadState,
  QueueChapterStateRepository,
  QueueRepository
} from './repository'

const QUEUE_JSON_MIGRATION = 'queue-json-v1'
type LegacyQueueItem = DiscoveryQueueItem & {
  completedChapterUrls?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutLegacyCompletedChapterUrls(
  item: DiscoveryQueueItem
): DiscoveryQueueItem {
  const {
    completedChapterUrls: _completedChapterUrls,
    ...currentItem
  } = item as LegacyQueueItem
  return currentItem
}

function parseStoredQueueItem(
  itemId: SQLOutputValue | undefined,
  sequence: SQLOutputValue | undefined,
  status: SQLOutputValue | undefined,
  itemJson: SQLOutputValue | undefined
): DiscoveryQueueItem {
  if (
    typeof itemId !== 'string' ||
    typeof sequence !== 'number' ||
    typeof status !== 'string' ||
    typeof itemJson !== 'string'
  ) {
    throw new Error('A saved SQLite queue item has invalid column data.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(itemJson)
  } catch (error) {
    throw new Error(`The saved SQLite queue item ${itemId} is malformed.`, {
      cause: error
    })
  }
  const items: unknown[] = [parsed]
  if (
    !isDiscoveryQueueArray(items) ||
    items[0].id !== itemId ||
    items[0].sequence !== sequence ||
    items[0].status !== status
  ) {
    throw new Error(`The saved SQLite queue item ${itemId} is invalid.`)
  }
  return withoutLegacyCompletedChapterUrls(items[0])
}

function serializeQueueItem(
  item: DiscoveryQueueItem,
  sequence: number,
  status: string
): string {
  const serialized = JSON.stringify({
    ...item,
    sequence,
    status,
    chapters: []
  })
  if (serialized === undefined) {
    throw new Error(`Queue item ${item.id} could not be serialized.`)
  }
  return serialized
}

function writeQueueItem(
  statement: ReturnType<DatabaseSync['prepare']>,
  item: DiscoveryQueueItem,
  ordinal: number
): void {
  const sequence =
    Number.isSafeInteger(item.sequence) && item.sequence > 0
      ? item.sequence
      : ordinal + 1
  const status = typeof item.status === 'string' ? item.status : 'needs-review'
  statement.run(
    item.id,
    ordinal,
    sequence,
    status,
    serializeQueueItem(item, sequence, status)
  )
}

function writeChapterSet(
  database: DatabaseSync,
  itemId: string,
  chapters: QueueChapter[]
): void {
  const savedAt = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO queue_chapter_sets (item_id, chapter_count)
       VALUES (?, ?)
       ON CONFLICT(item_id) DO UPDATE SET chapter_count = excluded.chapter_count`
    )
    .run(itemId, chapters.length)
  database.prepare('DELETE FROM queue_chapters WHERE item_id = ?').run(itemId)
  database.prepare('DELETE FROM queue_selections WHERE item_id = ?').run(itemId)

  const insertChapter = database.prepare(
    `INSERT INTO queue_chapters (item_id, ordinal, chapter_id, chapter_json)
     VALUES (?, ?, ?, ?)`
  )
  const insertSelection = database.prepare(
    'INSERT OR IGNORE INTO queue_selections (item_id, chapter_id) VALUES (?, ?)'
  )
  const insertState = database.prepare(
    `INSERT OR IGNORE INTO queue_chapter_download_states (
       item_id, chapter_id, original_url, current_url, title, source_order,
       state, attempt_count, created_at, updated_at, last_http_status,
       last_error, artifact_ref
     ) VALUES (?, ?, ?, ?, ?, ?, 'Pending', 0, ?, ?, NULL, NULL, NULL)`
  )
  const updateStateMetadata = database.prepare(
    `UPDATE queue_chapter_download_states
     SET current_url = ?, title = ?, source_order = ?, updated_at = ?,
         state = CASE
           WHEN current_url != ? AND state = 'Downloaded'
             THEN 'InvalidArtifact'
           ELSE state
         END,
         last_error = CASE
           WHEN current_url != ? AND state = 'Downloaded'
             THEN 'The saved chapter URL changed; the artifact must be fetched again.'
           ELSE last_error
         END,
         artifact_ref = CASE
           WHEN current_url != ? AND state = 'Downloaded' THEN NULL
           ELSE artifact_ref
         END
     WHERE item_id = ? AND chapter_id = ?`
  )
  chapters.forEach((chapter, ordinal) => {
    const { selected, ...chapterData } = chapter
    insertChapter.run(itemId, ordinal, chapter.id, JSON.stringify(chapterData))
    if (selected) insertSelection.run(itemId, chapter.id)
    insertState.run(
      itemId,
      chapter.id,
      chapter.url,
      chapter.url,
      chapter.title,
      ordinal,
      savedAt,
      savedAt
    )
    updateStateMetadata.run(
      chapter.url,
      chapter.title,
      ordinal,
      savedAt,
      chapter.url,
      chapter.url,
      chapter.url,
      itemId,
      chapter.id
    )
  })
  database
    .prepare(
      `UPDATE queue_chapter_download_states
       SET state = 'Skipped', updated_at = ?
       WHERE item_id = ? AND chapter_id NOT IN (
         SELECT chapter_id FROM queue_selections WHERE item_id = ?
       ) AND state IN (
         'Pending', 'Downloaded', 'Retrying', 'Failed', 'InvalidArtifact'
       )`
    )
    .run(savedAt, itemId, itemId)
  database
    .prepare(
      `UPDATE queue_chapter_download_states
       SET state = 'Pending', updated_at = ?
       WHERE item_id = ? AND chapter_id IN (
         SELECT chapter_id FROM queue_selections WHERE item_id = ?
       ) AND state = 'Skipped'`
    )
    .run(savedAt, itemId, itemId)
  if (chapters.length === 0) {
    database
      .prepare('DELETE FROM queue_chapter_download_states WHERE item_id = ?')
      .run(itemId)
  } else {
    const placeholders = chapters.map(() => '?').join(', ')
    database
      .prepare(
        `DELETE FROM queue_chapter_download_states
         WHERE item_id = ? AND chapter_id NOT IN (${placeholders})`
      )
      .run(itemId, ...chapters.map((chapter) => chapter.id))
  }
}

async function readLegacyQueue(
  dataDirectory: string
): Promise<DiscoveryQueueItem[]> {
  const queuePath = join(dataDirectory, 'discovery-queue.json')
  await backupLegacyJsonFile(queuePath, `${queuePath}.pre-sqlite.bak`)
  const items = await readDiscoveryQueue(dataDirectory)
  for (const item of items) {
    const backupDirectory = join(
      dataDirectory,
      'pre-sqlite-backup',
      'download-artifacts',
      item.id
    )
    await backupLegacyJsonFile(
      discoveryQueueChaptersPath(dataDirectory, item.id),
      join(backupDirectory, 'queue-chapters.json.pre-sqlite.bak')
    )
    await backupLegacyJsonFile(
      discoveryQueueSelectionPath(dataDirectory, item.id),
      join(backupDirectory, 'queue-selection.json.pre-sqlite.bak')
    )
  }
  return items.map(withoutLegacyCompletedChapterUrls)
}

class SqliteQueueRepository
  implements QueueRepository, QueueChapterStateRepository
{
  private initialization: Promise<void> | null = null

  constructor(
    private readonly database: SqliteDatabase,
    private readonly dataDirectory: () => string
  ) {}

  async readQueue(): Promise<DiscoveryQueueItem[]> {
    await this.ensureInitialized()
    const database = await this.database.open()
    return database
      .prepare(
        'SELECT id, sequence, status, item_json FROM queue_items ORDER BY ordinal'
      )
      .all()
      .map((row) =>
        parseStoredQueueItem(row.id, row.sequence, row.status, row.item_json)
      )
  }

  async writeQueue(items: DiscoveryQueueItem[]): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      throw new Error('The saved queue contains duplicate item identifiers.')
    }
    const upsert = database.prepare(
      `INSERT INTO queue_items (id, ordinal, sequence, status, item_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ordinal = excluded.ordinal,
         sequence = excluded.sequence,
         status = excluded.status,
         item_json = excluded.item_json`
    )
    withSqliteTransaction(database, () => {
      items.forEach((item, ordinal) => writeQueueItem(upsert, item, ordinal))
      if (items.length === 0) {
        database.exec('DELETE FROM queue_items')
      } else {
        const placeholders = items.map(() => '?').join(', ')
        database
          .prepare(`DELETE FROM queue_items WHERE id NOT IN (${placeholders})`)
          .run(...items.map((item) => item.id))
      }
    })
  }

  async readChapters(queueItemId: string): Promise<QueueChapter[] | null> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const chapterSet = database
      .prepare(
        'SELECT chapter_count FROM queue_chapter_sets WHERE item_id = ?'
      )
      .get(queueItemId)
    if (!chapterSet) return null
    if (
      typeof chapterSet.chapter_count !== 'number' ||
      !Number.isSafeInteger(chapterSet.chapter_count)
    ) {
      throw new Error(
        `Saved chapter metadata is invalid for queue item ${queueItemId}.`
      )
    }

    const rows = database
      .prepare(
        `SELECT chapter_id, chapter_json FROM queue_chapters
         WHERE item_id = ? ORDER BY ordinal`
      )
      .all(queueItemId)
    if (rows.length !== chapterSet.chapter_count) {
      throw new Error(
        `Saved chapter metadata is incomplete for queue item ${queueItemId}.`
      )
    }
    const selectedRows = database
      .prepare('SELECT chapter_id FROM queue_selections WHERE item_id = ?')
      .all(queueItemId)
    const selectedIds = new Set<string>()
    for (const row of selectedRows) {
      if (typeof row.chapter_id !== 'string') {
        throw new Error(
          `Saved chapter selection is invalid for queue item ${queueItemId}.`
        )
      }
      selectedIds.add(row.chapter_id)
    }
    return rows.map((row) => {
      if (
        typeof row.chapter_id !== 'string' ||
        typeof row.chapter_json !== 'string'
      ) {
        throw new Error(
          `Saved chapter metadata is invalid for queue item ${queueItemId}.`
        )
      }
      const chapter: unknown = JSON.parse(row.chapter_json)
      if (!isRecord(chapter) || chapter.id !== row.chapter_id) {
        throw new Error(
          `Saved chapter metadata is invalid for queue item ${queueItemId}.`
        )
      }
      return {
        ...chapter,
        selected: selectedIds.has(row.chapter_id)
      } as QueueChapter
    })
  }

  async writeChapters(
    queueItemId: string,
    chapters: QueueChapter[]
  ): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    withSqliteTransaction(database, () => {
      writeChapterSet(database, queueItemId, chapters)
    })
  }

  async writeSelection(
    queueItemId: string,
    selectedChapterIds: string[]
  ): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    withSqliteTransaction(database, () => {
      const savedAt = new Date().toISOString()
      database
        .prepare('DELETE FROM queue_selections WHERE item_id = ?')
        .run(queueItemId)
      const insert = database.prepare(
        'INSERT OR IGNORE INTO queue_selections (item_id, chapter_id) VALUES (?, ?)'
      )
      for (const chapterId of new Set(selectedChapterIds)) {
        insert.run(queueItemId, chapterId)
      }
      database
        .prepare(
          `UPDATE queue_chapter_download_states
           SET state = 'Skipped', updated_at = ?
           WHERE item_id = ? AND chapter_id NOT IN (
             SELECT chapter_id FROM queue_selections WHERE item_id = ?
           ) AND state IN (
             'Pending', 'Downloaded', 'Retrying', 'Failed', 'InvalidArtifact'
           )`
        )
        .run(savedAt, queueItemId, queueItemId)
      database
        .prepare(
          `UPDATE queue_chapter_download_states
           SET state = 'Pending', updated_at = ?
           WHERE item_id = ? AND chapter_id IN (
             SELECT chapter_id FROM queue_selections WHERE item_id = ?
           ) AND state = 'Skipped'`
        )
        .run(savedAt, queueItemId, queueItemId)
    })
  }

  async readChapterStates(
    queueItemId: string
  ): Promise<QueueChapterDownloadState[]> {
    await this.ensureInitialized()
    const database = await this.database.open()
    return database
      .prepare(
        `SELECT chapter_id, original_url, current_url, title, source_order,
                state, attempt_count, created_at, updated_at,
                last_http_status, last_error, artifact_ref
         FROM queue_chapter_download_states
         WHERE item_id = ? ORDER BY source_order`
      )
      .all(queueItemId)
      .map((row) => {
        if (
          typeof row.chapter_id !== 'string' ||
          typeof row.original_url !== 'string' ||
          typeof row.current_url !== 'string' ||
          typeof row.title !== 'string' ||
          typeof row.source_order !== 'number' ||
          !Number.isSafeInteger(row.source_order) ||
          typeof row.state !== 'string' ||
          typeof row.attempt_count !== 'number' ||
          !Number.isSafeInteger(row.attempt_count) ||
          typeof row.created_at !== 'string' ||
          typeof row.updated_at !== 'string' ||
          (row.last_http_status !== null &&
            (typeof row.last_http_status !== 'number' ||
              !Number.isSafeInteger(row.last_http_status))) ||
          (row.last_error !== null && typeof row.last_error !== 'string') ||
          (row.artifact_ref !== null &&
            typeof row.artifact_ref !== 'string') ||
          ![
            'Pending',
            'Downloading',
            'Downloaded',
            'Retrying',
            'Failed',
            'Skipped',
            'InvalidArtifact'
          ].includes(row.state)
        ) {
          throw new Error(
            `Saved chapter download state is invalid for queue item ${queueItemId}.`
          )
        }
        return {
          chapterId: row.chapter_id,
          originalUrl: row.original_url,
          currentUrl: row.current_url,
          title: row.title,
          sourceOrder: row.source_order,
          state: row.state as QueueChapterDownloadState['state'],
          attemptCount: row.attempt_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastHttpStatus:
            typeof row.last_http_status === 'number'
              ? row.last_http_status
              : null,
          lastError:
            typeof row.last_error === 'string' ? row.last_error : null,
          artifactRef:
            typeof row.artifact_ref === 'string' ? row.artifact_ref : null
        }
      })
  }

  async writeChapterStates(
    queueItemId: string,
    states: QueueChapterDownloadState[]
  ): Promise<void> {
    await this.ensureInitialized()
    const database = await this.database.open()
    const upsert = database.prepare(
      `INSERT INTO queue_chapter_download_states (
         item_id, chapter_id, original_url, current_url, title, source_order,
         state, attempt_count, created_at, updated_at, last_http_status,
         last_error, artifact_ref
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, chapter_id) DO UPDATE SET
         current_url = excluded.current_url,
         title = excluded.title,
         source_order = excluded.source_order,
         state = excluded.state,
         attempt_count = excluded.attempt_count,
         updated_at = excluded.updated_at,
         last_http_status = excluded.last_http_status,
         last_error = excluded.last_error,
         artifact_ref = excluded.artifact_ref`
    )
    withSqliteTransaction(database, () => {
      for (const state of states) {
        upsert.run(
          queueItemId,
          state.chapterId,
          state.originalUrl,
          state.currentUrl,
          state.title,
          state.sourceOrder,
          state.state,
          state.attemptCount,
          state.createdAt,
          state.updatedAt,
          state.lastHttpStatus,
          state.lastError,
          state.artifactRef
        )
      }
    })
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialization) this.initialization = this.initialize()
    return this.initialization
  }

  private async initialize(): Promise<void> {
    const database = await this.database.open()
    const marker = database
      .prepare(
        'SELECT migration_id FROM storage_migrations WHERE migration_id = ?'
      )
      .get(QUEUE_JSON_MIGRATION)
    if (marker) return

    const dataDirectory = this.dataDirectory()
    const legacyItems = await readLegacyQueue(dataDirectory)
    const itemCount = database
      .prepare('SELECT COUNT(*) AS item_count FROM queue_items')
      .get()?.item_count
    if (typeof itemCount !== 'number' || itemCount !== 0) {
      throw new Error(
        'SQLite queue data exists without a completed JSON migration marker; refusing to overwrite it.'
      )
    }

    const insert = database.prepare(
      `INSERT INTO queue_items (id, ordinal, sequence, status, item_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    await withSqliteTransactionAsync(database, async () => {
      for (const [ordinal, item] of legacyItems.entries()) {
        const savedChapters = await readDiscoveryQueueItemChapters(
          dataDirectory,
          item.id
        )
        const chapters =
          savedChapters ?? (item.chapters?.length ? item.chapters : null)
        writeQueueItem(insert, item, ordinal)
        if (chapters !== null) writeChapterSet(database, item.id, chapters)
        item.chapters = []
      }
      database
        .prepare(
          'INSERT INTO storage_migrations (migration_id, completed_at) VALUES (?, ?)'
        )
        .run(QUEUE_JSON_MIGRATION, new Date().toISOString())
    })
  }
}

export function createSqliteQueueRepository(
  database: SqliteDatabase,
  dataDirectory: () => string
): QueueRepository & QueueChapterStateRepository {
  return new SqliteQueueRepository(database, dataDirectory)
}
