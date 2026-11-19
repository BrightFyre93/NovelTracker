import type { DiscoveryQueueItem } from '../../../shared/contracts'
import type { IpcContext } from '../../ipc/context'
import {
  chapterArtifactIsUsable,
  chapterArtifactReference
} from '../localStore'
import { createQueueSubmissionCommand } from './queueSubmission'

export type QueueCommandContext = Pick<
  IpcContext,
  | 'assertOutputPathAvailable'
  | 'chapterStateRepository'
  | 'activeDownloads'
  | 'activeQueueDiscoveries'
  | 'archiveRemovedJobs'
  | 'browserAssistedDiscoveries'
  | 'clearDirtyChapterData'
  | 'copyQueueItem'
  | 'createQueueItem'
  | 'dataDirectory'
  | 'discoveryQueue'
  | 'discoveryScheduler'
  | 'downloadScheduler'
  | 'expectedOutputPath'
  | 'errorMessage'
  | 'libraryIndexRepository'
  | 'markQueueItemChaptersDirty'
  | 'mutateItem'
  | 'notifyDiscoveryQueueChanged'
  | 'MAX_SELECTED_CHAPTERS'
  | 'recommendArchiveCoverage'
  | 'removeChapterArtifacts'
  | 'resolveChapterSelection'
  | 'parseGenerateInput'
  | 'parseDiscoveryQueueInputs'
  | 'persistDiscoveryQueue'
  | 'persistDiscoveryQueueOrRollback'
  | 'persistDownloadState'
  | 'queueStore'
  | 'settingsService'
  | 'siteExtractionModeForUrl'
  | 'transitionQueueItem'
  | 'updateQueueChapterSummary'
  | 'withChapters'
>

