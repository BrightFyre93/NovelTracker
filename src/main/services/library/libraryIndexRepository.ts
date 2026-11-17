import type {
  LibraryFileCorrection,
  LibraryFileRecord,
  LibraryFileSearchPage,
  LibraryIndex,
  LibraryIndexOverview,
  LibraryNovelSearchPage
} from '../../../shared/contracts'
import type { ArchiveRecommendationTarget } from '../../../shared/archiveRecommendation'
import {
  getArchiveRecommendationTitleKeys,
  normalizeNovelTitleAliases
} from '../../../shared/archiveRecommendation'
import {
  readLibraryIndex,
  readLibraryIndexBackup,
  readLibraryIndexBackupDate,
  writeLibraryCorrection,
  writeLibraryIndex
} from '../localStore'
import {
  searchLibraryFileSummaries,
  searchLibraryNovelSummaries,
  summarizeLibraryIndexOverview
} from '../../../shared/libraryIndexSummary'
import { normalizeNovelTitleForGrouping } from '../../../shared/novelTitle'

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
}

export function createJsonLibraryIndexRepository(
  dataDirectory: () => string
): LibraryIndexRepository {
  return {
    read: () => readLibraryIndex(dataDirectory()),
    readOverview: async () => {
      const index = await readLibraryIndex(dataDirectory())
      return index ? summarizeLibraryIndexOverview(index) : null
    },
    searchNovels: async (
      query,
      multipleFilesOnly,
      offset,
      limit,
      selectedNovelKey
    ) => {
      const index = await readLibraryIndex(dataDirectory())
      return index
        ? searchLibraryNovelSummaries(
            index,
            query,
            multipleFilesOnly,
            offset,
            limit,
            selectedNovelKey
          )
        : null
    },
    searchNovelFiles: async (novelKey, query, offset, limit) => {
      const index = await readLibraryIndex(dataDirectory())
      return index
        ? searchLibraryFileSummaries(index, novelKey, query, offset, limit)
        : null
    },
    readFilesByIds: async (fileIds) => {
      const index = await readLibraryIndex(dataDirectory())
      if (!index) return null
      const filesById = new Map(index.files.map((file) => [file.id, file]))
      return fileIds.flatMap((fileId) => {
        const file = filesById.get(fileId)
        return file ? [file] : []
      })
    },
    readNovelFiles: async (novelKey) => {
      const index = await readLibraryIndex(dataDirectory())
      return index
        ? index.files.filter(
            (file) =>
              normalizeNovelTitleForGrouping(file.novelTitle) === novelKey
          )
        : null
    },
    readRecommendationFiles: async (item) => {
      const index = await readLibraryIndex(dataDirectory())
      if (!index) return null
      const titleKeys = new Set(getArchiveRecommendationTitleKeys(item))
      return index.files.filter((file) =>
        normalizeNovelTitleAliases(file.novelTitle).some((title) =>
          titleKeys.has(title)
        )
      )
    },
    readBackup: () => readLibraryIndexBackup(dataDirectory()),
    readBackupDate: () => readLibraryIndexBackupDate(dataDirectory()),
    write: (index, previousIndex) =>
      writeLibraryIndex(dataDirectory(), index, previousIndex),
    writeCorrection: async (fileId, correction) => {
      const index = await writeLibraryCorrection(
        dataDirectory(),
        fileId,
        correction
      )
      const file = index.files.find((candidate) => candidate.id === fileId)
      if (!file) {
        throw new Error(
          'The corrected file could not be found in the library index.'
        )
      }
      return file
    }
  }
}
