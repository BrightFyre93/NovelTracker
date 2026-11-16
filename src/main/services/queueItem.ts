import { randomUUID } from 'node:crypto'
import type {
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary
} from '../../shared/contracts'

export type NewQueueItem = Pick<
  DiscoveryQueueItem,
  'title' | 'author' | 'sourceUrl' | 'origin'
> &
  Partial<Omit<DiscoveryQueueItem, 'title' | 'author' | 'sourceUrl' | 'origin'>>

export function createQueueItem(input: NewQueueItem): DiscoveryQueueItem {
  const chapterSummary = input.chapterSummary

  return {
    id: input.id ?? randomUUID(),
    sequence: input.sequence ?? 0,
    title: input.title,
    author: input.author,
    description: input.description ?? '',
    coverUrl: input.coverUrl ?? '',
    alternativeNames: input.alternativeNames ?? [],
    genres: input.genres ?? [],
    source: input.source ?? '',
    novelStatus: input.novelStatus ?? '',
    sourceUrl: input.sourceUrl,
    origin: input.origin,
    separateJob: input.separateJob ?? false,
    trackerRow: input.trackerRow ?? null,
    status: input.status ?? 'needs-review',
    parserName: input.parserName ?? '',
    ...(input.siteExtractionMode === undefined
      ? {}
      : { siteExtractionMode: input.siteExtractionMode }),
    chapters: input.chapters ?? [],
    chapterSummary: {
      total: chapterSummary?.total ?? 0,
      selected: chapterSummary?.selected ?? 0,
      recommended: chapterSummary?.recommended ?? 0,
      hasUncertainArchiveChapters:
        chapterSummary?.hasUncertainArchiveChapters ?? false,
      latestTitle: chapterSummary?.latestTitle ?? ''
    },
    targetOutputPath: input.targetOutputPath ?? '',
    discoveryChanges: input.discoveryChanges ?? '',
    recommendationSummary: input.recommendationSummary ?? '',
    repackageOnly: input.repackageOnly ?? false,
    ...(input.saveAvailableChaptersOnly === undefined
      ? {}
      : { saveAvailableChaptersOnly: input.saveAvailableChaptersOnly }),
    downloadOptions: input.downloadOptions ?? null,
    downloadStartedAt: input.downloadStartedAt ?? '',
    queuedAt: input.queuedAt ?? '',
    completedChapterUrls: input.completedChapterUrls ?? [],
    failedChapters: input.failedChapters ?? [],
    outputPath: input.outputPath ?? '',
    downloadHistoryId: input.downloadHistoryId ?? '',
    progress: input.progress ?? null,
    error: input.error ?? '',
    ...(input.recoveryReason === undefined
      ? {}
      : { recoveryReason: input.recoveryReason }),
    discoveredAt: input.discoveredAt ?? '',
    updatedAt: input.updatedAt ?? new Date().toISOString()
  }
}

type QueueItemWithoutChapterData = Omit<
  DiscoveryQueueItem,
  'chapters' | 'completedChapterUrls'
>

function copyQueueItemFields(
  item: DiscoveryQueueItem,
  failedChapterLimit = Number.POSITIVE_INFINITY
): QueueItemWithoutChapterData {
  const {
    chapters: _chapters,
    completedChapterUrls: _completedChapterUrls,
    ...fields
  } = item
  return {
    ...fields,
    trackerRow: item.trackerRow ? { ...item.trackerRow } : null,
    alternativeNames: [...(item.alternativeNames ?? [])],
    genres: [...(item.genres ?? [])],
    downloadOptions: item.downloadOptions
      ? {
          ...item.downloadOptions,
          alternativeNames: [...(item.downloadOptions.alternativeNames ?? [])],
          genres: [...(item.downloadOptions.genres ?? [])]
        }
      : null,
    failedChapters: item.failedChapters
      .slice(0, failedChapterLimit)
      .map((chapter) => ({ ...chapter })),
    progress: item.progress ? { ...item.progress } : null,
    chapterSummary: { ...item.chapterSummary }
  }
}

export function copyQueueItem(item: DiscoveryQueueItem): DiscoveryQueueItem {
  return {
    ...copyQueueItemFields(item),
    completedChapterUrls: [...item.completedChapterUrls],
    chapters: item.chapters.map((chapter) => ({ ...chapter }))
  }
}

export function copyQueueItemSummary(
  item: DiscoveryQueueItem
): DiscoveryQueueItemSummary {
  return {
    ...copyQueueItemFields(item, 20),
    failedChapterCount: item.failedChapters.length
  }
}

export function updateQueueChapterSummary(item: DiscoveryQueueItem): void {
  item.chapterSummary = {
    total: item.chapters.length,
    selected: item.chapters.filter((chapter) => chapter.selected).length,
    recommended: item.chapters.filter((chapter) => chapter.recommended).length,
    hasUncertainArchiveChapters: item.chapters.some(
      (chapter) =>
        chapter.archiveStatus === 'uncertain' ||
        chapter.archiveStatus === 'probable'
    ),
    latestTitle: item.chapters[item.chapters.length - 1]?.title ?? ''
  }
}

export function copyQueueItemForPersistence(
  item: DiscoveryQueueItem
): DiscoveryQueueItem {
  return {
    ...copyQueueItemFields(item),
    completedChapterUrls: [],
    chapters: []
  }
}
