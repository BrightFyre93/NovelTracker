import { clipboard } from 'electron'
import type { IpcContext } from './context'

type QueueIpcContext = Pick<
  IpcContext,
  | 'MAX_SELECTED_CHAPTERS'
  | 'activeDownloads'
  | 'activeQueueDiscoveries'
  | 'archiveRemovedJobs'
  | 'assertOutputPathAvailable'
  | 'browserAssistedDiscoveries'
  | 'chapterStateRepository'
  | 'clearDirtyChapterData'
  | 'copyDiscoveryQueue'
  | 'copyQueueItem'
  | 'createQueueItem'
  | 'dataDirectory'
  | 'discoveryQueue'
  | 'discoveryQueueRevision'
  | 'discoveryScheduler'
  | 'downloadScheduler'
  | 'errorMessage'
  | 'expectedOutputPath'
  | 'handle'
  | 'libraryIndexRepository'
  | 'markQueueItemChaptersDirty'
  | 'mutateItem'
  | 'notifyDiscoveryQueueChanged'
  | 'parseDiscoveryQueueInputs'
  | 'parseGenerateInput'
  | 'persistDiscoveryQueue'
  | 'persistDiscoveryQueueOrRollback'
  | 'persistDownloadState'
  | 'projectDownloadHistory'
  | 'queueStore'
  | 'readArchivedDownloadHistory'
  | 'readTrackerCsv'
  | 'recommendArchiveCoverage'
  | 'removeChapterArtifacts'
  | 'resolveChapterSelection'
  | 'siteExtractionModeForUrl'
  | 'settingsService'
  | 'transitionQueueItem'
  | 'updateQueueChapterSummary'
  | 'withChapters'
>
import type { DiscoveryQueueInput } from '../../shared/contracts'
import { z } from 'zod'
import { createQueueCommands } from '../services/queue/queueCommands'
import { createDiscoveryQueueCommands } from '../services/queue/discoveryQueueCommands'

