import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  ChapterLink,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DownloadHistoryEntry
} from '../../../shared/contracts'
import { DEFAULT_EPUB_CSS } from '../../../shared/constants'
import { normalizeEpubOutputOptions } from '../../../shared/epubOutputOptions'
import {
  archiveDownloadJobs,
  readArchivedDownloadHistory
} from '../localStore'
import type {
  QueueMutationOptions,
  QueueStore,
  QueueSelectionPersistence
} from './store'
import {
  MAX_EPUB_FILENAME_BASENAME_LENGTH,
  sanitizeEpubFilename,
  suggestEpubFilename
} from '../../../shared/epubFilename'
import {
  copyQueueItemSummary,
  createQueueItem,
  updateQueueChapterSummary
} from '../queueItem'
import {
  projectDownloadHistory,
  projectDownloadJob
} from './jobHistory'
export { updateQueueChapterSummary } from '../queueItem'

interface QueueHelperDependencies {
  dataDirectory: () => string
  queueStore: QueueStore
  notifyDownloadHistoryChanged: (entries: DownloadHistoryEntry[]) => void
}

export interface QueueHelpers {
  copyDiscoveryQueue: () => DiscoveryQueueItemSummary[]
  markQueueItemChaptersDirty: (item: DiscoveryQueueItem) => void
  hasDirtyChapterData: (itemId: string) => boolean
  clearDirtyChapterData: (itemId: string) => void
  ensureQueueItemChapters: (item: DiscoveryQueueItem) => Promise<void>
  withChapters: <T>(
    item: DiscoveryQueueItem,
    operation: (item: DiscoveryQueueItem) => Promise<T> | T
  ) => Promise<T>
  releaseQueueItemChapters: (item: DiscoveryQueueItem) => void
  mutateItem: <T>(
    id: string,
    mutation: (draft: DiscoveryQueueItem) => Promise<T> | T,
    options?: QueueMutationOptions
  ) => Promise<T>
  persistDiscoveryQueue: (
    selectionUpdate?: QueueSelectionPersistence
  ) => Promise<void>
  persistDiscoveryQueueOrRollback: (rollback: () => void) => Promise<void>
  archiveRemovedJobs: (items: DiscoveryQueueItem[]) => Promise<void>
  drainWrites: () => Promise<void>
}

export function createQueueHelpers({
  dataDirectory,
  queueStore,
  notifyDownloadHistoryChanged,
}: QueueHelperDependencies): QueueHelpers {
  function copyDiscoveryQueue(): DiscoveryQueueItemSummary[] {
    return queueStore.items.map(copyQueueItemSummary)
  }

  const markQueueItemChaptersDirty = (item: DiscoveryQueueItem): void =>
    queueStore.markChaptersDirty(item)
  const hasDirtyChapterData = (itemId: string): boolean =>
    queueStore.hasDirtyChapters(itemId)
  const clearDirtyChapterData = (itemId: string): void =>
    queueStore.clearDirtyChapters(itemId)
  const ensureQueueItemChapters = (item: DiscoveryQueueItem): Promise<void> =>
    queueStore.ensureChapters(item)
  const withChapters = queueStore.withChapters.bind(queueStore)
  const releaseQueueItemChapters = (item: DiscoveryQueueItem): void =>
    queueStore.releaseChapters(item)
  async function publishHistory(): Promise<void> {
    try {
      const archived = await readArchivedDownloadHistory(dataDirectory())
      notifyDownloadHistoryChanged(
        projectDownloadHistory(queueStore.items, archived)
      )
    } catch (error) {
      console.error('Download job history could not be refreshed:', error)
    }
  }

  const mutateItem: QueueHelpers['mutateItem'] = async (...args) => {
    const result = await queueStore.mutateItem(...args)
    void publishHistory()
    return result
  }
  const persistDiscoveryQueue = async (
    selectionUpdate?: QueueSelectionPersistence
  ): Promise<void> => {
    await queueStore.persist(selectionUpdate)
    void publishHistory()
  }

  async function persistDiscoveryQueueOrRollback(
    rollback: () => void
  ): Promise<void> {
    try {
      await persistDiscoveryQueue()
    } catch (error) {
      rollback()
      throw error
    }
  }

  async function archiveRemovedJobs(items: DiscoveryQueueItem[]): Promise<void> {
    const entries = items.flatMap((item) => {
      const entry = projectDownloadJob(item)
      return entry ? [entry] : []
    })
    if (entries.length === 0) return
    const archived = await archiveDownloadJobs(dataDirectory(), entries)
    const removedIds = new Set(items.map((item) => item.id))
    notifyDownloadHistoryChanged(
      projectDownloadHistory(
        queueStore.items.filter((item) => !removedIds.has(item.id)),
        archived
      )
    )
  }

  async function drainWrites(): Promise<void> {
    await queueStore.drain()
  }

  return {
    copyDiscoveryQueue,
    markQueueItemChaptersDirty,
    hasDirtyChapterData,
    clearDirtyChapterData,
    ensureQueueItemChapters,
    withChapters,
    releaseQueueItemChapters,
    mutateItem,
    persistDiscoveryQueue,
    persistDiscoveryQueueOrRollback,
    archiveRemovedJobs,
    drainWrites
  }
}

export function discoverySnapshotIsStale(
  discoveredAt: string,
  freshnessHours: number
): boolean {
  const timestamp = Date.parse(discoveredAt)
  const now = Date.now()
  return (
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp >= freshnessHours * 60 * 60 * 1000
  )
}

