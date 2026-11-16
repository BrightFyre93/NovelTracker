import type {
  LibraryFileRecord,
  LibraryIndex,
  LibraryIndexOverview,
  LibraryFolderState,
  LibraryIndexSummary,
  LibraryFileSearchPage,
  LibraryFileListItem,
  LibraryNovelSummary,
  LibraryNovelSearchPage
} from './contracts'
import { analyzeLibraryCoverage } from './libraryCoverage'
import { normalizeNovelTitleForGrouping } from './novelTitle'

const folderStates: LibraryFolderState[] = ['Completed', 'Downloaded', 'Sent', 'Old', 'Old Completed']
const summaryCache = new WeakMap<LibraryIndex, LibraryIndexSummary>()

export function summarizeLibraryIndex(index: LibraryIndex): LibraryIndexSummary {
  const cachedSummary = summaryCache.get(index)
  if (cachedSummary) return cachedSummary

  const groups = new Map<string, LibraryFileRecord[]>()
  for (const file of index.files) {
    const key = normalizeNovelTitleForGrouping(file.novelTitle)
    const group = groups.get(key) ?? []
    group.push(file)
    groups.set(key, group)
  }

  const novels: LibraryNovelSummary[] = [...groups].map(([key, files]) => {
    const firstFile = files[0]
    if (!firstFile) throw new Error('A library novel summary has no source files.')
    const stateCounts = Object.fromEntries(folderStates.map((state) => [
      state,
      files.filter((file) => file.folderState === state).length
    ])) as Record<LibraryFolderState, number>
    const coverage = analyzeLibraryCoverage(files.filter((file) => file.format === 'EPUB'))
    return {
      key,
      title: firstFile.novelTitle,
      files: files.map(({ id, filename }) => ({ id, filename })),
      stateCounts,
      coverage: {
        gapCount: coverage.gapCount,
        duplicateNumberCount: coverage.duplicateNumberCount,
        unverifiedCount: coverage.unverifiedCount,
        rangeMismatchCount: coverage.rangeMismatchCount
      }
    }
  })

  novels.sort((left, right) => left.title.localeCompare(right.title))
  const summary = {
    libraryRoot: index.libraryRoot,
    scannedAt: index.scannedAt,
    fileCount: index.files.length,
    scanErrors: index.scanErrors,
    scanSummary: index.scanSummary,
    novels
  }
  summaryCache.set(index, summary)
  return summary
}

export function summarizeLibraryIndexOverview(index: LibraryIndex): LibraryIndexOverview {
  return {
    libraryRoot: index.libraryRoot,
    scannedAt: index.scannedAt,
    fileCount: index.files.length,
    scanErrors: index.scanErrors,
    scanSummary: index.scanSummary
  }
}

export function searchLibraryNovelSummaries(
  index: LibraryIndex,
  query: string,
  multipleFilesOnly: boolean,
  offset: number,
  limit: number,
  selectedNovelKey?: string
): LibraryNovelSearchPage {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingNovels = summarizeLibraryIndex(index).novels.filter((novel) =>
    (!multipleFilesOnly || novel.files.length > 1) &&
    (
      !normalizedQuery ||
      novel.title.toLocaleLowerCase().includes(normalizedQuery) ||
      novel.files.some((file) =>
        file.filename.toLocaleLowerCase().includes(normalizedQuery)
      )
    )
  )
  return {
    total: matchingNovels.length,
    offset,
    items: matchingNovels.slice(offset, offset + limit),
    selectedNovel: selectedNovelKey
      ? matchingNovels.find((novel) => novel.key === selectedNovelKey) ?? null
      : null
  }
}

export function searchLibraryFileSummaries(
  index: LibraryIndex,
  novelKey: string,
  query: string,
  offset: number,
  limit: number
): LibraryFileSearchPage {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const group = summarizeLibraryIndex(index).novels.find(
    (novel) => novel.key === novelKey
  )
  const titleMatches = group?.title.toLocaleLowerCase().includes(normalizedQuery) ?? false
  const matchingFiles = index.files
    .filter((file) =>
      normalizeNovelTitleForGrouping(file.novelTitle) === novelKey &&
      (
        !normalizedQuery ||
        titleMatches ||
        `${file.filename} ${file.relativePath}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      )
    )
  const items: LibraryFileListItem[] = matchingFiles
    .slice(offset, offset + limit)
    .map((file) => {
      const firstChapter = file.chapterNumbers[0]
      const lastChapter = file.chapterNumbers[file.chapterNumbers.length - 1]
      const coverage = file.chapterNumbers.length > 0
        ? firstChapter === lastChapter
          ? `${firstChapter}`
          : `${firstChapter}-${lastChapter} (${file.chapterNumbers.length} found)`
        : file.filenameRange
          ? `${file.filenameRange.start}-${file.filenameRange.end} (filename only)`
          : 'Unknown'
      return {
        id: file.id,
        filename: file.filename,
        folderState: file.folderState,
        format: file.format,
        coverage
      }
    })
  return {
    total: matchingFiles.length,
    offset,
    items
  }
}

export function invalidateLibraryIndexSummary(index: LibraryIndex): void {
  summaryCache.delete(index)
}