export function registerQueueIpcHandlers(context: QueueIpcContext): void {
  const {
    MAX_SELECTED_CHAPTERS,
    copyDiscoveryQueue,
    copyQueueItem,
    dataDirectory,
    discoveryQueue,
    handle,
    projectDownloadHistory,
    readArchivedDownloadHistory,
    readTrackerCsv,
    settingsService,
    withChapters
  } = context
  const queueCommands = {
    ...createDiscoveryQueueCommands(context),
    ...createQueueCommands(context)
  }
  const queueItemIdSchema = z.custom<string>(
    (value): value is string => typeof value === 'string',
    'Invalid download queue item.'
  )

  handle('validated-result', 'tracker:list', z.tuple([]), async () => {
    const settings = await settingsService.get()
    if (!settings.trackerCsvPath)
      throw new Error('Choose a tracker CSV file in Configuration first.')
    return { ok: true, value: await readTrackerCsv(settings.trackerCsvPath) }
  })

  handle('typed', 'download-history:list', z.tuple([]), async () =>
    projectDownloadHistory(
      discoveryQueue,
      await readArchivedDownloadHistory(dataDirectory())
    )
  )

  handle('typed', 'discovery-queue:list', z.tuple([]), () =>
    copyDiscoveryQueue()
  )

  handle('typed', 'discovery-queue:snapshot', z.tuple([]), () => ({
    revision: context.discoveryQueueRevision,
    items: copyDiscoveryQueue()
  }))

  handle(
    'result',
    'discovery-queue:item',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, id) => {
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      return withChapters(item, () => copyQueueItem(item))
    }
  )

  handle(
    'result',
    'discovery-queue:failed-chapters',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    (_event, id) => {
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      return item.failedChapters.map((chapter) => ({ ...chapter }))
    }
  )

  handle(
    'result',
    'discovery-queue:add',
    z.tuple([
      z.custom<DiscoveryQueueInput[]>(
        (value): value is DiscoveryQueueInput[] => Array.isArray(value),
        'Add between 1 and 100 tracker novels or URLs at a time.'
      )
    ]),
    (_event, rawItems) => queueCommands.addDiscoveryItems(rawItems)
  )
  handle(
    'validated-result',
    'discovery-queue:retry',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.retryDiscovery(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:retry-failed',
    z.tuple([]),
    async () => ({
      ok: true,
      value: await queueCommands.retryFailedDiscoveries()
    })
  )
  handle(
    'validated-result',
    'discovery-queue:force-retry',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.forceRetryDiscovery(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:retry-browser',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.retryDiscovery(rawId, true)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:refresh',
    z.tuple([
      queueItemIdSchema,
      z.enum(['automatic', 'generic-html', 'novelfull']).optional()
    ]),
    async (_event, rawId, parserMode) => {
      await queueCommands.refreshDiscovery(rawId, parserMode)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:accept-recommendations',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.acceptRecommendations(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:cancel',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.cancelDiscovery(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:remove',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.removeQueueItem(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle('validated-result', 'discovery-queue:clear', z.tuple([]), async () => {
    await queueCommands.clearQueue()
    return { ok: true, value: undefined }
  })
  handle(
    'validated-result',
    'discovery-queue:clear-completed',
    z.tuple([]),
    async () => {
      await queueCommands.clearCompletedQueue()
      return { ok: true, value: undefined }
    }
  )
  handle(
    'result',
    'discovery-queue:update-selection',
    z.tuple([
      queueItemIdSchema,
      z.union([
        z
          .object({
            mode: z.literal('ids'),
            ids: z.array(z.string()).max(MAX_SELECTED_CHAPTERS)
          })
          .strict(),
        z
          .object({
            mode: z.literal('ranges'),
            ranges: z
              .array(
                z
                  .object({
                    start: z.number().int().min(0),
                    end: z.number().int().min(0)
                  })
                  .strict()
              )
              .max(MAX_SELECTED_CHAPTERS)
          })
          .strict()
      ])
    ]),
    async (_event, id, selectionUpdate) => {
      await queueCommands.updateChapterSelection(id, selectionUpdate)
    }
  )
  // Copies the Android download sync text for the completed jobs the Queue page shows.
  handle(
    'validated-result',
    'queue:copy-download-sync-text',
    z.tuple([z.array(queueItemIdSchema).max(50_000)]),
    async (_event, ids) => {
      const sync = await queueCommands.buildDownloadSyncText(ids)
      if (sync.rows.length === 0) {
        throw new Error(
          'None of the completed jobs shown has a known downloaded chapter number.'
        )
      }
      let copied = false
      try {
        clipboard.writeText(sync.text)
        copied = true
      } catch (error) {
        console.warn('The download sync text could not be copied:', error)
      }
      return {
        ok: true,
        value: {
          text: sync.text,
          novelCount: sync.rows.length,
          skippedCount: sync.skippedNovelCount,
          copied
        }
      }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:reverse-chapters',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.reverseChapterOrder(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'discovery-queue:update-chapter-url',
    z.tuple([queueItemIdSchema, z.string().max(200), z.string().max(4096)]),
    async (_event, rawId, chapterId, url) => {
      await queueCommands.updateChapterUrl(rawId, chapterId, url)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:enqueue-from-snapshot',
    z.tuple([
      z.string(),
      z
        .object({
          title: z.string().optional(),
          author: z.string().optional(),
          description: z.string().optional(),
          coverUrl: z.string().optional(),
          alternativeNames: z.array(z.string()).optional(),
          genres: z.array(z.string()).optional(),
          source: z.string().optional(),
          novelStatus: z.string().optional(),
          language: z.string().optional(),
          filename: z.string().optional(),
          outputDirectory: z.string()
        })
        .strict()
    ]),
    (_event, queueItemId, overrides) =>
      queueCommands.enqueueFromSnapshot(queueItemId, overrides)
  )
  handle(
    'validated-result',
    'download-queue:retry',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.retry(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:recover',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.recover(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:repackage',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.repackage(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:save-available',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.saveAvailable(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:move',
    z.tuple([
      z.string(),
      z.custom<'up' | 'down' | 'top' | 'bottom'>(
        (value): value is 'up' | 'down' | 'top' | 'bottom' =>
          value === 'up' ||
          value === 'down' ||
          value === 'top' ||
          value === 'bottom',
        'Invalid queue reorder request.'
      )
    ]),
    async (_event, rawId, direction) => {
      await queueCommands.moveDownloadJob(rawId, direction)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:pause',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.pauseDownloadJob(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:resume',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.resumeDownloadJob(rawId)
      return { ok: true, value: undefined }
    }
  )
  handle(
    'validated-result',
    'download-queue:cancel',
    z.tuple([queueItemIdSchema]),
    async (_event, rawId) => {
      await queueCommands.cancelDownloadJob(rawId)
      return { ok: true, value: undefined }
    }
  )
}
