import type {
  DiscoveryQueueItem,
  QueueChapter
} from '../../../shared/contracts'
import { SerialQueue } from '../serialQueue'
import {
  copyQueueItem,
  copyQueueItemForPersistence,
  updateQueueChapterSummary
} from '../queueItem'
import type { QueueRepository } from './repository'

export interface QueueSelectionPersistence {
  id: string
  selectedChapterIds: string[]
  previousSelectedChapterIds: string[]
}

export interface QueueMutationOptions {
  loadChapters?: boolean
  selectionUpdate?: QueueSelectionPersistence
}

export class QueueStore {
  readonly items: DiscoveryQueueItem[] = []
  private readonly writes = new SerialQueue()
  private readonly dirtyChapterIds = new Map<string, number>()
  private chapterRevision = 0
  private sequenceCounter = 0

  constructor(
    private readonly repository: QueueRepository,
    private readonly hasUnknownProperties: (
      saved: object,
      normalized: object
    ) => boolean
  ) {}

  replace(items: DiscoveryQueueItem[]): void {
    this.sequenceCounter = 0
    for (const item of items) {
      if (Number.isSafeInteger(item.sequence) && item.sequence > 0) {
        this.sequenceCounter = Math.max(this.sequenceCounter, item.sequence)
      }
    }
    const usedSequences = new Set<number>()
    for (const item of items) {
      if (
        !Number.isSafeInteger(item.sequence) ||
        item.sequence <= 0 ||
        usedSequences.has(item.sequence)
      ) {
        item.sequence = this.nextSequence()
      }
      usedSequences.add(item.sequence)
    }
    this.items.splice(0, this.items.length, ...items)
  }

  nextSequence(): number {
    for (const item of this.items) {
      if (Number.isSafeInteger(item.sequence)) {
        this.sequenceCounter = Math.max(this.sequenceCounter, item.sequence)
      }
    }
    if (this.sequenceCounter >= Number.MAX_SAFE_INTEGER) {
      throw new Error('The queue sequence has reached its safe integer limit.')
    }
    this.sequenceCounter += 1
    return this.sequenceCounter
  }

  resequence(items: DiscoveryQueueItem[]): void {
    for (const item of items) item.sequence = this.nextSequence()
  }

  markChaptersDirty(item: DiscoveryQueueItem): void {
    updateQueueChapterSummary(item)
    this.dirtyChapterIds.set(item.id, ++this.chapterRevision)
  }

  hasDirtyChapters(itemId: string): boolean {
    return this.dirtyChapterIds.has(itemId)
  }

  clearDirtyChapters(itemId: string): void {
    this.dirtyChapterIds.delete(itemId)
  }

  async ensureChapters(item: DiscoveryQueueItem): Promise<void> {
    if (item.chapters.length > 0 || item.chapterSummary.total === 0) return
    const chapters = await this.repository.readChapters(item.id)
    if (!chapters || chapters.length !== item.chapterSummary.total) {
      throw new Error(
        `Saved chapter details are missing or incomplete for "${item.title}".`
      )
    }
    let savedChapterDataChanged = false
    item.chapters = chapters.map((chapter) => {
      const normalized = this.normalizeChapter(chapter)
      if (this.hasUnknownProperties(chapter, normalized))
        savedChapterDataChanged = true
      return normalized
    })
    if (savedChapterDataChanged) this.markChaptersDirty(item)
  }

  async withChapters<T>(
    item: DiscoveryQueueItem,
    operation: (item: DiscoveryQueueItem) => Promise<T> | T
  ): Promise<T> {
    try {
      await this.ensureChapters(item)
      return await operation(item)
    } finally {
      if (!this.hasDirtyChapters(item.id)) this.releaseChapters(item)
    }
  }

  releaseChapters(item: DiscoveryQueueItem): void {
    item.chapters = []
  }