export function createQueueCommands(context: QueueCommandContext) {
  const {
    assertOutputPathAvailable,
    chapterStateRepository,
    dataDirectory,
    discoveryQueue,
    discoveryScheduler,
    downloadScheduler,
    expectedOutputPath,
    mutateItem,
    notifyDiscoveryQueueChanged,
    persistDiscoveryQueueOrRollback,
    persistDownloadState,
    queueStore,
    transitionQueueItem,
    withChapters
  } = context

  async function prepareSelectedJob(
    item: DiscoveryQueueItem,
    emptySelectionMessage: string
  ) {
    if (!item.downloadOptions)
      throw new Error('This item has no saved EPUB job to queue.')
    const selectedChapters = await withChapters(item, (loadedItem) =>
      loadedItem.chapters
        .filter((chapter) => chapter.selected)
        .map((chapter) => ({ ...chapter }))
    )
    if (selectedChapters.length === 0) throw new Error(emptySelectionMessage)
    const options = item.downloadOptions
    const outputPath = expectedOutputPath(
      options.outputDirectory,
      options.title,
      options.filename,
      selectedChapters
    )
    assertOutputPathAvailable(discoveryQueue, outputPath, item.id)
    return { selectedChapters, outputPath }
  }

  async function validateOfflineChapterArtifacts(
    item: DiscoveryQueueItem,
    chapters: DiscoveryQueueItem['chapters'],
    allowMissing: boolean
  ): Promise<void> {
    const states = await chapterStateRepository.readChapterStates(item.id)
    const statesById = new Map(states.map((state) => [state.chapterId, state]))
    const invalidStates: string[] = []
    const missingFiles: (typeof states)[number][] = []

    for (let offset = 0; offset < chapters.length; offset += 100) {
      const batch = chapters.slice(offset, offset + 100)
      const results = await Promise.all(
        batch.map(async (chapter) => {
          const state = statesById.get(chapter.id)
          if (
            state?.state !== 'Downloaded' ||
            state.currentUrl !== chapter.url ||
            state.artifactRef !== chapterArtifactReference(item.id, chapter.url)
          ) {
            return { chapter, state, stateValid: false, fileExists: false }
          }
          return {
            chapter,
            state,
            stateValid: true,
            fileExists: await chapterArtifactIsUsable(
              dataDirectory(),
              item.id,
              chapter.url
            )
          }
        })
      )
      for (const result of results) {
        if (!result.stateValid || !result.state) {
          invalidStates.push(result.chapter.title)
        } else if (!result.fileExists) {
          missingFiles.push({
            ...result.state,
            state: 'InvalidArtifact',
            updatedAt: new Date().toISOString(),
            lastError: `Saved chapter content is missing or damaged for "${result.chapter.title}".`,
            artifactRef: null
          })
        }
      }
    }

    if (missingFiles.length > 0) {
      await chapterStateRepository.writeChapterStates(item.id, missingFiles)
    }
    if (!allowMissing && (invalidStates.length > 0 || missingFiles.length > 0)) {
      const problems: string[] = []
      if (invalidStates.length > 0) {
        const examples = invalidStates.slice(0, 3).join(', ')
        const remaining =
          invalidStates.length > 3
            ? ` and ${invalidStates.length - 3} more`
            : ''
        problems.push(
          `${invalidStates.length} selected chapter(s) are not marked as downloaded${examples ? ` (${examples}${remaining})` : ''}`
        )
      }
      if (missingFiles.length > 0) {
        problems.push(
          `${missingFiles.length} saved chapter file(s) are missing or damaged`
        )
      }
      throw new Error(
        `${problems.join('; ')}. Use Retry to download them again before repackaging.`
      )
    }
  }

  function requestDownloadQueueDrain(): void {
    void downloadScheduler.request().catch((error: unknown) => {
      console.error('Download queue scheduler failed:', error)
    })
  }

  const enqueueFromSnapshot = createQueueSubmissionCommand({
    ...context,
    requestDownloadQueueDrain
  })
  async function moveDownloadJob(
    rawId: string,
    direction: 'up' | 'down' | 'top' | 'bottom'
  ): Promise<void> {
    const queuedItems = discoveryQueue
      .filter((item) => item.status === 'queued' && item.downloadOptions)
      .sort(
        (left, right) =>
          left.sequence - right.sequence || left.id.localeCompare(right.id)
      )
    const index = queuedItems.findIndex((item) => item.id === rawId)
    if (index < 0) throw new Error('Only queued EPUB jobs can be reordered.')
    const targetIndex =
      direction === 'top'
        ? 0
        : direction === 'bottom'
          ? queuedItems.length - 1
          : index + (direction === 'up' ? -1 : 1)
    if (
      targetIndex < 0 ||
      targetIndex >= queuedItems.length ||
      targetIndex === index
    )
      return
    const oldSequences = new Map(
      queuedItems.map((item) => [item.id, item.sequence])
    )
    const movingItem = queuedItems[index]
    if (!movingItem)
      throw new Error('The queue order changed before the job could be moved.')
    queuedItems.splice(index, 1)
    queuedItems.splice(targetIndex, 0, movingItem)
    queueStore.resequence(queuedItems)
    await persistDiscoveryQueueOrRollback(() => {
      for (const item of queuedItems) {
        const previousSequence = oldSequences.get(item.id)
        if (previousSequence !== undefined) item.sequence = previousSequence
      }
    })
    notifyDiscoveryQueueChanged()
    requestDownloadQueueDrain()
  }

  async function pauseDownloadJob(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || !item.downloadOptions)
      throw new Error('The selected item has no active EPUB job.')
    if (
      !discoveryQueue.includes(item) ||
      (item.status !== 'queued' && item.status !== 'downloading')
    )
      throw new Error('The EPUB job changed before it could be paused.')
    if (item.status === 'queued') {
      transitionQueueItem(item, 'paused')
      item.progress = {
        ...(item.progress ?? { current: 0, total: 0, message: '' }),
        message: 'Paused'
      }
      await persistDownloadState(item)
      return
    }
    const active = context.activeDownloads.get(item.id)
    if (item.status !== 'downloading' || !active)
      throw new Error('Only queued or downloading jobs can be paused.')
    active.requestedAction = 'pause'
    active.controller.abort()
  }

  async function resumeDownloadJob(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || item.status !== 'paused' || !item.downloadOptions)
      throw new Error('Only paused EPUB jobs can be resumed.')
    if (!discoveryQueue.includes(item) || item.status !== 'paused')
      throw new Error('The EPUB job changed before it could be resumed.')
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
    requestDownloadQueueDrain()
  }

  async function cancelDownloadJob(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || !item.downloadOptions)
      throw new Error('The selected item has no active EPUB job.')
    if (
      !discoveryQueue.includes(item) ||
      (item.status !== 'queued' &&
        item.status !== 'paused' &&
        item.status !== 'downloading')
    )
      throw new Error('The EPUB job changed before it could be cancelled.')
    if (item.status === 'queued' || item.status === 'paused') {
      transitionQueueItem(item, 'cancelled')
      item.progress = {
        ...(item.progress ?? { current: 0, total: 0, message: '' }),
        message: 'Cancelled'
      }
      await persistDownloadState(item)
      return
    }
    const active = context.activeDownloads.get(item.id)
    if (item.status !== 'downloading' || !active) {
      throw new Error(
        'Only queued, paused, or downloading jobs can be cancelled.'
      )
    }
    active.requestedAction = 'cancel'
    active.controller.abort()
  }

  async function retry(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || !item.downloadOptions)
      throw new Error('This item has no saved EPUB job to retry.')
    const canRetry = (status: DiscoveryQueueItem['status']): boolean =>
      status === 'failed' ||
      status === 'partially-completed' ||
      status === 'cancelled' ||
      status === 'packaging-failed'
    if (!canRetry(item.status))
      throw new Error(
        'Only failed, partially completed, cancelled, or packaging-failed jobs can be retried.'
      )
    if (!discoveryQueue.includes(item) || !canRetry(item.status))
      throw new Error('The EPUB job changed before it could be retried.')
    const { outputPath } = await prepareSelectedJob(
      item,
      'Select at least one chapter before retrying this EPUB.'
    )
    await mutateItem(item.id, (draft) => {
      if (!canRetry(draft.status))
        throw new Error(
          'Only failed, partially completed, cancelled, or packaging-failed jobs can be retried.'
        )
      draft.targetOutputPath = outputPath
      draft.sequence = queueStore.nextSequence()
      transitionQueueItem(draft, 'queued')
      draft.repackageOnly = false
      draft.saveAvailableChaptersOnly = false
      // Chapters may be downloaded again, so earlier volumes must be rebuilt.
      draft.outputPaths = []
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
    requestDownloadQueueDrain()
  }

  async function recover(rawId: string): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || item.status !== 'failed')
      throw new Error('Only failed queue items can be recovered.')
    if (!item.downloadOptions) {
      if (!item.sourceUrl)
        throw new Error('This item has no saved source URL to rediscover.')
      await mutateItem(item.id, (draft) => {
        if (draft.status !== 'failed' || draft.downloadOptions)
          throw new Error('Only failed discovery items can be recovered.')
        transitionQueueItem(draft, 'discovering')
        draft.error = ''
        draft.progress = null
        draft.updatedAt = new Date().toISOString()
      })
      notifyDiscoveryQueueChanged()
      discoveryScheduler.enqueue(item.id)
      return
    }
    const { outputPath } = await prepareSelectedJob(
      item,
      'Select at least one chapter before retrying this EPUB.'
    )
    await mutateItem(item.id, (draft) => {
      if (draft.status !== 'failed')
        throw new Error('Only failed queue items can be recovered.')
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
    requestDownloadQueueDrain()
  }

  async function queueOfflineJob(
    rawId: string,
    saveAvailableOnly: boolean
  ): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === rawId)
    if (!item || !item.downloadOptions) {
      throw new Error(
        saveAvailableOnly
          ? 'This item has no saved EPUB job to partially save.'
          : 'This item has no saved EPUB job to repackage.'
      )
    }
    const canQueue = (status: DiscoveryQueueItem['status']): boolean =>
      status === 'failed' ||
      status === 'partially-completed' ||
      status === 'cancelled' ||
      (!saveAvailableOnly && status === 'packaging-failed')
    if (!canQueue(item.status)) {
      throw new Error(
        saveAvailableOnly
          ? 'Only failed, partially completed, or cancelled jobs can save available chapters.'
          : 'Only failed, partially completed, cancelled, or packaging-failed jobs can be repackaged.'
      )
    }
    const { selectedChapters, outputPath } = await prepareSelectedJob(
      item,
      saveAvailableOnly
        ? 'Select at least one saved chapter before saving available chapters.'
        : 'Select at least one saved chapter before repackaging.'
    )
    await validateOfflineChapterArtifacts(
      item,
      selectedChapters,
      saveAvailableOnly
    )
    if (!discoveryQueue.includes(item) || !canQueue(item.status)) {
      throw new Error(
        saveAvailableOnly
          ? 'The EPUB job changed before available chapters could be saved.'
          : 'The EPUB job changed before it could be repackaged.'
      )
    }
    await mutateItem(item.id, (draft) => {
      if (!canQueue(draft.status)) {
        throw new Error(
          saveAvailableOnly
            ? 'The EPUB job changed before available chapters could be saved.'
            : 'The EPUB job changed before it could be repackaged.'
        )
      }
      draft.repackageOnly = true
      draft.saveAvailableChaptersOnly = saveAvailableOnly
      draft.targetOutputPath = outputPath
      draft.sequence = queueStore.nextSequence()
      transitionQueueItem(draft, 'queued')
      draft.queuedAt = new Date().toISOString()
      draft.error = ''
      if (!saveAvailableOnly) draft.failedChapters = []
      draft.progress = {
        current: saveAvailableOnly
          ? Math.min(draft.progress?.current ?? 0, selectedChapters.length)
          : selectedChapters.length,
        total: selectedChapters.length,
        message: saveAvailableOnly
          ? 'Queued to save available chapters'
          : 'Queued for offline repackaging'
      }
      draft.updatedAt = new Date().toISOString()
    })
    notifyDiscoveryQueueChanged()
    requestDownloadQueueDrain()
  }

  return {
    cancelDownloadJob,
    moveDownloadJob,
    pauseDownloadJob,
    enqueueFromSnapshot,
    requestDrain: requestDownloadQueueDrain,
    retry,
    recover,
    repackage: (rawId: string) => queueOfflineJob(rawId, false),
    resumeDownloadJob,
    saveAvailable: (rawId: string) => queueOfflineJob(rawId, true)
  }
}
