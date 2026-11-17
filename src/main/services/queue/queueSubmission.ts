import { randomUUID } from 'node:crypto'
import type { DiscoveryQueueItem } from '../../../shared/contracts'
import { normalizeEpubOutputOptions } from '../../../shared/epubOutputOptions'
import type { QueueCommandContext } from './queueCommands'

export interface EnqueueSnapshotOverrides {
  title?: string
  author?: string
  description?: string
  coverUrl?: string
  alternativeNames?: string[]
  genres?: string[]
  source?: string
  novelStatus?: string
  language?: string
  filename?: string
  outputDirectory: string
}

type QueueSubmissionContext = Pick<
  QueueCommandContext,
  | 'assertOutputPathAvailable'
  | 'copyQueueItem'
  | 'discoveryQueue'
  | 'errorMessage'
  | 'expectedOutputPath'
  | 'markQueueItemChaptersDirty'
  | 'notifyDiscoveryQueueChanged'
  | 'parseGenerateInput'
  | 'persistDiscoveryQueue'
  | 'queueStore'
  | 'settingsService'
  | 'transitionQueueItem'
  | 'withChapters'
> & { requestDownloadQueueDrain: () => void }

export function createQueueSubmissionCommand(context: QueueSubmissionContext) {
  const {
    assertOutputPathAvailable,
    copyQueueItem,
    discoveryQueue,
    errorMessage,
    expectedOutputPath,
    markQueueItemChaptersDirty,
    notifyDiscoveryQueueChanged,
    parseGenerateInput,
    persistDiscoveryQueue,
    queueStore,
    settingsService,
    transitionQueueItem,
    withChapters,
    requestDownloadQueueDrain
  } = context
  return async function enqueueFromSnapshot(
    queueItemId: string,
    overrides: EnqueueSnapshotOverrides
  ) {
    let previousItem: DiscoveryQueueItem | null = null
    let queueMutated = false
    let historyId = ''
    try {
      const item = discoveryQueue.find(
        (candidate) => candidate.id === queueItemId
      )
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      if (item.status !== 'needs-review' && item.status !== 'ready') {
        throw new Error(
          'This novel is not ready to be queued for EPUB creation.'
        )
      }
      const selectedChapters = await withChapters(item, (loadedItem) =>
        loadedItem.chapters
          .filter((chapter) => chapter.selected)
          .map(({ id, title, url }) => ({ id, title, url }))
      )
      const input = parseGenerateInput({
        title: overrides.title ?? item.title,
        author: overrides.author ?? item.author,
        description: overrides.description ?? item.description,
        coverUrl: overrides.coverUrl ?? item.coverUrl,
        alternativeNames: overrides.alternativeNames ?? item.alternativeNames,
        genres: overrides.genres ?? item.genres,
        source: overrides.source ?? item.source,
        novelStatus: overrides.novelStatus ?? item.novelStatus,
        language: overrides.language ?? 'en',
        filename: overrides.filename ?? '',
        sourceUrl: item.sourceUrl,
        outputDirectory: overrides.outputDirectory,
        chapters: selectedChapters,
        trackerRow: item.trackerRow ?? undefined
      })
      const settings = await settingsService.get()
      const sourceUrl = item.sourceUrl
      const outputPath = expectedOutputPath(
        input.outputDirectory,
        input.title,
        input.filename ?? '',
        input.chapters
      )
      assertOutputPathAvailable(discoveryQueue, outputPath, item.id)
      const queueItem = item
      await withChapters(queueItem, () => {
        previousItem = copyQueueItem(queueItem)
        const selectedUrls = new Set(
          input.chapters.map((chapter) => chapter.url)
        )
        const availableUrls = new Set(
          queueItem.chapters.map((chapter) => chapter.url)
        )
        if ([...selectedUrls].some((url) => !availableUrls.has(url))) {
          throw new Error(
            'The selected chapters no longer match the saved discovery snapshot.'
          )
        }
        queueMutated = true
        for (const chapter of queueItem.chapters)
          chapter.selected = selectedUrls.has(chapter.url)
        markQueueItemChaptersDirty(queueItem)
        queueItem.title = input.title
        queueItem.author = input.author
        queueItem.description = input.description ?? queueItem.description
        queueItem.coverUrl = input.coverUrl ?? queueItem.coverUrl
        queueItem.alternativeNames = [
          ...(input.alternativeNames ?? queueItem.alternativeNames)
        ]
        queueItem.genres = [...(input.genres ?? queueItem.genres)]
        queueItem.source = input.source ?? queueItem.source
        queueItem.novelStatus = input.novelStatus ?? queueItem.novelStatus
        queueItem.trackerRow = input.trackerRow ?? queueItem.trackerRow
      })
      const now = new Date().toISOString()
      historyId = randomUUID()
      transitionQueueItem(queueItem, 'queued')
      queueItem.downloadOptions = {
        title: input.title,
        author: input.author,
        description: input.description ?? queueItem.description,
        coverUrl: input.coverUrl ?? queueItem.coverUrl,
        alternativeNames: [
          ...(input.alternativeNames ?? queueItem.alternativeNames)
        ],
        genres: [...(input.genres ?? queueItem.genres)],
        source: input.source ?? queueItem.source,
        novelStatus: input.novelStatus ?? queueItem.novelStatus,
        language: input.language,
        filename: input.filename ?? '',
        sourceUrl,
        outputDirectory: input.outputDirectory,
        epubCss: settings.epubCss,
        omitHttp404Chapters: settings.omitHttp404Chapters,
        outputOptions: normalizeEpubOutputOptions({
          css: settings.epubCss,
          language: input.language,
          identifierSeed: sourceUrl
        })
      }
      queueItem.targetOutputPath = outputPath
      queueItem.queuedAt = now
      queueItem.failedChapters = []
      queueItem.outputPath = ''
      queueItem.downloadHistoryId = historyId
      queueItem.downloadStartedAt = now
      queueItem.sequence = queueStore.nextSequence()
      queueItem.repackageOnly = false
      queueItem.saveAvailableChaptersOnly = false
      queueItem.progress = {
        current: 0,
        total: input.chapters.length,
        message: 'Queued for download'
      }
      queueItem.error = ''
      queueItem.updatedAt = now

      await withChapters(queueItem, () => persistDiscoveryQueue())
      notifyDiscoveryQueueChanged()
      requestDownloadQueueDrain()
      return {
        ok: true as const,
        value: { queueItemId: queueItem.id, historyId }
      }
    } catch (error) {
      if (queueMutated && previousItem) {
        const index = discoveryQueue.findIndex(
          (candidate) => candidate.id === previousItem?.id
        )
        if (index >= 0) {
          discoveryQueue[index] = previousItem
          markQueueItemChaptersDirty(previousItem)
        }
      }
      if (queueMutated) {
        await persistDiscoveryQueue().catch((saveError: unknown) => {
          console.error(
            'Failed queue submission rollback could not be saved:',
            saveError
          )
        })
        notifyDiscoveryQueueChanged()
      }
      console.error('EPUB queueing failed:', error)
      return { ok: false as const, error: errorMessage(error) }
    }
  }
}