  persist(
    selectionUpdate?: QueueSelectionPersistence
  ): Promise<void> {
    const changedChapterData = [...this.dirtyChapterIds.entries()].flatMap(
      ([id, revision]) => {
        const item = this.items.find((candidate) => candidate.id === id)
        return item
          ? [{ id, revision, chapters: item.chapters.map((chapter) => ({ ...chapter })) }]
          : []
      }
    )
    const snapshot = this.items.map(copyQueueItemForPersistence)
    return this.writes.enqueue(() =>
      this.persistSnapshot(snapshot, changedChapterData, selectionUpdate)
    )
  }

  async mutateItem<T>(
    id: string,
    mutation: (draft: DiscoveryQueueItem) => Promise<T> | T,
    options: QueueMutationOptions = {}
  ): Promise<T> {
    return this.writes.enqueue(async () => {
      const item = this.items.find((candidate) => candidate.id === id)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      const draft = copyQueueItem(item)
      if (options.loadChapters) await this.ensureChapters(draft)
      const originalChapters = draft.chapters.map((chapter) => ({ ...chapter }))
      const result = await mutation(draft)
      const chaptersChanged =
        JSON.stringify(draft.chapters) !== JSON.stringify(originalChapters)
      const chaptersToWrite =
        chaptersChanged ||
        (draft.chapters.length > 0 && this.dirtyChapterIds.has(id))
      const snapshot = this.items.map((candidate) =>
        candidate.id === id
          ? copyQueueItemForPersistence(draft)
          : copyQueueItemForPersistence(candidate)
      )
      try {
        if (chaptersToWrite) {
          await this.repository.writeChapters(id, draft.chapters)
        }
        if (options.selectionUpdate) {
          await this.repository.writeSelection(
            id,
            options.selectionUpdate.selectedChapterIds
          )
        }
        await this.repository.writeQueue(snapshot)
      } catch (error) {
        if (options.selectionUpdate) {
          await this.repository
            .writeSelection(
              id,
              options.selectionUpdate.previousSelectedChapterIds
            )
            .catch((rollbackError: unknown) => {
              console.error(
                `Chapter selection rollback for ${id} could not be saved:`,
                rollbackError
              )
            })
        }
        if (chaptersToWrite) {
          await this.repository.writeChapters(id, originalChapters).catch(
            (rollbackError: unknown) => {
              console.error(
                `Queue item ${id} chapter rollback could not be saved:`,
                rollbackError
              )
            }
          )
        }
        throw error
      }
      Object.assign(item, draft)
      if (chaptersToWrite) this.dirtyChapterIds.delete(id)
      return result
    })
  }

  drain(): Promise<void> {
    return this.writes.drain()
  }

  private async persistSnapshot(
    snapshot: DiscoveryQueueItem[],
    changedChapterData: Array<{
      id: string
      revision: number
      chapters: QueueChapter[]
    }>,
    selectionUpdate?: QueueSelectionPersistence
  ): Promise<void> {
    try {
      for (const { id, chapters } of changedChapterData) {
        await this.repository.writeChapters(id, chapters)
      }
      if (selectionUpdate) {
        await this.repository.writeSelection(
          selectionUpdate.id,
          selectionUpdate.selectedChapterIds
        )
      }
      await this.repository.writeQueue(snapshot)
      for (const { id, revision } of changedChapterData) {
        if (this.dirtyChapterIds.get(id) === revision)
          this.dirtyChapterIds.delete(id)
      }
    } catch (error) {
      if (selectionUpdate) {
        await this.repository
          .writeSelection(
            selectionUpdate.id,
            selectionUpdate.previousSelectedChapterIds
          )
          .catch((rollbackError: unknown) => {
            console.error(
              `Chapter selection rollback for ${selectionUpdate.id} could not be saved:`,
              rollbackError
            )
          })
      }
      throw error
    }
  }

  private normalizeChapter(chapter: QueueChapter): QueueChapter {
    return {
      id: chapter.id,
      title: chapter.title,
      url: chapter.url,
      selected: chapter.selected,
      archiveStatus: chapter.archiveStatus ?? 'missing',
      archiveSources: chapter.archiveSources ?? [],
      chapterNumber: chapter.chapterNumber ?? null,
      archiveGap: chapter.archiveGap ?? false,
      recommended: chapter.recommended ?? true
    }
  }

}
