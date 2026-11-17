import type {
  LibraryFileCorrection,
  LibraryFileRecord,
  LibraryFileSearchPage,
  LibraryIndex,
  LibraryIndexOverview,
  LibraryNovelSearchPage
} from '../../../shared/contracts'
import type { ArchiveRecommendationTarget } from '../../../shared/archiveRecommendation'

export interface LibraryIndexRepository {
  read(): Promise<LibraryIndex | null>
  readOverview(): Promise<LibraryIndexOverview | null>
  searchNovels(
    query: string,
    multipleFilesOnly: boolean,
    offset: number,
    limit: number,
    selectedNovelKey?: string
  ): Promise<LibraryNovelSearchPage | null>
  searchNovelFiles(
    novelKey: string,
    query: string,
    offset: number,
    limit: number
  ): Promise<LibraryFileSearchPage | null>
  readFilesByIds(fileIds: string[]): Promise<LibraryFileRecord[] | null>
  readNovelFiles(novelKey: string): Promise<LibraryFileRecord[] | null>
  readRecommendationFiles(
    item: ArchiveRecommendationTarget
  ): Promise<LibraryFileRecord[] | null>
  readBackup(): Promise<LibraryIndex | null>
  readBackupDate(): Promise<string | null>
  write(
    index: LibraryIndex,
    previousIndex?: LibraryIndex | null
  ): Promise<void>
  writeCorrection(
    fileId: string,
    correction: LibraryFileCorrection
  ): Promise<LibraryFileRecord>
  upsertFile(file: LibraryFileRecord, libraryRoot: string): Promise<void>
}

export function applyLibraryFileCorrection(
  file: LibraryFileRecord,
  correction: LibraryFileCorrection | undefined
): LibraryFileRecord {
  if (!correction) return file
  return {
    ...file,
    ...(correction.novelTitle ? { novelTitle: correction.novelTitle } : {}),
    ...(correction.chapterNumbers
      ? {
          chapterNumbers: [...correction.chapterNumbers].sort(
            (left, right) => left - right
          ),
          coverageConfidence: 'user-corrected' as const
        }
      : {})
  }
}
