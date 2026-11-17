import type {
  DiscoveryQueueItem,
  LibraryFileRecord,
  QueueChapter
} from './contracts'
import { VERIFIED_COVERAGE } from './constants'
import { parseChapterNumber } from './chapterNumber'
import { normalizeNovelTitleForMatching } from './novelTitle'

export interface ArchiveRecommendation {
  chapters: QueueChapter[]
  latestCoveredChapter: number | null
  gapCount: number
  summary: string
}

export type ArchiveRecommendationTarget = Pick<
  DiscoveryQueueItem,
  'title' | 'alternativeNames' | 'trackerRow'
>

export function normalizeNovelTitleAliases(value: string): string[] {
  const normalized = normalizeNovelTitleForMatching(value)
  const withoutVolume = normalized.replace(/(?:vol(?:ume)?|book|part)(?:\d+|[ivxlcdm]+)$/, '')
  return [...new Set([normalized, withoutVolume].filter((title) => title.length > 0))]
}

export function getArchiveRecommendationTitleKeys(
  item: ArchiveRecommendationTarget
): string[] {
  const trackerAlternativeNames = item.trackerRow?.alternativeNames
    ?.split(/[,;|\r\n]+/)
    .map((name) => name.trim()) ?? []
  return [
    ...new Set(
      [
        item.title,
        ...item.alternativeNames,
        item.trackerRow?.title ?? '',
        ...trackerAlternativeNames
      ].flatMap(normalizeNovelTitleAliases)
    )
  ]
}

interface IndexedNovelFile {
  file: LibraryFileRecord
  chapterTitleKeys: Set<string>
  chapterNumbers: Set<number>
}

function fileMatchesChapter(
  file: IndexedNovelFile,
  number: number | null,
  titleKey: string
): boolean {
  const titleMatch = titleKey.length > 0 && file.chapterTitleKeys.has(titleKey)
  if (titleMatch) return true
  if (number === null) return false
  return file.chapterNumbers.has(number)
}

export function recommendArchiveCoverage(
  item: ArchiveRecommendationTarget & Pick<DiscoveryQueueItem, 'chapters'>,
  files: LibraryFileRecord[]
): ArchiveRecommendation {
  const titleKeys = new Set(getArchiveRecommendationTitleKeys(item))
  const novelFiles = files.filter((file) =>
    normalizeNovelTitleAliases(file.novelTitle).some((title) =>
      titleKeys.has(title)
    )
  )
  const indexedNovelFiles = novelFiles.map((file) => ({
    file,
    chapterTitleKeys: new Set(
      file.chapterTitleKeys ??
        file.chapterTitles.map(normalizeNovelTitleForMatching)
    ),
    chapterNumbers: new Set(file.chapterNumbers)
  }))
  const chapters = item.chapters.map((chapter) => {
    const number = parseChapterNumber(chapter.title) ?? parseChapterNumber(chapter.url, 'url')
    const titleKey = normalizeNovelTitleForMatching(chapter.title)
    const matches = indexedNovelFiles.filter((file) =>
      fileMatchesChapter(file, number, titleKey)
    )
    const matchingFiles = new Set(matches.map(({ file }) => file))
    const matchingLibraryFiles = matches.map(({ file }) => file)
    const verified = matchingLibraryFiles.filter((file) => VERIFIED_COVERAGE.has(file.coverageConfidence))
    const rangeMatches = (file: LibraryFileRecord): boolean =>
      number !== null &&
      file.filenameRange !== null &&
      number >= file.filenameRange.start &&
      number <= file.filenameRange.end
    const probable = indexedNovelFiles
      .filter(
        ({ file }) =>
          (matchingFiles.has(file) && file.coverageConfidence === 'filename') ||
          (rangeMatches(file) && file.coverageConfidence !== 'unknown')
      )
      .map(({ file }) => file)
    const uncertain = indexedNovelFiles.some(
      ({ file }) =>
        file.coverageConfidence === 'unknown' &&
        (matchingFiles.has(file) || rangeMatches(file))
    )
    const archiveStatus: QueueChapter['archiveStatus'] = verified.length > 0
      ? 'confirmed'
      : probable.length > 0
        ? 'probable'
        : uncertain
          ? 'uncertain'
          : 'missing'

    return {
      ...chapter,
      chapterNumber: number,
      archiveStatus,
      archiveSources: (verified.length > 0 ? verified : probable).map((file) => file.relativePath),
      archiveGap: false,
      recommended: archiveStatus !== 'confirmed'
    }
  })

  const latestConfirmedIndex = chapters.reduce(
    (latest, chapter, index) => chapter.archiveStatus === 'confirmed' ? index : latest,
    -1
  )
  const latestCoveredChapter = latestConfirmedIndex < 0
    ? null
    : chapters[latestConfirmedIndex].chapterNumber
  const gapCount = latestConfirmedIndex < 0
    ? 0
    : chapters.slice(0, latestConfirmedIndex).filter((chapter) => chapter.archiveStatus !== 'confirmed').length
  for (let index = 0; index < latestConfirmedIndex; index += 1) {
    chapters[index].archiveGap = chapters[index].archiveStatus !== 'confirmed'
  }
  const suggestedCount = chapters.filter((chapter) => chapter.recommended).length
  const uncertainCount = chapters.filter((chapter) =>
    chapter.archiveStatus === 'probable' || chapter.archiveStatus === 'uncertain'
  ).length
  let summary: string
  if (novelFiles.length === 0) {
    summary = 'No matching library files were found; all discovered chapters are suggested.'
  } else if (latestConfirmedIndex < 0) {
    summary = `No discovered chapters have confirmed coverage. ${uncertainCount} match(es) are uncertain or filename-only; review before excluding any.`
  } else if (gapCount > 0) {
    summary = `Confirmed coverage reaches ${latestCoveredChapter ?? 'an irregular chapter'}, but ${gapCount} earlier discovered chapter(s) are not confirmed. Resolve these gaps before relying on archive-based recommendations.`
  } else {
    summary = `Confirmed coverage reaches ${latestCoveredChapter ?? 'the latest matched chapter'} in source order; ${suggestedCount} chapter(s) suggested.`
  }

  return { chapters, latestCoveredChapter, gapCount, summary }
}
