import type {
  ChapterLink,
  DiscoveryQueueItem,
  LibraryFileRecord,
  QueueChapter
} from './contracts'

export interface ArchiveRecommendation {
  chapters: QueueChapter[]
  latestCoveredChapter: number | null
  gapCount: number
  overlapAllowed: boolean
  summary: string
}

const VERIFIED_COVERAGE = new Set(['extracted-toc', 'extracted-text', 'user-corrected'])

function normalizedTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function chapterNumber(chapter: ChapterLink): number | null {
  const titleMatch = chapter.title.match(/\b(?:chapter|ch\.?|episode|part)\s*[-:#]?\s*(\d+(?:\.\d+)?)/i)
    ?? chapter.title.match(/^\s*#?\s*(\d+(?:\.\d+)?)(?=\s|$|[:.-])/)
  if (titleMatch) return Number(titleMatch[1])
  if (/\bprologue\b/i.test(chapter.title)) return 0

  let path = chapter.url
  try {
    path = decodeURIComponent(new URL(chapter.url).pathname)
  } catch {
    path = chapter.url
  }
  const urlMatch = path.match(/(?:chapter|ch|episode|part)[-_/ ]*(\d+(?:\.\d+)?)/i)
  return urlMatch ? Number(urlMatch[1]) : null
}

function fileMatchesChapter(file: LibraryFileRecord, number: number | null, title: string): boolean {
  const titleKey = normalizedTitle(title)
  const titleMatch = titleKey.length > 0 && file.chapterTitles.some((candidate) => normalizedTitle(candidate) === titleKey)
  if (titleMatch) return true
  if (number === null) return false
  return file.chapterNumbers.includes(number)
}

export function recommendArchiveCoverage(
  item: Pick<DiscoveryQueueItem, 'title' | 'trackerRow' | 'chapters'>,
  files: LibraryFileRecord[],
  includeOverlap = false,
  overlapCount = 10
): ArchiveRecommendation {
  const titleKeys = new Set(
    [item.title, item.trackerRow?.title ?? '']
      .map(normalizedTitle)
      .filter((title) => title.length > 0)
  )
  const novelFiles = files.filter((file) => titleKeys.has(normalizedTitle(file.novelTitle)))
  const chapters = item.chapters.map((chapter) => {
    const number = chapterNumber(chapter)
    const matches = novelFiles.filter((file) => fileMatchesChapter(file, number, chapter.title))
    const verified = matches.filter((file) => VERIFIED_COVERAGE.has(file.coverageConfidence))
    const rangeMatches = (file: LibraryFileRecord): boolean =>
      number !== null &&
      file.filenameRange !== null &&
      number >= file.filenameRange.start &&
      number <= file.filenameRange.end
    const probable = novelFiles.filter(
      (file) =>
        (matches.includes(file) && file.coverageConfidence === 'filename') ||
        (rangeMatches(file) && file.coverageConfidence !== 'unknown')
    )
    const uncertain = novelFiles.some(
      (file) =>
        file.coverageConfidence === 'unknown' &&
        (matches.includes(file) || rangeMatches(file))
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
      recommended: archiveStatus !== 'confirmed',
      deliberateOverlap: false
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
  const overlapAllowed =
    latestConfirmedIndex >= 0 &&
    chapters.slice(0, latestConfirmedIndex + 1).every((chapter) => chapter.archiveStatus === 'confirmed')

  if (includeOverlap && overlapAllowed && overlapCount > 0) {
    const count = Math.min(Math.floor(overlapCount), latestConfirmedIndex + 1)
    for (let index = latestConfirmedIndex - count + 1; index <= latestConfirmedIndex; index += 1) {
      chapters[index].deliberateOverlap = true
    }
  }

  const suggestedCount = chapters.filter((chapter) => chapter.recommended || chapter.deliberateOverlap).length
  const uncertainCount = chapters.filter((chapter) =>
    chapter.archiveStatus === 'probable' || chapter.archiveStatus === 'uncertain'
  ).length
  let summary: string
  if (novelFiles.length === 0) {
    summary = 'No matching library files were found; all discovered chapters are suggested.'
  } else if (latestConfirmedIndex < 0) {
    summary = `No discovered chapters have confirmed coverage. ${uncertainCount} match(es) are uncertain or filename-only; review before excluding any.`
  } else if (gapCount > 0) {
    summary = `Confirmed coverage reaches ${latestCoveredChapter ?? 'an irregular chapter'}, but ${gapCount} earlier discovered chapter(s) are not confirmed. Overlap is disabled until those gaps are reviewed.`
  } else {
    summary = `Confirmed coverage reaches ${latestCoveredChapter ?? 'the latest matched chapter'} in source order; ${suggestedCount} chapter(s) suggested.`
  }

  return { chapters, latestCoveredChapter, gapCount, overlapAllowed, summary }
}
