import type {
  LibraryFileRecord,
  LibraryIndex,
  LibraryFolderState,
  LibraryIndexSummary,
  LibraryNovelSummary
} from './contracts'
import { analyzeLibraryCoverage } from './libraryCoverage'

const folderStates: LibraryFolderState[] = ['Completed', 'Downloaded', 'Sent', 'Old', 'Old Completed']

export function summarizeLibraryIndex(index: LibraryIndex): LibraryIndexSummary {
  const groups = new Map<string, LibraryFileRecord[]>()
  for (const file of index.files) {
    const key = file.novelTitle.trim().toLocaleLowerCase()
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
        overlapNumberCount: coverage.overlapNumberCount,
        unverifiedCount: coverage.unverifiedCount,
        rangeMismatchCount: coverage.rangeMismatchCount
      }
    }
  })

  novels.sort((left, right) => left.title.localeCompare(right.title))
  return {
    libraryRoot: index.libraryRoot,
    scannedAt: index.scannedAt,
    fileCount: index.files.length,
    scanErrors: index.scanErrors,
    scanSummary: index.scanSummary,
    novels
  }
}
