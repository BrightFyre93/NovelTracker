import type { DiscoveryQueueItem, QueueChapter } from '../../../shared/contracts'
import {
  readDiscoveryQueue,
  readDiscoveryQueueItemChapters,
  writeDiscoveryQueue,
  writeDiscoveryQueueItemChapters,
  writeDiscoveryQueueItemSelection
} from '../localStore'

export interface QueueRepository {
  readQueue(): Promise<DiscoveryQueueItem[]>
  writeQueue(items: DiscoveryQueueItem[]): Promise<void>
  readChapters(queueItemId: string): Promise<QueueChapter[] | null>
  writeChapters(queueItemId: string, chapters: QueueChapter[]): Promise<void>
  writeSelection(
    queueItemId: string,
    selectedChapterIds: string[]
  ): Promise<void>
}

export type QueueChapterDownloadStatus =
  | 'Pending'
  | 'Downloading'
  | 'Downloaded'
  | 'Retrying'
  | 'Failed'
  | 'Skipped'
  | 'InvalidArtifact'

export interface QueueChapterDownloadState {
  chapterId: string
  originalUrl: string
  currentUrl: string
  title: string
  sourceOrder: number
  state: QueueChapterDownloadStatus
  attemptCount: number
  createdAt: string
  updatedAt: string
  lastHttpStatus: number | null
  lastError: string | null
  artifactRef: string | null
}

export interface QueueChapterStateRepository {
  readChapterStates(queueItemId: string): Promise<QueueChapterDownloadState[]>
  writeChapterStates(
    queueItemId: string,
    states: QueueChapterDownloadState[]
  ): Promise<void>
}

export function createJsonQueueRepository(
  dataDirectory: () => string
): QueueRepository {
  return {
    readQueue: () => readDiscoveryQueue(dataDirectory()),
    writeQueue: (items) => writeDiscoveryQueue(dataDirectory(), items),
    readChapters: (queueItemId) =>
      readDiscoveryQueueItemChapters(dataDirectory(), queueItemId),
    writeChapters: (queueItemId, chapters) =>
      writeDiscoveryQueueItemChapters(
        dataDirectory(),
        queueItemId,
        chapters
      ),
    writeSelection: (queueItemId, selectedChapterIds) =>
      writeDiscoveryQueueItemSelection(
        dataDirectory(),
        queueItemId,
        selectedChapterIds
      )
  }
}
