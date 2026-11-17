import type {
  DiscoveryQueueItem,
  DownloadHistoryEntry
} from '../../../shared/contracts'

const historyStatusByQueueStatus: Record<
  DiscoveryQueueItem['status'],
  DownloadHistoryEntry['status']
> = {
  queued: 'queued',
  downloading: 'running',
  paused: 'paused',
  completed: 'completed',
  'partially-completed': 'partially-completed',
  'packaging-failed': 'failed',
  failed: 'failed',
  cancelled: 'cancelled',
  discovering: 'failed',
  'needs-review': 'failed',
  ready: 'failed'
}

export function projectDownloadJob(
  item: DiscoveryQueueItem
): DownloadHistoryEntry | null {
  const options = item.downloadOptions
  if (!options) return null
  const selectedChapterCount = item.chapterSummary.selected
  const completedChapters = item.progress?.current ?? 0
  return {
    id: item.downloadHistoryId || item.id,
    queueItemId: item.id,
    title: options.title || item.title,
    author: options.author || item.author,
    sourceUrl: options.sourceUrl || item.sourceUrl,
    trackerRow: item.trackerRow ? { ...item.trackerRow } : null,
    selectedChapterCount:
      Number.isSafeInteger(selectedChapterCount) && selectedChapterCount >= 0
        ? selectedChapterCount
        : 0,
    status: historyStatusByQueueStatus[item.status],
    completedChapters:
      Number.isSafeInteger(completedChapters) && completedChapters >= 0
        ? Math.min(completedChapters, selectedChapterCount)
        : 0,
    outputPath: item.outputPath || '',
    outputPaths: (item.outputPaths ?? []).map((output) => ({ ...output })),
    error: item.error || '',
    startedAt:
      item.downloadStartedAt ||
      item.queuedAt ||
      item.updatedAt ||
      item.discoveredAt,
    updatedAt: item.updatedAt || item.queuedAt || item.discoveredAt
  }
}

export function projectDownloadHistory(
  queueItems: DiscoveryQueueItem[],
  archivedJobs: DownloadHistoryEntry[],
  limit = 50
): DownloadHistoryEntry[] {
  const currentJobs = queueItems.flatMap((item) => {
    const job = projectDownloadJob(item)
    return job ? [job] : []
  })
  const currentIds = new Set(currentJobs.map((job) => job.id))
  const currentQueueItemIds = new Set(
    currentJobs.map((job) => job.queueItemId).filter(Boolean)
  )
  const archived = archivedJobs.filter(
    (job) =>
      !currentIds.has(job.id) &&
      (!job.queueItemId || !currentQueueItemIds.has(job.queueItemId))
  )
  archived.sort((left, right) =>
    (right.startedAt || right.updatedAt).localeCompare(
      left.startedAt || left.updatedAt
    )
  )
  return [
    ...currentJobs,
    ...archived.slice(0, Math.max(0, limit))
  ]
    .sort((left, right) =>
      (right.startedAt || right.updatedAt).localeCompare(
        left.startedAt || left.updatedAt
      )
    )
    .slice(0, Math.max(0, limit))
}