export function discoveryQueueItemStatus(
  item: DiscoveryQueueItem
): DiscoveryQueueItem['status'] {
  return item.status
}

export function hydrateQueueItem(
  item: DiscoveryQueueItem
): DiscoveryQueueItem {
  const chapters = (item.chapters ?? []).map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    url: chapter.url,
    selected: chapter.selected,
    archiveStatus: chapter.archiveStatus ?? 'missing',
    archiveSources: chapter.archiveSources ?? [],
    chapterNumber: chapter.chapterNumber ?? null,
    archiveGap: chapter.archiveGap ?? false,
    recommended: chapter.recommended ?? true
  }))
  const hydrated = createQueueItem({
    ...item,
    chapters,
    chapterSummary: {
      total: item.chapterSummary?.total ?? 0,
      selected: item.chapterSummary?.selected ?? 0,
      recommended: item.chapterSummary?.recommended ?? 0,
      hasUncertainArchiveChapters:
        item.chapterSummary?.hasUncertainArchiveChapters ?? false,
      latestTitle: item.chapterSummary?.latestTitle ?? ''
    },
    downloadOptions: item.downloadOptions
      ? {
          ...item.downloadOptions,
          description: item.downloadOptions.description ?? '',
          coverUrl: item.downloadOptions.coverUrl ?? '',
          alternativeNames: item.downloadOptions.alternativeNames ?? [],
          genres: item.downloadOptions.genres ?? [],
          source: item.downloadOptions.source ?? '',
          novelStatus: item.downloadOptions.novelStatus ?? '',
          epubCss: item.downloadOptions.epubCss ?? DEFAULT_EPUB_CSS,
          outputOptions: normalizeEpubOutputOptions(
            item.downloadOptions.outputOptions,
            {
              css: item.downloadOptions.epubCss,
              language: item.downloadOptions.language
            }
          )
        }
      : null,
    updatedAt: item.updatedAt ?? ''
  })
  if (chapters.length > 0 || !item.chapterSummary)
    updateQueueChapterSummary(hydrated)
  return hydrated
}

export function expectedOutputPath(
  outputDirectory: string,
  title: string,
  filename: string,
  chapters: ChapterLink[]
): string {
  const requestedFilename =
    filename.trim() ||
    suggestEpubFilename(
      title,
      chapters[0]?.title ?? '',
      chapters[chapters.length - 1]?.title ?? ''
    )
  return resolve(
    outputDirectory,
    sanitizeEpubFilename(requestedFilename)
  ).toLowerCase()
}

export function findOutputConflict(
  queue: DiscoveryQueueItem[],
  outputPath: string,
  itemId: string
): DiscoveryQueueItem | undefined {
  return queue.find(
    (candidate) =>
      candidate.id !== itemId &&
      candidate.downloadOptions &&
      candidate.status !== 'completed' &&
      candidate.targetOutputPath === outputPath
  )
}

export function assertOutputPathAvailable(
  queue: DiscoveryQueueItem[],
  outputPath: string,
  itemId: string
): void {
  const conflict = findOutputConflict(queue, outputPath, itemId)
  if (conflict) {
    throw new Error(
      `Another saved EPUB job uses this output filename. Remove or complete "${conflict.title}" before reusing it.`
    )
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

export async function reserveIncompleteEpubFilename(
  item: DiscoveryQueueItem,
  chapters: ChapterLink[],
  queue: DiscoveryQueueItem[],
  reservedOutputPaths: Set<string>
): Promise<{ filename: string; outputPath: string; release: () => void }> {
  const options = item.downloadOptions
  if (!options) throw new Error('This item has no saved EPUB job to package.')
  const requestedFilename =
    options.filename.trim() ||
    suggestEpubFilename(
      options.title,
      chapters[0]?.title ?? '',
      chapters[chapters.length - 1]?.title ?? ''
    )
  const base = sanitizeEpubFilename(requestedFilename).replace(/\.epub$/i, '')

  for (let suffix = 1; suffix < 10000; suffix += 1) {
    const marker = suffix === 1 ? ' (incomplete)' : ` (incomplete ${suffix})`
    const stem = base
      .slice(0, MAX_EPUB_FILENAME_BASENAME_LENGTH - marker.length)
      .replace(/[. ]+$/g, '')
    const filename = sanitizeEpubFilename(`${stem}${marker}.epub`)
    const outputPath = resolve(options.outputDirectory, filename)
    const normalizedPath = outputPath.toLowerCase()
    if (
      reservedOutputPaths.has(normalizedPath) ||
      queue.some(
        (candidate) =>
          candidate.id !== item.id &&
          candidate.targetOutputPath === normalizedPath &&
          candidate.status !== 'completed'
      )
    ) {
      continue
    }

    try {
      await lstat(outputPath)
      continue
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    if (
      reservedOutputPaths.has(normalizedPath) ||
      queue.some(
        (candidate) =>
          candidate.id !== item.id &&
          candidate.targetOutputPath === normalizedPath &&
          candidate.status !== 'completed'
      )
    ) {
      continue
    }
    reservedOutputPaths.add(normalizedPath)
    return {
      filename,
      outputPath: normalizedPath,
      release: () => reservedOutputPaths.delete(normalizedPath)
    }
  }
  throw new Error(
    'A unique filename for the incomplete EPUB could not be reserved.'
  )
}
