import type {
  ChapterSelectionUpdate,
  DiscoveryQueueItem,
  DiscoveryQueueInput
} from '../../../shared/contracts'
import type { QueueCommandContext } from './queueCommands'
import { parseChapterNumber } from '../../../shared/chapterNumber'
import {
  formatDownloadSyncText,
  slugFromSourceUrl,
  type DownloadSyncRow,
  type DownloadSyncText
} from '../../../shared/downloadSyncText'
import { parseFilenameRange } from '../../../shared/filenameRange'
import { isActiveQueueStatus } from './queueStateMachine'
import { removeJobDiagnostic } from '../jobDiagnostics'

export function createDiscoveryQueueCommands(context: QueueCommandContext) {
  const {
    activeQueueDiscoveries,
    archiveRemovedJobs,
    browserAssistedDiscoveries,
    clearDirtyChapterData,
    createQueueItem,
    dataDirectory,
    discoveryQueue,
    discoveryScheduler,
    errorMessage,
    libraryIndexRepository,
    markQueueItemChaptersDirty,
    MAX_SELECTED_CHAPTERS,
    mutateItem,
    notifyDiscoveryQueueChanged,
    recommendArchiveCoverage,
    removeChapterArtifacts,
    resolveChapterSelection,
    parseDiscoveryQueueInputs,
    persistDiscoveryQueue,
    persistDiscoveryQueueOrRollback,
    queueStore,
    settingsService,
    siteExtractionModeForUrl,
    transitionQueueItem,
    updateQueueChapterSummary,
    withChapters
  } = context
  async function addDiscoveryItems(
    rawItems: DiscoveryQueueInput[]
  ): Promise<DiscoveryQueueItem[]> {
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

  async function retryDiscovery(rawId: string, browserAssisted = false) {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item)
      throw new Error('The selected discovery queue item no longer exists.')
    const allowed = (candidate: DiscoveryQueueItem): boolean =>
      (candidate.status === 'failed' || candidate.status === 'cancelled') &&
      !candidate.downloadOptions
    if (!allowed(item)) {
      throw new Error(
        browserAssisted
          ? 'Only failed or cancelled discovery items can be retried with the browser.'
          : 'Only failed or cancelled discovery items can be retried.'
      )
    }
    await mutateItem(item.id, (draft) => {
      if (!allowed(draft)) {
        throw new Error(
          browserAssisted
            ? 'Only failed or cancelled discovery items can be retried with the browser.'
            : 'Only failed or cancelled discovery items can be retried.'
        )
      }
      transitionQueueItem(draft, 'discovering')
      draft.error = ''
      draft.updatedAt = new Date().toISOString()
    })
    if (browserAssisted) browserAssistedDiscoveries.add(item.id)
    notifyDiscoveryQueueChanged()
    discoveryScheduler.enqueue(item.id)
  }

  async function retryFailedDiscoveries(): Promise<number> {
    const failedItems = discoveryQueue.filter(
      (item) => item.status === 'failed' && !item.downloadOptions
    )
    if (failedItems.length === 0) return 0
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
    return failedItems.length
  }

  async function forceRetryDiscovery(rawId: string): Promise<void> {
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
      if (activeQueueDiscoveries.get(item.id) === supersedingController)
        activeQueueDiscoveries.delete(item.id)
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
  }

  async function refreshDiscovery(
    rawId: string,
    parserMode?: 'automatic' | 'generic-html' | 'novelfull'
  ): Promise<void> {
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
    const settings = await settingsService.get()
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
  }

  async function acceptRecommendations(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || (item.status !== 'needs-review' && item.status !== 'ready')) {
      throw new Error('The selected item is not ready for recommendations.')
    }
    await withChapters(item, async () => {
      const libraryFiles =
        await libraryIndexRepository.readRecommendationFiles(item)
      const recommendation = recommendArchiveCoverage(item, libraryFiles ?? [])
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
  }

  async function cancelDiscovery(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || item.status !== 'discovering')
      throw new Error('The selected discovery is no longer running.')
    const controller = activeQueueDiscoveries.get(rawId)
    if (controller) {
      controller.abort()
      return
    }
    if (!discoveryScheduler.hasPending(rawId))
      throw new Error('The selected discovery is no longer running.')
    if (!discoveryScheduler.remove(rawId))
      throw new Error('The selected discovery is no longer running.')
    try {
      await mutateItem(rawId, (draft) => {
        if (draft.status !== 'discovering')
          throw new Error('The selected discovery is no longer running.')
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
  }

  async function removeQueueItem(rawId: string): Promise<void> {
    const index = discoveryQueue.findIndex(
      (candidate) => candidate.id === rawId
    )
    if (index < 0)
      throw new Error('The selected discovery queue item no longer exists.')
    const item = discoveryQueue[index]
    if (!item)
      throw new Error('The selected discovery queue item no longer exists.')
    if (isActiveQueueStatus(item.status)) {
      throw new Error(
        'Finish or cancel the active work before removing this item.'
      )
    }
    await archiveRemovedJobs([item])
    const [removedItem] = discoveryQueue.splice(index, 1)
    if (!removedItem) return
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
    await removeJobDiagnostic(dataDirectory(), removedItem.id).catch(
      (error: unknown) =>
        console.warn(
          `Diagnostic for removed queue item ${removedItem.id} could not be removed:`,
          errorMessage(error)
        )
    )
    notifyDiscoveryQueueChanged()
  }

  async function clearQueue(): Promise<void> {
    if (discoveryQueue.some((item) => isActiveQueueStatus(item.status))) {
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
      await removeJobDiagnostic(dataDirectory(), item.id).catch(
        (error: unknown) =>
          console.warn(
            `Diagnostic for cleared queue item ${item.id} could not be removed:`,
            errorMessage(error)
          )
      )
    }
    notifyDiscoveryQueueChanged()
  }

  async function clearCompletedQueue(): Promise<void> {
    const completedItems = discoveryQueue.filter(
      (item) => item.status === 'completed'
    )
    if (completedItems.length === 0) return
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
      await removeJobDiagnostic(dataDirectory(), item.id).catch(
        (error: unknown) =>
          console.warn(
            `Diagnostic for completed queue item ${item.id} could not be removed:`,
            errorMessage(error)
          )
      )
    }
    notifyDiscoveryQueueChanged()
  }

  async function updateChapterSelection(
    id: string,
    selectionUpdate: ChapterSelectionUpdate
  ): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === id)
    if (!item || (item.status !== 'needs-review' && item.status !== 'ready')) {
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

  /**
   * Builds the Android download sync text for completed jobs. Only the given
   * job ids are used (the renderer sends the ones its filter shows).
   */
  async function buildDownloadSyncText(ids: string[]): Promise<DownloadSyncText> {
    const wanted = new Set(ids)
    const rows: DownloadSyncRow[] = []
    let skippedCount = 0
    for (const item of discoveryQueue) {
      if (!wanted.has(item.id) || item.status !== 'completed') continue
      const failedUrls = new Set(item.failedChapters.map((chapter) => chapter.url))
      let downloaded = 0
      await withChapters(item, () => {
        for (const chapter of item.chapters) {
          if (!chapter.selected || failedUrls.has(chapter.url)) continue
          const number = parseChapterNumber(chapter.title)
          if (number !== null) downloaded = Math.max(downloaded, Math.floor(number))
        }
      })
      if (downloaded <= 0) {
        // Titles without chapter numbers: use the range in the EPUB file names.
        const names = [
          ...(item.outputPaths ?? []).map((output) => output.filename),
          item.targetOutputPath
        ]
        for (const name of names) {
          const range = name ? parseFilenameRange(name) : null
          if (range) downloaded = Math.max(downloaded, Math.floor(range.end))
        }
      }
      if (downloaded <= 0) {
        skippedCount += 1
        continue
      }
      rows.push({
        name: (item.downloadOptions?.title || item.title).trim(),
        downloaded,
        slug: slugFromSourceUrl(item.sourceUrl)
      })
    }
    return formatDownloadSyncText(rows, skippedCount)
  }

  function requireReviewItem(id: string): DiscoveryQueueItem {
    const item = discoveryQueue.find((candidate) => candidate.id === id)
    if (!item || (item.status !== 'needs-review' && item.status !== 'ready')) {
      throw new Error(
        'The selected discovery queue item is no longer ready for review.'
      )
    }
    return item
  }

  async function reverseChapterOrder(id: string): Promise<void> {
    const item = requireReviewItem(id)
    await withChapters(item, async () => {
      const libraryFiles =
        (await libraryIndexRepository.readRecommendationFiles(item)) ?? []
      await mutateItem(item.id, (draft) => {
        if (draft.status !== 'needs-review' && draft.status !== 'ready') {
          throw new Error(
            'The selected discovery queue item is no longer ready for review.'
          )
        }
        const reversed = [...draft.chapters].reverse()
        // Coverage and gaps depend on the order, so work them out again.
        const recommendation = recommendArchiveCoverage(
          { ...draft, chapters: reversed },
          libraryFiles
        )
        draft.chapters = recommendation.chapters
        draft.recommendationSummary = recommendation.summary
        draft.chapterOrderReversed = !draft.chapterOrderReversed
        updateQueueChapterSummary(draft)
        draft.updatedAt = new Date().toISOString()
      })
    })
    notifyDiscoveryQueueChanged()
  }

  async function updateChapterUrl(
    id: string,
    chapterId: string,
    rawUrl: string
  ): Promise<void> {
    let url: string
    try {
      const parsed = new URL(rawUrl.trim())
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol')
      }
      if (parsed.username || parsed.password) {
        throw new Error('credentials are not allowed')
      }
      url = parsed.toString()
    } catch {
      throw new Error('Enter a valid http or https chapter URL.')
    }
    if (url.length > 2048) throw new Error('The chapter URL is too long.')
    const item = requireReviewItem(id)
    await withChapters(item, async () => {
      await mutateItem(item.id, (draft) => {
        if (draft.status !== 'needs-review' && draft.status !== 'ready') {
          throw new Error(
            'The selected discovery queue item is no longer ready for review.'
          )
        }
        const chapter = draft.chapters.find(
          (candidate) => candidate.id === chapterId
        )
        if (!chapter) throw new Error('The selected chapter no longer exists.')
        if (chapter.url === url) return
        if (
          draft.chapters.some(
            (candidate) => candidate.id !== chapterId && candidate.url === url
          )
        ) {
          throw new Error('Another chapter already uses this URL.')
        }
        // Keep the originally discovered URL so a refresh can apply the edit.
        const edits = { ...(draft.chapterUrlEdits ?? {}) }
        const originalUrl =
          Object.keys(edits).find((key) => edits[key] === chapter.url) ??
          chapter.url
        if (originalUrl === url) delete edits[originalUrl]
        else edits[originalUrl] = url
        if (Object.keys(edits).length > 0) draft.chapterUrlEdits = edits
        else delete draft.chapterUrlEdits
        chapter.url = url
        draft.updatedAt = new Date().toISOString()
      })
    })
    notifyDiscoveryQueueChanged()
  }

  return {
    addDiscoveryItems,
    buildDownloadSyncText,
    reverseChapterOrder,
    updateChapterUrl,
    acceptRecommendations,
    cancelDiscovery,
    clearCompletedQueue,
    clearQueue,
    forceRetryDiscovery,
    refreshDiscovery,
    removeQueueItem,
    retryDiscovery,
    retryFailedDiscoveries,
    updateChapterSelection
  }
}
