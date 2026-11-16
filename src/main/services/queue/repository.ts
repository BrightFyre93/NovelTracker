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
