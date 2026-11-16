import { statfs } from 'node:fs/promises'
import type {
  ChapterContent,
  ChapterLink,
  DiscoveryQueueItem,
  QueueChapter
} from '../../../shared/contracts'
import {
  MAX_SIMULTANEOUS_DOWNLOADS,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../../../shared/constants'
import { siteExtractionModeForUrl } from '../../../shared/siteExtractionPreferences'
import {
  HttpStatusError,
  NoReadableContentError,
  OperationCancelledError,
  TransientNetworkError,
  VerificationRequiredError
} from '../../../shared/errors'
import { recommendArchiveCoverage } from '../../../shared/archiveRecommendation'
import {
  fetchChapterContent,
  fetchChapterContentFromHtml,
  fetchImageResource,
  discoverChapters,
  discoverChaptersUsingPageLoader
} from '../scraper'
import { readBrowserPage } from '../browserService'
import {
  readChapterArtifact,
  readCoverArtifact,
  removeChapterArtifacts,
  writeChapterArtifact,
  writeCoverArtifact
} from '../localStore'
import { runPool, withRetry } from '../retry'
import type {
  EpubPackagingInput,
  EpubPackagingProgress,
  EpubPackagingResult
} from '../epubPackaging'
import type { SettingsService } from '../settingsService'
import type { QueueHelpers } from './helpers'
import { transitionQueueItem } from './queueStateMachine'
import { DiscoveryScheduler } from './discoveryScheduler'
import { DownloadScheduler } from './downloadScheduler'
import type { LibraryIndexRepository } from '../library/libraryIndexRepository'
import {
  assertOutputPathAvailable,
  discoveryQueueItemStatus,
  discoverySnapshotIsStale,
  expectedOutputPath,
  reserveIncompleteEpubFilename
} from './helpers'


export interface ActiveDownload {
  controller: AbortController
  requestedAction: 'none' | 'pause' | 'cancel' | 'shutdown'
}

interface QueueRuntimeDependencies {
  discoveryQueue: DiscoveryQueueItem[]
  browserAssistedDiscoveries: Set<string>
  activeBrowserDiscoveries: Map<string, AbortController>
  activeQueueDiscoveries: Map<string, AbortController>
  activeDownloads: Map<string, ActiveDownload>
  reservedOutputPaths: Set<string>
  dataDirectory: () => string
  packageEpub: (
    input: EpubPackagingInput,
    signal: AbortSignal,
    onProgress: (progress: EpubPackagingProgress) => void
  ) => Promise<EpubPackagingResult>
  settingsService: Pick<SettingsService, 'get' | 'current'>
  libraryIndexRepository: Pick<LibraryIndexRepository, 'read'>
  isShuttingDown: () => boolean
  queueHelpers: Pick<
    QueueHelpers,
    | 'markQueueItemChaptersDirty'
    | 'withChapters'
    | 'persistDiscoveryQueue'
  >
  notifyDiscoveryQueueChanged: () => void
  trackBackgroundTask: (task: Promise<void>, label: string) => void
  errorMessage: (error: unknown) => string
}

export interface QueueRuntime {
  discoverQueueItem: (
    id: string,
    browserAssisted?: boolean
  ) => Promise<boolean>
  discoveryScheduler: DiscoveryScheduler
  revalidateStaleQueuedJob: (
    item: DiscoveryQueueItem
  ) => Promise<boolean>
  canRetryChapter: (error: unknown) => boolean
  persistDownloadState: (
    item: DiscoveryQueueItem,
    checkpoint?: boolean
  ) => Promise<void>
  runQueuedDownload: (
    itemId: string,
    controller: AbortController,
    maxSimultaneousChapters: number
  ) => Promise<void>
  downloadScheduler: DownloadScheduler
}

export function createQueueRuntime(
  dependencies: QueueRuntimeDependencies
): QueueRuntime {
  const {
    discoveryQueue,
    browserAssistedDiscoveries,
    activeBrowserDiscoveries,
    activeQueueDiscoveries,
    activeDownloads,
    reservedOutputPaths,
    dataDirectory,
    packageEpub,
    settingsService,
    libraryIndexRepository,
    isShuttingDown,
    queueHelpers,
    notifyDiscoveryQueueChanged,
    trackBackgroundTask,
    errorMessage
  } = dependencies
  const {
    markQueueItemChaptersDirty,
    withChapters,
    persistDiscoveryQueue
  } = queueHelpers

  async function fetchChapterContentWithBrowserFallback(
    chapter: ChapterLink,
    signal: AbortSignal
  ): Promise<ChapterContent> {
    try {
      return await fetchChapterContent(chapter, signal)
    } catch (error) {
      const verificationRequired =
        (error instanceof HttpStatusError &&
          (error.status === 401 || error.status === 403)) ||
        error instanceof VerificationRequiredError
      if (!verificationRequired) throw error
  
      const { html, finalUrl } = await readBrowserPage(chapter.url, signal)
      return fetchChapterContentFromHtml(chapter, html, finalUrl, signal)
    }
  }

  async function discoverQueueItem(
    id: string,
    browserAssisted = false
  ): Promise<boolean> {
    const item = discoveryQueue.find((candidate) => candidate.id === id)
    if (!item || item.status !== 'discovering') return false
    const controller = new AbortController()
    activeQueueDiscoveries.set(id, controller)
    const browserController = browserAssisted ? controller : null
    const browserOperationId = `queue:${id}`
    if (browserController)
      activeBrowserDiscoveries.set(browserOperationId, browserController)
    let previousChapters: QueueChapter[] = []
    let previousByUrl = new Map<string, QueueChapter>()
    let hadPreviousSnapshot = false
    let verificationRequired = false
    const cleanup = (notify: boolean): void => {
      if (activeBrowserDiscoveries.get(browserOperationId) === browserController) {
        activeBrowserDiscoveries.delete(browserOperationId)
      }
      if (activeQueueDiscoveries.get(id) === controller)
        activeQueueDiscoveries.delete(id)
      if (notify) notifyDiscoveryQueueChanged()
    }
    let shouldNotify = true
  
    try {
      return await withChapters(item, async () => {
      try {
      if (item.siteExtractionMode === undefined) {
        const settings = await settingsService.get()
        item.siteExtractionMode = siteExtractionModeForUrl(
          item.sourceUrl,
          settings.siteExtractionPreferences
        )
        await persistDiscoveryQueue()
        notifyDiscoveryQueueChanged()
      }
      previousChapters = item.chapters.map((chapter) => ({ ...chapter }))
      previousByUrl = new Map(
        previousChapters.map((chapter) => [chapter.url, chapter])
      )
      hadPreviousSnapshot = Boolean(
        item.discoveredAt && previousChapters.length > 0
      )
      const result = browserAssisted
        ? await discoverChaptersUsingPageLoader(
            item.sourceUrl,
            readBrowserPage,
            (progress) => {
              if (activeQueueDiscoveries.get(id) !== controller) return
              item.progress = progress
              notifyDiscoveryQueueChanged()
            },
            controller.signal,
            item.siteExtractionMode
          )
        : await discoverChapters(
            item.sourceUrl,
            (progress) => {
              if (activeQueueDiscoveries.get(id) !== controller) return
              item.progress = progress
              notifyDiscoveryQueueChanged()
            },
            controller.signal,
            item.siteExtractionMode
          )
      if (controller.signal.aborted)
        throw new OperationCancelledError('Discovery was cancelled.')
      if (
        activeQueueDiscoveries.get(id) !== controller ||
        item.status !== 'discovering'
      ) {
        shouldNotify = false
        return false
      }
      item.title = result.title || item.title
      item.author = result.author || item.author
      item.description = result.description
      item.coverUrl = result.coverUrl
      item.alternativeNames = [...result.alternativeNames]
      item.genres = [...result.genres]
      item.source = result.source
      item.novelStatus = result.novelStatus
      item.parserName = result.parserName
      const newUrls = new Set(result.chapters.map((chapter) => chapter.url))
      const addedCount = result.chapters.filter(
        (chapter) => !previousByUrl.has(chapter.url)
      ).length
      const removedCount = previousChapters.filter(
        (chapter) => !newUrls.has(chapter.url)
      ).length
      const orderChanged =
        previousChapters.length === result.chapters.length &&
        previousChapters.some(
          (chapter, index) => chapter.url !== result.chapters[index].url
        )
      const refreshedChapters: QueueChapter[] = result.chapters.map(
        (chapter) => ({
          ...chapter,
          archiveStatus: 'missing',
          archiveSources: [],
          chapterNumber: null,
          archiveGap: false,
          recommended: true,
          selected: previousByUrl.get(chapter.url)?.selected ?? true
        })
      )
      const libraryIndex = await libraryIndexRepository.read()
      if (
        controller.signal.aborted ||
        activeQueueDiscoveries.get(id) !== controller ||
        item.status !== 'discovering'
      ) {
        shouldNotify = false
        return false
      }
      const recommendation = recommendArchiveCoverage(
        { ...item, chapters: refreshedChapters },
        libraryIndex?.files ?? []
      )
      item.chapters = recommendation.chapters
      markQueueItemChaptersDirty(item)
      item.recommendationSummary = recommendation.summary
      item.discoveryChanges =
        hadPreviousSnapshot &&
        (addedCount > 0 || removedCount > 0 || orderChanged)
          ? `Chapter list changed: ${addedCount} added, ${removedCount} removed${orderChanged ? ', order changed' : ''}. Review your selection.`
          : ''
      transitionQueueItem(item, 'needs-review')
      item.progress = null
      item.error = ''
      item.discoveredAt = new Date().toISOString()
      item.updatedAt = item.discoveredAt
    } catch (error) {
      if (activeQueueDiscoveries.get(id) !== controller) {
        shouldNotify = false
        return false
      }
      verificationRequired =
        error instanceof VerificationRequiredError ||
        (error instanceof HttpStatusError &&
          (error.status === 401 || error.status === 403))
      const finalStatus =
        controller.signal.aborted && !isShuttingDown()
          ? 'cancelled'
          : 'failed'
      transitionQueueItem(item, finalStatus)
      item.progress = null
      item.error = finalStatus === 'cancelled' ? '' : errorMessage(error)
      item.updatedAt = new Date().toISOString()
    }
  
    try {
      await persistDiscoveryQueue()
    } catch (error) {
      console.error(`Discovery queue item ${id} could not be saved:`, error)
      transitionQueueItem(item, 'failed')
      item.error = `Discovery result could not be saved: ${errorMessage(error)}`
      item.updatedAt = new Date().toISOString()
      try {
        await persistDiscoveryQueue()
      } catch (saveError) {
        console.error(
          `Discovery queue item ${id} failure state could not be saved:`,
          saveError
        )
      }
    }
    return verificationRequired
      })
    } catch (error) {
      if (activeQueueDiscoveries.get(id) !== controller) return false
      const finalStatus =
        controller.signal.aborted && !isShuttingDown()
          ? 'cancelled'
          : 'failed'
      transitionQueueItem(item, finalStatus)
      item.progress = null
      item.error = finalStatus === 'cancelled' ? '' : errorMessage(error)
      item.updatedAt = new Date().toISOString()
      try {
        await persistDiscoveryQueue()
      } catch (saveError) {
        console.error(
          `Discovery queue item ${id} failure state could not be saved:`,
          saveError
        )
      }
      return false
    } finally {
      cleanup(shouldNotify)
    }
  }

  const discoveryScheduler = new DiscoveryScheduler({
    concurrency: () => settingsService.current.maxSimultaneousDiscoveries,
    run: (id) => {
      const browserAssisted = browserAssistedDiscoveries.delete(id)
      return discoverQueueItem(id, browserAssisted)
    },
    trackBackgroundTask,
    isShuttingDown
  })

  async function revalidateStaleQueuedJob(
    item: DiscoveryQueueItem
  ): Promise<boolean> {
    const completedChapters = item.progress?.current ?? 0
    const selectedUrls = await withChapters(item, (loadedItem) =>
      loadedItem.chapters
        .filter((chapter) => chapter.selected)
        .map((chapter) => chapter.url)
    )
    transitionQueueItem(item, 'discovering')
    item.error = ''
    item.progress = {
      current: 0,
      total: selectedUrls.length,
      message: 'Refreshing the chapter list before starting this older job…'
    }
    await persistDownloadState(item)
  
    const verificationRequired = await discoverQueueItem(item.id)
    if (discoveryQueueItemStatus(item) === 'failed' && verificationRequired) {
      transitionQueueItem(item, 'discovering')
      item.error = ''
      item.progress = {
        current: 0,
        total: selectedUrls.length,
        message: 'Retrying chapter-list refresh in the saved browser session…'
      }
      await persistDownloadState(item)
      await discoverQueueItem(item.id, true)
    }
  
    if (discoveryQueueItemStatus(item) === 'cancelled') {
      await persistDownloadState(item)
      return false
    }
  
    if (discoveryQueueItemStatus(item) !== 'needs-review') {
      if (discoveryQueueItemStatus(item) !== 'failed') {
        transitionQueueItem(item, 'failed')
        item.error =
          'The chapter list could not be refreshed before the EPUB job started.'
      } else {
        item.error = `The chapter list could not be refreshed before the EPUB job started: ${item.error}`
      }
      await persistDownloadState(item)
      return false
    }
  
    const refreshedSelection = await withChapters(item, async (loadedItem) => {
      const previouslySelected = new Set(selectedUrls)
      for (const chapter of loadedItem.chapters) {
        chapter.selected = previouslySelected.has(chapter.url)
      }
      markQueueItemChaptersDirty(loadedItem)
      const selection = loadedItem.chapters
        .filter((chapter) => chapter.selected)
        .map((chapter) => chapter.url)
      await persistDiscoveryQueue()
      return selection
    })
    const selectionUnchanged =
      selectedUrls.length === refreshedSelection.length &&
      selectedUrls.every((url, index) => url === refreshedSelection[index])
  
    if (!selectionUnchanged) {
      transitionQueueItem(item, 'needs-review')
      item.error =
        'The chapter list changed since this EPUB was queued. Review the refreshed chapters before queueing it again.'
      await persistDownloadState(item)
      return false
    }
  
    transitionQueueItem(item, 'queued')
    item.error = ''
    item.progress = {
      current: completedChapters,
      total: selectedUrls.length,
      message: 'The chapter list is fresh; starting the queued job…'
    }
    await persistDownloadState(item)
    return true
  }

  function canRetryChapter(error: unknown): boolean {
    if (
      error instanceof OperationCancelledError ||
      error instanceof VerificationRequiredError ||
      error instanceof NoReadableContentError
    ) {
      return false
    }
    if (error instanceof HttpStatusError)
      return error.status === 408 || error.status === 429 || error.status >= 500
    return error instanceof TransientNetworkError
  }

  async function persistDownloadState(
    item: DiscoveryQueueItem,
    checkpoint = true
  ): Promise<void> {
    const now = new Date().toISOString()
    item.updatedAt = now
    if (checkpoint) {
      await persistDiscoveryQueue()
    }
    notifyDiscoveryQueueChanged()
  }

  async function runQueuedDownload(
    itemId: string,
    controller: AbortController,
    maxSimultaneousChapters: number
  ): Promise<void> {
    const item = discoveryQueue.find((candidate) => candidate.id === itemId)
    if (!item || !item.downloadOptions) return
    const options = item.downloadOptions
    await withChapters(item, async () => {
    const saveAvailableChaptersOnly = item.saveAvailableChaptersOnly === true
    const selectedChapters = item.chapters.filter((chapter) => chapter.selected)
    const missingSelectedChapterUrls = new Set<string>()
    let completedSelectedChapterCount = 0
    let activeChapterRequests = 0
    let lastCheckpointAt = Date.now()
    let chaptersSinceCheckpoint = 0
    let progressCheckpointTail = Promise.resolve()
    let releaseOutputReservation = (): void => {}
    let packagingStarted = false
    let outputPackaged = false
  
    const recordUnavailableChapter = (
      chapter: ChapterLink,
      reason: string
    ): void => {
      missingSelectedChapterUrls.add(chapter.url)
      item.failedChapters = [
        ...item.failedChapters.filter((failed) => failed.url !== chapter.url),
        { url: chapter.url, title: chapter.title, error: reason }
      ]
      item.error = `${missingSelectedChapterUrls.size} selected chapter(s) are unavailable; saving the available chapters.`
    }
  
    const persistChapterProgress = (): Promise<void> => {
      const operation = progressCheckpointTail.then(async () => {
        chaptersSinceCheckpoint += 1
        const now = Date.now()
        const shouldCheckpoint =
          chaptersSinceCheckpoint >= 25 || now - lastCheckpointAt >= 5000
        await persistDownloadState(item, shouldCheckpoint)
        if (shouldCheckpoint) {
          chaptersSinceCheckpoint = 0
          lastCheckpointAt = now
        }
      })
      progressCheckpointTail = operation
      return operation
    }
  
    try {
      if (selectedChapters.length === 0)
        throw new Error('Select at least one chapter before queueing this EPUB.')
      const processChapter = async (
        index: number,
        chapter: ChapterLink
      ): Promise<void> => {
        const active = activeDownloads.get(itemId)
        if (
          !active ||
          active.requestedAction !== 'none' ||
          controller.signal.aborted
        )
          return
        let savedContent: ChapterContent | null = null
        if (item.repackageOnly) {
          item.progress = {
            current: completedSelectedChapterCount,
            total: selectedChapters.length,
            message: `Validating saved chapter ${index + 1} of ${selectedChapters.length}: ${chapter.title}`
          }
          await persistDownloadState(item, false)
          try {
            savedContent = await readChapterArtifact(
              dataDirectory(),
              itemId,
              chapter.url
            )
          } catch (error) {
            if (!saveAvailableChaptersOnly) throw error
            console.warn(
              `Saved chapter artifact for ${chapter.url} will be omitted:`,
              errorMessage(error)
            )
          }
          if (!savedContent || savedContent.url !== chapter.url) {
            const reason = `Saved chapter content is missing or invalid for "${chapter.title}".`
            if (!saveAvailableChaptersOnly) throw new Error(reason)
            recordUnavailableChapter(chapter, reason)
            item.progress = {
              current: completedSelectedChapterCount,
              total: selectedChapters.length,
              message: `Skipped unavailable saved chapter: ${chapter.title}`
            }
            await persistChapterProgress()
            return
          }
          missingSelectedChapterUrls.delete(chapter.url)
          item.failedChapters = item.failedChapters.filter(
            (failed) => failed.url !== chapter.url
          )
          completedSelectedChapterCount += 1
        } else {
          try {
            savedContent = await readChapterArtifact(
              dataDirectory(),
              itemId,
              chapter.url
            )
            if (savedContent && savedContent.url !== chapter.url) {
              console.warn(
                `Saved chapter artifact for ${chapter.url} has a mismatched URL and will be fetched again.`
              )
              savedContent = null
            }
          } catch (error) {
            console.warn(
              `Saved chapter artifact for ${chapter.url} will be fetched again:`,
              errorMessage(error)
            )
          }
          if (savedContent) {
            completedSelectedChapterCount += 1
            item.failedChapters = item.failedChapters.filter(
              (failed) => failed.url !== chapter.url
            )
          }
        }
  
        if (!savedContent) {
          let lastError: unknown = new Error('Chapter could not be fetched.')
          activeChapterRequests += 1
          try {
            item.progress = {
              current: completedSelectedChapterCount,
              total: selectedChapters.length,
              message: `Fetching chapter ${index + 1} of ${selectedChapters.length} (${activeChapterRequests} active): ${chapter.title}`
            }
            await persistDownloadState(item, false)
  
            try {
              savedContent = await withRetry(
                () =>
                  fetchChapterContentWithBrowserFallback(
                    chapter,
                    controller.signal
                  ),
                {
                  attempts: 3,
                  shouldRetry: canRetryChapter,
                  signal: controller.signal,
                  cancellationMessage: 'EPUB creation was cancelled.'
                }
              )
            } catch (error) {
              if (controller.signal.aborted) return
              lastError = error
            }
  
            if (controller.signal.aborted) return
            if (savedContent) {
              await writeChapterArtifact(dataDirectory(), itemId, savedContent)
              completedSelectedChapterCount += 1
              item.failedChapters = item.failedChapters.filter(
                (failed) => failed.url !== chapter.url
              )
            } else {
              item.failedChapters = [
                ...item.failedChapters.filter(
                  (failed) => failed.url !== chapter.url
                ),
                {
                  url: chapter.url,
                  title: chapter.title,
                  error: errorMessage(lastError)
                }
              ]
              item.error = `${item.failedChapters.length} chapter(s) failed. Retry failed chapters to continue.`
            }
          } finally {
            activeChapterRequests -= 1
          }
        }
  
        item.progress = {
          current: completedSelectedChapterCount,
          total: selectedChapters.length,
          message: savedContent
            ? item.repackageOnly
              ? `Validated saved content for ${chapter.title}`
              : `Fetched ${chapter.title}`
            : `Failed ${chapter.title}`
        }
        await persistChapterProgress()
      }
  
      let poolError: unknown
      let poolFailed = false
      try {
        await runPool(
          selectedChapters.length,
          maxSimultaneousChapters,
          async (index) => {
            const active = activeDownloads.get(itemId)
            const chapter = selectedChapters[index]
            if (
              !active ||
              active.requestedAction !== 'none' ||
              !chapter
            ) return
            try {
              await processChapter(index, chapter)
            } catch (error) {
              controller.abort()
              throw error
            }
          },
          controller.signal,
          'EPUB creation was cancelled.'
        )
      } catch (error) {
        poolFailed = true
        poolError = error
      }
      await progressCheckpointTail
      if (poolFailed) throw poolError
  
      const requestedAction =
        activeDownloads.get(itemId)?.requestedAction ?? 'cancel'
      if (requestedAction === 'pause') {
        transitionQueueItem(item, 'paused')
        item.progress = {
          ...(item.progress ?? {
            current: 0,
            total: selectedChapters.length,
            message: ''
          }),
          message: 'Paused'
        }
        await persistDownloadState(item)
        return
      }
      if (requestedAction === 'shutdown') {
        transitionQueueItem(item, 'downloading')
        item.progress = {
          ...(item.progress ?? {
            current: 0,
            total: selectedChapters.length,
            message: ''
          }),
          message: 'Interrupted; resuming after app restart'
        }
        await persistDownloadState(item)
        return
      }
      if (requestedAction === 'cancel' || controller.signal.aborted) {
        transitionQueueItem(item, 'cancelled')
        item.progress = {
          ...(item.progress ?? {
            current: 0,
            total: selectedChapters.length,
            message: ''
          }),
          message: 'Cancelled'
        }
        await persistDownloadState(item)
        return
      }
      if (item.failedChapters.length > 0 && !saveAvailableChaptersOnly) {
        const finalStatus =
          completedSelectedChapterCount > 0
            ? 'partially-completed'
            : 'failed'
        transitionQueueItem(item, finalStatus)
        item.progress = {
          current: completedSelectedChapterCount,
          total: selectedChapters.length,
          message: `${item.failedChapters.length} chapter(s) failed`
        }
        await persistDownloadState(item)
        return
      }
  
      const chapters: Array<Pick<ChapterLink, 'title' | 'url'>> = []
      for (const chapter of selectedChapters) {
        let content: ChapterContent | null = null
        let artifactError: Error | undefined
        try {
          content = await readChapterArtifact(
            dataDirectory(),
            itemId,
            chapter.url
          )
        } catch (error) {
          artifactError =
            error instanceof Error ? error : new Error(String(error))
        }
        if (!content || content.url !== chapter.url) {
          const reason = `Saved chapter content is missing or invalid for "${chapter.title}".`
          if (!saveAvailableChaptersOnly) {
            if (artifactError) throw artifactError
            throw new Error(reason)
          }
          recordUnavailableChapter(chapter, reason)
          continue
        }
        missingSelectedChapterUrls.delete(chapter.url)
        chapters.push({ title: content.title, url: content.url })
      }
      if (chapters.length === 0) {
        throw new Error(
          'No valid saved chapter content is available to create an EPUB.'
        )
      }
      let includeCover = false
      if (options.coverUrl) {
        if (item.repackageOnly) {
          try {
            includeCover = Boolean(
              await readCoverArtifact(dataDirectory(), itemId)
            )
          } catch (error) {
            if (!saveAvailableChaptersOnly) throw error
            console.warn(
              `Saved cover artifact for queue item ${itemId} will be omitted:`,
              errorMessage(error)
            )
          }
          if (!includeCover && !saveAvailableChaptersOnly) {
            throw new Error(
              'Saved cover content is missing; retry this EPUB online before repackaging.'
            )
          }
        } else {
          try {
            includeCover = Boolean(
              await readCoverArtifact(dataDirectory(), itemId)
            )
          } catch (error) {
            console.warn(
              `Saved cover artifact for queue item ${itemId} will be fetched again:`,
              errorMessage(error)
            )
          }
          if (!includeCover) {
            item.progress = {
              current: selectedChapters.length,
              total: selectedChapters.length,
              message: 'Fetching novel cover…'
            }
            await persistDownloadState(item)
            try {
              const fetchedCover = await withRetry(
                async () => {
                  const fetchedCover = await fetchImageResource(
                    options.coverUrl,
                    options.sourceUrl || item.sourceUrl,
                    controller.signal
                  )
                  await writeCoverArtifact(dataDirectory(), itemId, fetchedCover)
                  return fetchedCover
                },
                {
                  attempts: 3,
                  shouldRetry: canRetryChapter,
                  signal: controller.signal,
                  cancellationMessage: 'EPUB creation was cancelled.'
                }
              )
              includeCover = Boolean(fetchedCover)
            } catch (error) {
              if (controller.signal.aborted) {
                throw new OperationCancelledError('EPUB creation was cancelled.')
              }
              throw error
            }
          }
        }
      }
      item.progress = {
        current: chapters.length,
        total: selectedChapters.length,
        message: 'Validating and packaging EPUB…'
      }
      await persistDownloadState(item)
      const omittedChapterCount = selectedChapters.length - chapters.length
      const incompleteOutput =
        saveAvailableChaptersOnly && omittedChapterCount > 0
      let outputFilename = options.filename
      if (incompleteOutput) {
        const reservation = await reserveIncompleteEpubFilename(
          item,
          selectedChapters,
          discoveryQueue,
          reservedOutputPaths
        )
        outputFilename = reservation.filename
        item.targetOutputPath = reservation.outputPath
        releaseOutputReservation = reservation.release
        await persistDownloadState(item)
      } else {
        const outputPath = expectedOutputPath(
          options.outputDirectory,
          options.title,
          options.filename,
          selectedChapters
        )
        assertOutputPathAvailable(discoveryQueue, outputPath, itemId)
        item.targetOutputPath = outputPath
        await persistDownloadState(item)
      }
      packagingStarted = true
      const result = await packageEpub(
        {
          dataDirectory: dataDirectory(),
          queueItemId: itemId,
          chapters,
          outputDirectory: options.outputDirectory,
          title: options.title,
          author: options.author,
          language: options.language,
          filename: outputFilename,
          css: options.epubCss,
          includeCover,
          metadata: {
            description: options.description,
            alternativeNames: options.alternativeNames,
            genres: options.genres,
            source: options.source,
            novelStatus: options.novelStatus,
            sourceUrl: options.sourceUrl || item.sourceUrl
          }
        },
        controller.signal,
        (progress) => {
          item.progress = {
            current: chapters.length,
            total: selectedChapters.length,
            message: progress.message
          }
          notifyDiscoveryQueueChanged()
        }
      )
      packagingStarted = false
      outputPackaged = true
      const finalStatus = incompleteOutput
        ? 'partially-completed'
        : 'completed'
      transitionQueueItem(item, finalStatus)
      item.repackageOnly = false
      item.saveAvailableChaptersOnly = false
      item.outputPath = result.outputPath
      item.targetOutputPath = result.outputPath.toLowerCase()
      item.error = incompleteOutput
        ? `${omittedChapterCount} selected chapter(s) were omitted. Retry to fetch them and create a complete EPUB.`
        : ''
      item.progress = {
        current: chapters.length,
        total: selectedChapters.length,
        message: incompleteOutput
          ? `Saved ${chapters.length} of ${selectedChapters.length} selected chapters (incomplete)`
          : 'Completed'
      }
      item.completedChapterUrls = []
      item.failedChapters = incompleteOutput
        ? item.failedChapters.filter((failed) =>
            missingSelectedChapterUrls.has(failed.url)
          )
        : []
      await persistDownloadState(item)
      if (!incompleteOutput) {
        await removeChapterArtifacts(dataDirectory(), itemId).catch(
          (error: unknown) => {
            console.warn(
              `Completed chapter artifacts for queue item ${itemId} could not be removed:`,
              errorMessage(error)
            )
          }
        )
      }
    } catch (error) {
      const requestedAction =
        activeDownloads.get(itemId)?.requestedAction ?? 'none'
      if (outputPackaged) {
        console.error(
          `EPUB job ${itemId} was packaged, but its final state could not be saved:`,
          error
        )
      } else if (requestedAction === 'shutdown') {
        transitionQueueItem(item, 'downloading')
        item.error = ''
        item.progress = {
          current: completedSelectedChapterCount,
          total: selectedChapters.length,
          message: 'Interrupted; resuming after app restart'
        }
      } else if (requestedAction === 'pause' || requestedAction === 'cancel') {
        const finalStatus = requestedAction === 'pause' ? 'paused' : 'cancelled'
        transitionQueueItem(item, finalStatus)
        item.error = ''
      } else {
        const packagingFailed =
          packagingStarted &&
          requestedAction === 'none' &&
          !controller.signal.aborted
        if (packagingFailed) {
          transitionQueueItem(item, 'packaging-failed')
          let freeBytes: number | null = null
          try {
            const filesystem = await statfs(options.outputDirectory)
            freeBytes = filesystem.bavail * filesystem.bsize
          } catch (diagnosticError) {
            console.warn(
              `Free space could not be read for packaging failure ${itemId}:`,
              errorMessage(diagnosticError)
            )
          }
          console.error('EPUB packaging failed after chapter processing.', {
            itemId,
            error: errorMessage(error),
            stack:
              error instanceof Error ? error.stack : String(error),
            freeBytes,
            paths: {
              dataDirectory: dataDirectory(),
              outputDirectory: options.outputDirectory,
              targetOutputPath: item.targetOutputPath
            },
            options: {
              ...options,
              alternativeNames: [...options.alternativeNames],
              genres: [...options.genres]
            }
          })
        } else {
          const finalStatus =
            completedSelectedChapterCount > 0
              ? 'partially-completed'
              : 'failed'
          transitionQueueItem(item, finalStatus)
        }
        item.error = errorMessage(error)
        console.error(`Queued EPUB job ${itemId} failed:`, error)
      }
      if (requestedAction !== 'shutdown') {
        item.progress = {
          current: completedSelectedChapterCount,
          total: selectedChapters.length,
          message: item.status
        }
      }
      try {
        await persistDownloadState(item)
      } catch (saveError) {
        console.error(
          `Queued EPUB job ${itemId} state could not be saved:`,
          saveError
        )
      }
    } finally {
      releaseOutputReservation()
    }
    })
  }

  async function drainDownloadQueue(): Promise<void> {
    if (isShuttingDown()) return
    try {
      const settings = await settingsService.get()
      if (
        !Number.isInteger(settings.maxSimultaneousDownloads) ||
        settings.maxSimultaneousDownloads < MIN_SIMULTANEOUS_DOWNLOADS ||
        settings.maxSimultaneousDownloads > MAX_SIMULTANEOUS_DOWNLOADS
      ) {
        throw new Error(
          `Maximum simultaneous novel downloads must be from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
        )
      }
      while (
        !isShuttingDown() &&
        activeDownloads.size < settings.maxSimultaneousDownloads
      ) {
        const item = discoveryQueue
          .filter(
            (candidate) =>
              candidate.status === 'queued' && candidate.downloadOptions
          )
          .sort(
            (left, right) =>
              left.sequence - right.sequence ||
              left.id.localeCompare(right.id)
          )[0]
        if (!item) break
        const currentHead = discoveryQueue
          .filter(
            (candidate) =>
              candidate.status === 'queued' && candidate.downloadOptions
          )
          .sort(
            (left, right) =>
              left.sequence - right.sequence ||
              left.id.localeCompare(right.id)
          )[0]
        if (item.status !== 'queued' || currentHead?.id !== item.id) continue
        if (
          !item.repackageOnly &&
          discoverySnapshotIsStale(
            item.discoveredAt,
            settings.discoveryFreshnessHours
          )
        ) {
          try {
            await revalidateStaleQueuedJob(item)
          } catch (error) {
            transitionQueueItem(item, 'failed')
            item.error = `The chapter list could not be refreshed before the EPUB job started: ${errorMessage(error)}`
            try {
              await persistDownloadState(item)
            } catch (saveError) {
              console.error(
                `Stale EPUB job ${item.id} failure state could not be saved:`,
                saveError
              )
              notifyDiscoveryQueueChanged()
            }
          }
          if (item.status === 'queued') item.chapters = []
          continue
        }
        try {
          await withChapters(item, () => undefined)
        } catch (error) {
          transitionQueueItem(item, 'failed')
          item.error = errorMessage(error)
          item.updatedAt = new Date().toISOString()
          await persistDownloadState(item)
          continue
        }
        const controller = new AbortController()
        activeDownloads.set(item.id, { controller, requestedAction: 'none' })
        transitionQueueItem(item, 'downloading')
        item.error = ''
        item.progress = {
          current: item.progress?.current ?? 0,
          total: item.chapterSummary.selected,
          message: 'Starting download…'
        }
        try {
          await persistDownloadState(item)
        } catch (error) {
          activeDownloads.delete(item.id)
          transitionQueueItem(item, 'failed')
          item.error = `The queued job could not be started: ${errorMessage(error)}`
          console.error(`Queued EPUB job ${item.id} could not be started:`, error)
          await persistDiscoveryQueue().catch((saveError: unknown) => {
            console.error(
              `Queued EPUB job ${item.id} failure state could not be saved:`,
              saveError
            )
          })
          notifyDiscoveryQueueChanged()
          continue
        }
        const task = runQueuedDownload(
          item.id,
          controller,
          settings.maxSimultaneousChaptersPerNovel
        ).finally(() => {
          activeDownloads.delete(item.id)
          void downloadScheduler.request().catch((error: unknown) => {
            console.error('Download queue scheduler failed:', error)
          })
        })
        trackBackgroundTask(task, `EPUB download task ${item.id}`)
      }
    } catch (error) {
      console.error('Download queue scheduler failed:', error)
      for (const item of discoveryQueue) {
        if (item.status === 'queued') {
          transitionQueueItem(item, 'failed')
          item.error = errorMessage(error)
          item.updatedAt = new Date().toISOString()
        }
      }
      await persistDiscoveryQueue().catch((saveError: unknown) => {
        console.error(
          'Download queue scheduler failure could not be saved:',
          saveError
        )
      })
      notifyDiscoveryQueueChanged()
    }
  }

  const downloadScheduler = new DownloadScheduler(
    drainDownloadQueue,
    isShuttingDown
  )

  return {
    discoverQueueItem,
    discoveryScheduler,
    revalidateStaleQueuedJob,
    canRetryChapter,
    persistDownloadState,
    runQueuedDownload,
    downloadScheduler
  }
}
