import type { DiscoveryQueueItem, QueueChapter } from '../../../shared/contracts'

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
