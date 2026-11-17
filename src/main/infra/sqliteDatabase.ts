import { mkdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const DATABASE_FILENAME = 'novel-tracker.sqlite'
const SCHEMA_VERSION = 6

export class SqliteDatabase {
  private database: DatabaseSync | null = null
  private opening: Promise<DatabaseSync> | null = null

  constructor(private readonly dataDirectory: () => string) {}

  async open(): Promise<DatabaseSync> {
    if (this.database) return this.database
    if (!this.opening) this.opening = this.initialize()
    try {
      this.database = await this.opening
      return this.database
    } catch (error) {
      this.opening = null
      throw error
    }
  }

  close(): void {
    const database = this.database
    this.database = null
    this.opening = null
    database?.close()
  }

  private async initialize(): Promise<DatabaseSync> {
    const dataDirectory = this.dataDirectory()
    await mkdir(dataDirectory, { recursive: true })
    const database = new DatabaseSync(join(dataDirectory, DATABASE_FILENAME))

    try {
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
      const journalMode = database.prepare('PRAGMA journal_mode = WAL').get()
      if (journalMode?.journal_mode !== 'wal') {
        throw new Error('SQLite could not enable write-ahead logging.')
      }

      const versionRow = database.prepare('PRAGMA user_version').get()
      let version = versionRow?.user_version
      if (
        typeof version !== 'number' ||
        !Number.isSafeInteger(version) ||
        version < 0
      ) {
        throw new Error('The SQLite schema version is invalid.')
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `The SQLite database schema version ${version} is newer than this app supports.`
        )
      }
      if (version === 0) {
        withSqliteTransaction(database, () => {
          database.exec(`
            CREATE TABLE IF NOT EXISTS queue_items (
              id TEXT PRIMARY KEY NOT NULL,
              ordinal INTEGER NOT NULL,
              sequence INTEGER NOT NULL,
              status TEXT NOT NULL,
              item_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue_chapter_sets (
              item_id TEXT PRIMARY KEY NOT NULL
                REFERENCES queue_items(id) ON DELETE CASCADE,
              chapter_count INTEGER NOT NULL CHECK(chapter_count >= 0)
            );
            CREATE TABLE IF NOT EXISTS queue_chapters (
              item_id TEXT NOT NULL
                REFERENCES queue_items(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL,
              chapter_id TEXT NOT NULL,
              chapter_json TEXT NOT NULL,
              PRIMARY KEY(item_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS queue_chapters_by_id
              ON queue_chapters(item_id, chapter_id);
            CREATE TABLE IF NOT EXISTS queue_selections (
              item_id TEXT NOT NULL
                REFERENCES queue_items(id) ON DELETE CASCADE,
              chapter_id TEXT NOT NULL,
              PRIMARY KEY(item_id, chapter_id)
            );
            CREATE TABLE IF NOT EXISTS storage_migrations (
              migration_id TEXT PRIMARY KEY NOT NULL,
              completed_at TEXT NOT NULL
            );
          `)
          database.exec('PRAGMA user_version = 1')
        })
        version = 1
      }
      if (version === 1) {
        withSqliteTransaction(database, () => {
          database.exec(`
            CREATE TABLE IF NOT EXISTS library_index_metadata (
              id INTEGER PRIMARY KEY CHECK(id = 1),
              library_root TEXT NOT NULL,
              scanned_at TEXT NOT NULL,
              scan_errors INTEGER NOT NULL CHECK(scan_errors >= 0),
              reused_files INTEGER,
              inspected_files INTEGER
            );
            CREATE TABLE IF NOT EXISTS library_novels (
              id TEXT PRIMARY KEY NOT NULL,
              display_title TEXT NOT NULL,
              normalized_title TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS library_novel_aliases (
              novel_id TEXT NOT NULL
                REFERENCES library_novels(id) ON DELETE CASCADE,
              alias_key TEXT NOT NULL,
              PRIMARY KEY(novel_id, alias_key)
            );
            CREATE INDEX IF NOT EXISTS library_novel_aliases_by_key
              ON library_novel_aliases(alias_key);
            CREATE TABLE IF NOT EXISTS library_files (
              id TEXT PRIMARY KEY NOT NULL,
              path TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              filename TEXT NOT NULL,
              format TEXT NOT NULL CHECK(format IN ('EPUB', 'AZW3')),
              folder_state TEXT NOT NULL CHECK(
                folder_state IN ('Completed', 'Downloaded', 'Sent', 'Old', 'Old Completed')
              ),
              size INTEGER NOT NULL CHECK(size >= 0),
              modified_at TEXT NOT NULL,
              novel_id TEXT REFERENCES library_novels(id) ON DELETE SET NULL,
              author TEXT NOT NULL,
              language TEXT NOT NULL,
              filename_range_start REAL,
              filename_range_end REAL,
              coverage_confidence TEXT NOT NULL CHECK(
                coverage_confidence IN ('extracted-toc', 'filename', 'user-corrected', 'unknown')
              ),
              cover_path TEXT,
              inspection_error TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS library_files_by_novel
              ON library_files(novel_id, folder_state, format);
            CREATE INDEX IF NOT EXISTS library_files_by_path
              ON library_files(path);
            CREATE TABLE IF NOT EXISTS library_chapters (
              file_id TEXT NOT NULL
                REFERENCES library_files(id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
              chapter_number REAL,
              title_key TEXT,
              PRIMARY KEY(file_id, ordinal),
              CHECK(chapter_number IS NOT NULL OR title_key IS NOT NULL)
            );
            CREATE INDEX IF NOT EXISTS library_chapters_by_number
              ON library_chapters(file_id, chapter_number);
            CREATE INDEX IF NOT EXISTS library_chapters_by_title
              ON library_chapters(title_key);
            CREATE TABLE IF NOT EXISTS library_file_corrections (
              file_id TEXT PRIMARY KEY NOT NULL
                REFERENCES library_files(id) ON DELETE CASCADE,
              novel_title TEXT
            );
            CREATE TABLE IF NOT EXISTS library_correction_chapters (
              file_id TEXT NOT NULL
                REFERENCES library_file_corrections(file_id) ON DELETE CASCADE,
              ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
              chapter_number REAL NOT NULL,
              PRIMARY KEY(file_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS storage_migrations (
              migration_id TEXT PRIMARY KEY NOT NULL,
              completed_at TEXT NOT NULL
            );
          `)
          database.exec('PRAGMA user_version = 2')
        })
        version = 2
      }
      if (version === 2) {
        withSqliteTransaction(database, () => {
          database.exec(`
            ALTER TABLE library_files
              ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0 CHECK(ordinal >= 0);
            ALTER TABLE library_files
              ADD COLUMN novel_title TEXT NOT NULL DEFAULT '';
            UPDATE library_files
              SET ordinal = (
                SELECT COUNT(*) - 1
                FROM library_files AS earlier
                WHERE earlier.rowid <= library_files.rowid
              );
            UPDATE library_files
              SET novel_title = COALESCE(
                (SELECT display_title FROM library_novels
                 WHERE library_novels.id = library_files.novel_id),
                ''
              );
            CREATE TABLE IF NOT EXISTS library_index_backup (
              id INTEGER PRIMARY KEY CHECK(id = 1),
              payload_json TEXT NOT NULL,
              saved_at TEXT NOT NULL
            );
            PRAGMA user_version = 3;
          `)
        })
        version = 3
      }
      if (version === 3) {
        withSqliteTransaction(database, () => {
          database.exec(`
            CREATE TABLE IF NOT EXISTS queue_chapter_download_states (
              item_id TEXT NOT NULL
                REFERENCES queue_items(id) ON DELETE CASCADE,
              chapter_id TEXT NOT NULL,
              original_url TEXT NOT NULL,
              current_url TEXT NOT NULL,
              title TEXT NOT NULL,
              source_order INTEGER NOT NULL CHECK(source_order >= 0),
              state TEXT NOT NULL CHECK(state IN (
                'Pending', 'Downloading', 'Downloaded', 'Retrying',
                'Failed', 'Skipped', 'InvalidArtifact'
              )),
              attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_http_status INTEGER,
              last_error TEXT,
              artifact_ref TEXT,
              PRIMARY KEY(item_id, chapter_id)
            );
            CREATE INDEX IF NOT EXISTS queue_chapter_states_by_state
              ON queue_chapter_download_states(item_id, state);
            PRAGMA user_version = 4;
          `)
        })
        version = 4
      }
      if (version === 4) {
        withSqliteTransaction(database, () => {
          database.exec(`
            CREATE TABLE IF NOT EXISTS job_outputs (
              item_id TEXT NOT NULL
                REFERENCES queue_items(id) ON DELETE CASCADE,
              volume_index INTEGER NOT NULL CHECK(volume_index >= 1),
              filename TEXT NOT NULL,
              path TEXT NOT NULL,
              byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
              sha256 TEXT NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('published')),
              PRIMARY KEY(item_id, volume_index)
            );
            CREATE INDEX IF NOT EXISTS job_outputs_by_path ON job_outputs(path);
            PRAGMA user_version = 5;
          `)
        })
        version = 5
      }
      if (version === 5) {
        withSqliteTransaction(database, () => {
          database.exec(`
            ALTER TABLE library_files ADD COLUMN stable_book_id TEXT;
            ALTER TABLE library_files ADD COLUMN volume_index INTEGER
              CHECK(volume_index IS NULL OR volume_index >= 1);
            CREATE INDEX IF NOT EXISTS library_files_by_stable_book
              ON library_files(stable_book_id, volume_index);
            PRAGMA user_version = 6;
          `)
        })
        version = 6
      }
      if (version !== SCHEMA_VERSION) {
        throw new Error(`The SQLite schema could not be upgraded to version ${SCHEMA_VERSION}.`)
      }
      return database
    } catch (error) {
      database.close()
      throw error
    }
  }
}

export function withSqliteTransaction<T>(
  database: DatabaseSync,
  operation: () => T
): T {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      console.error('SQLite transaction rollback failed:', rollbackError)
    }
    throw error
  }
}

export async function withSqliteTransactionAsync<T>(
  database: DatabaseSync,
  operation: () => Promise<T>
): Promise<T> {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = await operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch (rollbackError) {
      console.error('SQLite transaction rollback failed:', rollbackError)
    }
    throw error
  }
}
