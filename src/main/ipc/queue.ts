import type { IpcContext } from './context'

type QueueIpcContext = Pick<
  IpcContext,
  | 'MAX_SELECTED_CHAPTERS'
  | 'activeDownloads'
  | 'activeQueueDiscoveries'
  | 'archiveRemovedJobs'
  | 'assertOutputPathAvailable'
  | 'browserAssistedDiscoveries'
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
  | 'handleResultIpc'
  | 'handleTypedIpc'
  | 'handleValidatedResultIpc'
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
  | 'randomUUID'
  | 'readArchivedDownloadHistory'
  | 'readChapterArtifact'
  | 'readCoverArtifact'
  | 'readSettings'
  | 'readTrackerCsv'
  | 'recommendArchiveCoverage'
  | 'removeChapterArtifacts'
  | 'resolveChapterSelection'
  | 'siteExtractionModeForUrl'
  | 'transitionQueueItem'
  | 'updateQueueChapterSummary'
  | 'withChapters'
  | 'z'
>
import type {
  DiscoveryQueueInput,
  DiscoveryQueueItem
} from '../../shared/contracts'

export function registerQueueIpcHandlers(context: QueueIpcContext): void {
  const {
    MAX_SELECTED_CHAPTERS,
    activeDownloads,
    activeQueueDiscoveries,
    archiveRemovedJobs,
    assertOutputPathAvailable,
    browserAssistedDiscoveries,
    clearDirtyChapterData,
    copyDiscoveryQueue,
    copyQueueItem,
    createQueueItem,
    dataDirectory,
    discoveryQueue,
    discoveryScheduler,
    downloadScheduler,
    errorMessage,
    expectedOutputPath,
    handleResultIpc,
    handleTypedIpc,
    handleValidatedResultIpc,
    libraryIndexRepository,
    markQueueItemChaptersDirty,
    mutateItem,
    notifyDiscoveryQueueChanged,
    parseDiscoveryQueueInputs,
    parseGenerateInput,
    persistDiscoveryQueue,
    persistDiscoveryQueueOrRollback,
    persistDownloadState,
    projectDownloadHistory,
    queueStore,
    randomUUID,
    readArchivedDownloadHistory,
    readChapterArtifact,
    readCoverArtifact,
    readSettings,
    readTrackerCsv,
    recommendArchiveCoverage,
    removeChapterArtifacts,
    resolveChapterSelection,
    siteExtractionModeForUrl,
    transitionQueueItem,
    updateQueueChapterSummary,
    withChapters,
    z
  } = context

  handleValidatedResultIpc('tracker:list', z.tuple([]), async () => {
    const settings = await readSettings(dataDirectory())
    if (!settings.trackerCsvPath)
      throw new Error('Choose a tracker CSV file in Configuration first.')
    return { ok: true, value: await readTrackerCsv(settings.trackerCsvPath) }
  })

  handleTypedIpc('download-history:list', z.tuple([]), async () =>
    projectDownloadHistory(
      discoveryQueue,
      await readArchivedDownloadHistory(dataDirectory())
    )
  )

  handleTypedIpc('discovery-queue:list', z.tuple([]), () =>
    copyDiscoveryQueue()
  )

  handleTypedIpc('discovery-queue:snapshot', z.tuple([]), () => ({
    revision: context.discoveryQueueRevision,
    items: copyDiscoveryQueue()
  }))

  handleResultIpc(
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

  handleResultIpc(
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

  handleResultIpc(
    'discovery-queue:add',
    z.tuple([
      z.custom<DiscoveryQueueInput[]>(
        (value): value is DiscoveryQueueInput[] => Array.isArray(value),
        'Add between 1 and 100 tracker novels or URLs at a time.'
      )
    ]),
    async (_event, rawItems) => {
      const inputs = parseDiscoveryQueueInputs(rawItems)
      const existingUrls = new Set(discoveryQueue.map((item) => item.sourceUrl))
      const submittedUrls = new Set<string>()
      const added: DiscoveryQueueItem[] = []
      for (const input of inputs) {
        if (submittedUrls.has(input.sourceUrl)) continue
        submittedUrls.add(input.sourceUrl)
        const isDuplicateSource = existingUrls.has(input.sourceUrl)
        if (isDuplicateSource && !input.separateJob) continue
        if (isDuplicateSource) {
          for (const existingItem of discoveryQueue) {
            if (
              existingItem.sourceUrl === input.sourceUrl &&
              !existingItem.downloadOptions
            ) {
              existingItem.separateJob = true
            }
          }
        }
        existingUrls.add(input.sourceUrl)
        const now = new Date().toISOString()
        added.push(
          createQueueItem({
            title: input.title,
            author: input.author,
            sourceUrl: input.sourceUrl,
            origin: input.origin,
            sequence: queueStore.nextSequence(),
            separateJob: isDuplicateSource && input.separateJob === true,
            trackerRow: input.trackerRow ?? null,
            status: 'discovering',
            saveAvailableChaptersOnly: false,
            updatedAt: now
          })
        )
      }

      if (added.length > 0) {
        discoveryQueue.push(...added)
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
        discoveryScheduler.enqueueMany(added.map((item) => item.id))
      }
      return added
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      if (
        (item.status !== 'failed' && item.status !== 'cancelled') ||
        item.downloadOptions
      ) {
        throw new Error(
          'Only failed or cancelled discovery items can be retried.'
        )
      }
      await mutateItem(item.id, (draft) => {
        if (
          (draft.status !== 'failed' && draft.status !== 'cancelled') ||
          draft.downloadOptions
        ) {
          throw new Error(
            'Only failed or cancelled discovery items can be retried.'
          )
        }
        transitionQueueItem(draft, 'discovering')
        draft.error = ''
        draft.updatedAt = new Date().toISOString()
      })
      notifyDiscoveryQueueChanged()
      discoveryScheduler.enqueue(item.id)
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry-failed',
    z.tuple([]),
    async () => {
      const failedItems = discoveryQueue.filter(
        (item) => item.status === 'failed' && !item.downloadOptions
      )
      if (failedItems.length === 0) return { ok: true, value: 0 }

      const previousStates = failedItems.map((item) => ({
        item,
        error: item.error,
        progress: item.progress,
        updatedAt: item.updatedAt
      }))
      const now = new Date().toISOString()
      for (const item of failedItems) {
        transitionQueueItem(item, 'discovering')
        item.progress = null
        item.error = ''
        item.updatedAt = now
      }

      await persistDiscoveryQueueOrRollback(() => {
        for (const previous of previousStates) {
          transitionQueueItem(previous.item, 'failed')
          previous.item.error = previous.error
          previous.item.progress = previous.progress
          previous.item.updatedAt = previous.updatedAt
        }
      })

      notifyDiscoveryQueueChanged()
      discoveryScheduler.enqueueMany(failedItems.map((item) => item.id))
      return { ok: true, value: failedItems.length }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:force-retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || item.status !== 'discovering' || item.downloadOptions) {
        throw new Error('Only active discovery items can be force-retried.')
      }

      browserAssistedDiscoveries.delete(item.id)
      const supersedingController = new AbortController()
      const activeController = activeQueueDiscoveries.get(item.id)
      activeQueueDiscoveries.set(item.id, supersedingController)
      activeController?.abort()
      discoveryScheduler.remove(item.id)
      item.error = ''
      item.progress = {
        current: 0,
        total: 0,
        message: 'Restarting chapter discovery…'
      }
      item.updatedAt = new Date().toISOString()

      try {
        await persistDiscoveryQueue()
      } catch (error) {
        transitionQueueItem(item, 'failed')
        item.error = `The forced discovery retry could not be saved: ${errorMessage(error)}`
        item.updatedAt = new Date().toISOString()
        if (activeQueueDiscoveries.get(item.id) === supersedingController) {
          activeQueueDiscoveries.delete(item.id)
        }
        await persistDiscoveryQueue().catch((saveError: unknown) => {
          console.error(
            `Discovery retry failure state for ${item.id} could not be saved:`,
            saveError
          )
        })
        throw error
      }

      discoveryScheduler.enqueue(item.id)
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:retry-browser',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      if (
        (item.status !== 'failed' && item.status !== 'cancelled') ||
        item.downloadOptions
      ) {
        throw new Error(
          'Only failed or cancelled discovery items can be retried with the browser.'
        )
      }
      await mutateItem(item.id, (draft) => {
        if (
          (draft.status !== 'failed' && draft.status !== 'cancelled') ||
          draft.downloadOptions
        ) {
          throw new Error(
            'Only failed or cancelled discovery items can be retried with the browser.'
          )
        }
        transitionQueueItem(draft, 'discovering')
        draft.error = ''
        draft.updatedAt = new Date().toISOString()
      })
      browserAssistedDiscoveries.add(item.id)
      notifyDiscoveryQueueChanged()
      discoveryScheduler.enqueue(item.id)
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:refresh',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      ),
      z.enum(['automatic', 'generic-html', 'novelfull']).optional()
    ]),
    async (_event, rawId, parserMode) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item)
        throw new Error('The selected discovery queue item no longer exists.')
      const canRefreshReviewedItem =
        item.status === 'needs-review' || item.status === 'ready'
      const canRetryFailedItemWithParser =
        parserMode !== undefined &&
        !item.downloadOptions &&
        (item.status === 'failed' || item.status === 'cancelled')
      if (!canRefreshReviewedItem && !canRetryFailedItemWithParser) {
        throw new Error(
          'Only reviewed discovery items can be refreshed; failed or cancelled scans require a parser selection.'
        )
      }
      const settings = await readSettings(dataDirectory())
      await mutateItem(item.id, (draft) => {
        const canRefreshReviewedDraft =
          draft.status === 'needs-review' || draft.status === 'ready'
        const canRetryFailedDraft =
          parserMode !== undefined &&
          !draft.downloadOptions &&
          (draft.status === 'failed' || draft.status === 'cancelled')
        if (!canRefreshReviewedDraft && !canRetryFailedDraft) {
          throw new Error(
            'Only reviewed discovery items can be refreshed; failed or cancelled scans require a parser selection.'
          )
        }
        draft.siteExtractionMode =
          parserMode ??
          draft.siteExtractionMode ??
          siteExtractionModeForUrl(
            draft.sourceUrl,
            settings.siteExtractionPreferences
          )
        draft.error = ''
        transitionQueueItem(draft, 'discovering')
        draft.updatedAt = new Date().toISOString()
      })
      notifyDiscoveryQueueChanged()
      discoveryScheduler.enqueue(item.id)
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:accept-recommendations',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid recommendation settings.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (
        !item ||
        (item.status !== 'needs-review' && item.status !== 'ready')
      ) {
        throw new Error('The selected item is not ready for recommendations.')
      }
      await withChapters(item, async () => {
        const libraryFiles =
          await libraryIndexRepository.readRecommendationFiles(item)
        const recommendation = recommendArchiveCoverage(
          item,
          libraryFiles ?? []
        )
        item.chapters = recommendation.chapters.map((chapter) => ({
          ...chapter,
          selected: chapter.recommended
        }))
        markQueueItemChaptersDirty(item)
        item.recommendationSummary = recommendation.summary
        transitionQueueItem(
          item,
          item.chapters.some((chapter) => chapter.selected)
            ? 'ready'
            : 'needs-review'
        )
        item.updatedAt = new Date().toISOString()
        await persistDiscoveryQueue()
      })
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:cancel',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || item.status !== 'discovering') {
        throw new Error('The selected discovery is no longer running.')
      }

      const controller = activeQueueDiscoveries.get(rawId)
      if (controller) {
        controller.abort()
        return { ok: true, value: undefined }
      }

      if (!discoveryScheduler.hasPending(rawId))
        throw new Error('The selected discovery is no longer running.')
      if (!discoveryScheduler.remove(rawId))
        throw new Error('The selected discovery is no longer running.')
      try {
        await mutateItem(rawId, (draft) => {
          if (draft.status !== 'discovering') {
            throw new Error('The selected discovery is no longer running.')
          }
          transitionQueueItem(draft, 'cancelled')
          draft.error = ''
          draft.progress = null
          draft.updatedAt = new Date().toISOString()
        })
      } catch (error) {
        discoveryScheduler.enqueue(rawId)
        throw error
      }
      browserAssistedDiscoveries.delete(rawId)
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'discovery-queue:remove',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid discovery queue item.'
      )
    ]),
    async (_event, rawId) => {
      const index = discoveryQueue.findIndex(
        (candidate) => candidate.id === rawId
      )
      if (index < 0)
        throw new Error('The selected discovery queue item no longer exists.')
      if (
        ['discovering', 'queued', 'downloading', 'paused'].includes(
          discoveryQueue[index].status
        )
      ) {
        throw new Error(
          'Finish or cancel the active work before removing this item.'
        )
      }
      await archiveRemovedJobs([discoveryQueue[index]])
      const [removedItem] = discoveryQueue.splice(index, 1)
      await persistDiscoveryQueueOrRollback(() => {
        discoveryQueue.splice(index, 0, removedItem)
      })
      clearDirtyChapterData(removedItem.id)
      await removeChapterArtifacts(dataDirectory(), removedItem.id).catch(
        (error: unknown) => {
          console.warn(
            `Stored data for removed queue item ${removedItem.id} could not be removed:`,
            errorMessage(error)
          )
        }
      )
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc('discovery-queue:clear', z.tuple([]), async () => {
    if (
      discoveryQueue.some((item) =>
        ['discovering', 'queued', 'downloading', 'paused'].includes(item.status)
      )
    ) {
      throw new Error('Finish or cancel active work before clearing the queue.')
    }
    const previousQueue = [...discoveryQueue]
    await archiveRemovedJobs(previousQueue)
    discoveryQueue.splice(0, discoveryQueue.length)
    await persistDiscoveryQueueOrRollback(() => {
      discoveryQueue.splice(0, discoveryQueue.length, ...previousQueue)
    })
    for (const item of previousQueue) {
      clearDirtyChapterData(item.id)
      await removeChapterArtifacts(dataDirectory(), item.id).catch(
        (error: unknown) => {
          console.warn(
            `Stored data for cleared queue item ${item.id} could not be removed:`,
            errorMessage(error)
          )
        }
      )
    }
    notifyDiscoveryQueueChanged()
    return { ok: true, value: undefined }
  })

  handleValidatedResultIpc(
    'discovery-queue:clear-completed',
    z.tuple([]),
    async () => {
      const completedItems = discoveryQueue.filter(
        (item) => item.status === 'completed'
      )
      if (completedItems.length === 0) return { ok: true, value: undefined }
      const previousQueue = [...discoveryQueue]
      await archiveRemovedJobs(completedItems)
      discoveryQueue.splice(
        0,
        discoveryQueue.length,
        ...discoveryQueue.filter((item) => item.status !== 'completed')
      )
      await persistDiscoveryQueueOrRollback(() => {
        discoveryQueue.splice(0, discoveryQueue.length, ...previousQueue)
      })
      for (const item of completedItems) {
        clearDirtyChapterData(item.id)
        await removeChapterArtifacts(dataDirectory(), item.id).catch(
          (error: unknown) => {
            console.warn(
              `Stored data for completed queue item ${item.id} could not be removed:`,
              errorMessage(error)
            )
          }
        )
      }
      notifyDiscoveryQueueChanged()
      return { ok: true, value: undefined }
    }
  )

  handleResultIpc(
    'discovery-queue:update-selection',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid chapter selection update.'
      ),
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
      const item = discoveryQueue.find((candidate) => candidate.id === id)
      if (
        !item ||
        (item.status !== 'needs-review' && item.status !== 'ready')
      ) {
        throw new Error(
          'The selected discovery queue item is no longer ready for review.'
        )
      }
      await withChapters(item, async () => {
        const selectedChapterIds = resolveChapterSelection(
          item.chapters,
          selectionUpdate,
          MAX_SELECTED_CHAPTERS
        )
        const availableChapterIds = new Set(
          item.chapters.map((chapter) => chapter.id)
        )
        if (
          [...selectedChapterIds].some(
            (chapterId) => !availableChapterIds.has(chapterId)
          )
        ) {
          throw new Error(
            'The chapter selection no longer matches the saved discovery snapshot.'
          )
        }
        const previousSelectedChapterIds = item.chapters
          .filter((chapter) => chapter.selected)
          .map((chapter) => chapter.id)
        await mutateItem(
          item.id,
          (draft) => {
            for (const chapter of draft.chapters)
              chapter.selected = selectedChapterIds.has(chapter.id)
            updateQueueChapterSummary(draft)
            transitionQueueItem(draft, 'ready')
            draft.updatedAt = new Date().toISOString()
          },
          {
            selectionUpdate: {
              id: item.id,
              selectedChapterIds: [...selectedChapterIds],
              previousSelectedChapterIds
            }
          }
        )
      })
      notifyDiscoveryQueueChanged()
    }
  )

  handleValidatedResultIpc(
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
    async (_event, queueItemId, overrides) => {
      let previousItem: DiscoveryQueueItem | null = null
      let queueMutated = false
      let historyId = ''
      try {
        const item = discoveryQueue.find(
          (candidate) => candidate.id === queueItemId
        )
        if (!item) {
          throw new Error('The selected discovery queue item no longer exists.')
        }
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
        const settings = await readSettings(dataDirectory())
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
          omitHttp404Chapters: settings.omitHttp404Chapters
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
        void downloadScheduler.request().catch((error: unknown) => {
          console.error('Download queue scheduler failed:', error)
        })
        return {
          ok: true,
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
        return { ok: false, error: errorMessage(error) }
      }
    }
  )

  handleValidatedResultIpc(
    'download-queue:retry',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions) {
        throw new Error('This item has no saved EPUB job to retry.')
      }
      if (
        item.status !== 'failed' &&
        item.status !== 'partially-completed' &&
        item.status !== 'cancelled'
      ) {
        throw new Error(
          'Only failed, partially completed, or cancelled jobs can be retried.'
        )
      }
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled')
      ) {
        throw new Error('The EPUB job changed before it could be retried.')
      }
      const selectedChapters = await withChapters(item, (loadedItem) =>
        loadedItem.chapters
          .filter((chapter) => chapter.selected)
          .map((chapter) => ({ ...chapter }))
      )
      if (selectedChapters.length === 0)
        throw new Error(
          'Select at least one chapter before retrying this EPUB.'
        )
      const outputPath = expectedOutputPath(
        item.downloadOptions.outputDirectory,
        item.downloadOptions.title,
        item.downloadOptions.filename,
        selectedChapters
      )
      assertOutputPathAvailable(discoveryQueue, outputPath, item.id)
      await mutateItem(item.id, (draft) => {
        if (
          draft.status !== 'failed' &&
          draft.status !== 'partially-completed' &&
          draft.status !== 'cancelled'
        ) {
          throw new Error(
            'Only failed, partially completed, or cancelled jobs can be retried.'
          )
        }
        draft.targetOutputPath = outputPath
        draft.sequence = queueStore.nextSequence()
        transitionQueueItem(draft, 'queued')
        draft.repackageOnly = false
        draft.saveAvailableChaptersOnly = false
        draft.queuedAt = new Date().toISOString()
        draft.error = ''
        draft.progress = {
          current: item.progress?.current ?? 0,
          total: draft.chapterSummary.selected,
          message: 'Queued for retry'
        }
        draft.updatedAt = new Date().toISOString()
      })
      notifyDiscoveryQueueChanged()
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:recover',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || item.status !== 'failed') {
        throw new Error('Only failed queue items can be recovered.')
      }

      if (!item.downloadOptions) {
        if (!item.sourceUrl)
          throw new Error('This item has no saved source URL to rediscover.')
        await mutateItem(item.id, (draft) => {
          if (draft.status !== 'failed' || draft.downloadOptions) {
            throw new Error('Only failed discovery items can be recovered.')
          }
          transitionQueueItem(draft, 'discovering')
          draft.error = ''
          draft.progress = null
          draft.updatedAt = new Date().toISOString()
        })
        notifyDiscoveryQueueChanged()
        discoveryScheduler.enqueue(item.id)
        return { ok: true, value: undefined }
      }

      const selectedChapters = await withChapters(item, (loadedItem) =>
        loadedItem.chapters
          .filter((chapter) => chapter.selected)
          .map((chapter) => ({ ...chapter }))
      )
      if (selectedChapters.length === 0)
        throw new Error(
          'Select at least one chapter before retrying this EPUB.'
        )
      const outputPath = expectedOutputPath(
        item.downloadOptions.outputDirectory,
        item.downloadOptions.title,
        item.downloadOptions.filename,
        selectedChapters
      )
      assertOutputPathAvailable(discoveryQueue, outputPath, item.id)
      await mutateItem(item.id, (draft) => {
        if (draft.status !== 'failed') {
          throw new Error('Only failed queue items can be recovered.')
        }
        draft.targetOutputPath = outputPath
        draft.sequence = queueStore.nextSequence()
        transitionQueueItem(draft, 'queued')
        draft.repackageOnly = false
        draft.saveAvailableChaptersOnly = false
        draft.queuedAt ||= new Date().toISOString()
        draft.error = ''
        draft.progress = {
          current: draft.progress?.current ?? 0,
          total: draft.chapterSummary.selected,
          message: 'Recovered and queued for download'
        }
        draft.updatedAt = new Date().toISOString()
      })
      notifyDiscoveryQueueChanged()
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:repackage',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions) {
        throw new Error('This item has no saved EPUB job to repackage.')
      }
      if (
        item.status !== 'failed' &&
        item.status !== 'partially-completed' &&
        item.status !== 'cancelled' &&
        item.status !== 'packaging-failed'
      ) {
        throw new Error(
          'Only failed, partially completed, cancelled, or packaging-failed jobs can be repackaged.'
        )
      }
      const selectedChapters = await withChapters(item, (loadedItem) =>
        loadedItem.chapters
          .filter((chapter) => chapter.selected)
          .map((chapter) => ({ ...chapter }))
      )
      if (selectedChapters.length === 0)
        throw new Error('Select at least one saved chapter before repackaging.')
      const outputPath = expectedOutputPath(
        item.downloadOptions.outputDirectory,
        item.downloadOptions.title,
        item.downloadOptions.filename,
        selectedChapters
      )
      assertOutputPathAvailable(discoveryQueue, outputPath, item.id)
      for (const chapter of selectedChapters) {
        const content = await readChapterArtifact(
          dataDirectory(),
          item.id,
          chapter.url
        )
        if (!content || content.url !== chapter.url) {
          throw new Error(
            `Saved chapter content is missing or invalid for "${chapter.title}".`
          )
        }
      }
      if (
        item.downloadOptions.coverUrl &&
        !(await readCoverArtifact(dataDirectory(), item.id))
      ) {
        throw new Error(
          'Saved cover content is missing; retry this EPUB online before repackaging.'
        )
      }

      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled' &&
          item.status !== 'packaging-failed')
      ) {
        throw new Error('The EPUB job changed before it could be repackaged.')
      }

      item.repackageOnly = true
      item.saveAvailableChaptersOnly = false
      item.targetOutputPath = outputPath
      item.sequence = queueStore.nextSequence()
      transitionQueueItem(item, 'queued')
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.failedChapters = []
      item.progress = {
        current: selectedChapters.length,
        total: selectedChapters.length,
        message: 'Queued for offline repackaging'
      }
      await persistDownloadState(item)
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:save-available',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions) {
        throw new Error('This item has no saved EPUB job to partially save.')
      }
      if (
        item.status !== 'failed' &&
        item.status !== 'partially-completed' &&
        item.status !== 'cancelled'
      ) {
        throw new Error(
          'Only failed, partially completed, or cancelled jobs can save available chapters.'
        )
      }
      const selectedChapters = await withChapters(item, (loadedItem) =>
        loadedItem.chapters
          .filter((chapter) => chapter.selected)
          .map((chapter) => ({ ...chapter }))
      )
      if (selectedChapters.length === 0)
        throw new Error(
          'Select at least one saved chapter before saving available chapters.'
        )
      const outputPath = expectedOutputPath(
        item.downloadOptions.outputDirectory,
        item.downloadOptions.title,
        item.downloadOptions.filename,
        selectedChapters
      )
      assertOutputPathAvailable(discoveryQueue, outputPath, item.id)

      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'failed' &&
          item.status !== 'partially-completed' &&
          item.status !== 'cancelled')
      ) {
        throw new Error(
          'The EPUB job changed before available chapters could be saved.'
        )
      }

      item.repackageOnly = true
      item.saveAvailableChaptersOnly = true
      item.targetOutputPath = outputPath
      item.sequence = queueStore.nextSequence()
      transitionQueueItem(item, 'queued')
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.progress = {
        current: Math.min(item.progress?.current ?? 0, selectedChapters.length),
        total: selectedChapters.length,
        message: 'Queued to save available chapters'
      }
      await persistDownloadState(item)
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:move',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid queue reorder request.'
      ),
      z.custom<'up' | 'down' | 'top' | 'bottom'>(
        (value): value is 'up' | 'down' | 'top' | 'bottom' =>
          value === 'up' ||
          value === 'down' ||
          value === 'top' ||
          value === 'bottom',
        'Invalid queue reorder request.'
      )
    ]),
    async (_event, rawId, rawDirection) => {
      const queuedItems = discoveryQueue
        .filter((item) => item.status === 'queued' && item.downloadOptions)
        .sort(
          (left, right) =>
            left.sequence - right.sequence || left.id.localeCompare(right.id)
        )
      const index = queuedItems.findIndex((item) => item.id === rawId)
      if (index < 0) throw new Error('Only queued EPUB jobs can be reordered.')
      const targetIndex =
        rawDirection === 'top'
          ? 0
          : rawDirection === 'bottom'
            ? queuedItems.length - 1
            : index + (rawDirection === 'up' ? -1 : 1)
      if (
        targetIndex < 0 ||
        targetIndex >= queuedItems.length ||
        targetIndex === index
      ) {
        return { ok: true, value: undefined }
      }
      const oldTimes = new Map(
        queuedItems.map((item) => [
          item.id,
          {
            queuedAt: item.queuedAt,
            updatedAt: item.updatedAt,
            sequence: item.sequence
          }
        ])
      )
      const movingItem = queuedItems[index]
      if (!movingItem)
        throw new Error(
          'The queue order changed before the job could be moved.'
        )
      queuedItems.splice(index, 1)
      queuedItems.splice(targetIndex, 0, movingItem)
      queueStore.resequence(queuedItems)
      const now = Date.now()
      queuedItems.forEach((item, position) => {
        item.queuedAt = new Date(now + position).toISOString()
        item.updatedAt = new Date().toISOString()
      })
      await persistDiscoveryQueueOrRollback(() => {
        for (const item of queuedItems) {
          const previous = oldTimes.get(item.id)
          if (previous) {
            item.queuedAt = previous.queuedAt
            item.updatedAt = previous.updatedAt
            item.sequence = previous.sequence
          }
        }
      })
      notifyDiscoveryQueueChanged()
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:pause',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions)
        throw new Error('The selected item has no active EPUB job.')
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'queued' && item.status !== 'downloading')
      ) {
        throw new Error('The EPUB job changed before it could be paused.')
      }
      if (item.status === 'queued') {
        transitionQueueItem(item, 'paused')
        item.progress = {
          ...(item.progress ?? { current: 0, total: 0, message: '' }),
          message: 'Paused'
        }
        await persistDownloadState(item)
        return { ok: true, value: undefined }
      }
      const active = activeDownloads.get(item.id)
      if (item.status !== 'downloading' || !active)
        throw new Error('Only queued or downloading jobs can be paused.')
      active.requestedAction = 'pause'
      active.controller.abort()
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:resume',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || item.status !== 'paused' || !item.downloadOptions) {
        throw new Error('Only paused EPUB jobs can be resumed.')
      }
      if (!discoveryQueue.includes(item) || item.status !== 'paused') {
        throw new Error('The EPUB job changed before it could be resumed.')
      }
      item.sequence = queueStore.nextSequence()
      transitionQueueItem(item, 'queued')
      item.queuedAt = new Date().toISOString()
      item.error = ''
      item.progress = {
        current: item.progress?.current ?? 0,
        total: item.chapterSummary.selected,
        message: 'Queued to resume'
      }
      await persistDownloadState(item)
      void downloadScheduler.request().catch((error: unknown) => {
        console.error('Download queue scheduler failed:', error)
      })
      return { ok: true, value: undefined }
    }
  )

  handleValidatedResultIpc(
    'download-queue:cancel',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid download queue item.'
      )
    ]),
    async (_event, rawId) => {
      const item = discoveryQueue.find((candidate) => candidate.id === rawId)
      if (!item || !item.downloadOptions)
        throw new Error('The selected item has no active EPUB job.')
      if (
        !discoveryQueue.includes(item) ||
        (item.status !== 'queued' &&
          item.status !== 'paused' &&
          item.status !== 'downloading')
      ) {
        throw new Error('The EPUB job changed before it could be cancelled.')
      }
      if (item.status === 'queued' || item.status === 'paused') {
        transitionQueueItem(item, 'cancelled')
        item.progress = {
          ...(item.progress ?? { current: 0, total: 0, message: '' }),
          message: 'Cancelled'
        }
        await persistDownloadState(item)
        return { ok: true, value: undefined }
      }
      const active = activeDownloads.get(item.id)
      if (item.status !== 'downloading' || !active) {
        throw new Error(
          'Only queued, paused, or downloading jobs can be cancelled.'
        )
      }
      active.requestedAction = 'cancel'
      active.controller.abort()
      return { ok: true, value: undefined }
    }
  )
}
