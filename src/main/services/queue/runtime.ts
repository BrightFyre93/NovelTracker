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
  discoverChapters,
  discoverChaptersUsingPageLoader
} from '../scraper'
import { readBrowserPage } from '../browserService'
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
import { runQueuedDownloadJob } from './downloadJob'
import type { QueueChapterStateRepository } from './repository'
import { discoveryQueueItemStatus, discoverySnapshotIsStale } from './helpers'

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
  libraryIndexRepository: Pick<
    LibraryIndexRepository,
    'readRecommendationFiles' | 'upsertFile'
  >
  chapterStateRepository: QueueChapterStateRepository
  isShuttingDown: () => boolean
  queueHelpers: Pick<
    QueueHelpers,
    'markQueueItemChaptersDirty' | 'withChapters' | 'persistDiscoveryQueue'
  >
  notifyDiscoveryQueueChanged: () => void
  trackBackgroundTask: (task: Promise<void>, label: string) => void
  errorMessage: (error: unknown) => string
}

export interface QueueRuntime {
  discoverQueueItem: (id: string, browserAssisted?: boolean) => Promise<boolean>
  discoveryScheduler: DiscoveryScheduler
  revalidateStaleQueuedJob: (item: DiscoveryQueueItem) => Promise<boolean>
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
    chapterStateRepository,
    isShuttingDown,
    queueHelpers,
    notifyDiscoveryQueueChanged,
    trackBackgroundTask,
    errorMessage
  } = dependencies
  const { markQueueItemChaptersDirty, withChapters, persistDiscoveryQueue } =
    queueHelpers

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
      if (
        activeBrowserDiscoveries.get(browserOperationId) === browserController
      ) {
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
          item.detectedLanguage = result.detectedLanguage || ''
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
          const libraryFiles =
            await libraryIndexRepository.readRecommendationFiles(item)
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
            libraryFiles ?? []
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
        controller.signal.aborted && !isShuttingDown() ? 'cancelled' : 'failed'
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
    return runQueuedDownloadJob(
      {
        discoveryQueue,
        activeDownloads,
        reservedOutputPaths,
        dataDirectory,
        packageEpub,
        settingsService,
        libraryIndexRepository,
        chapterStateRepository,
        notifyDiscoveryQueueChanged,
        errorMessage,
        withChapters,
        persistDownloadState,
        canRetryChapter,
        fetchChapterContentWithBrowserFallback
      },
      itemId,
      controller,
      maxSimultaneousChapters
    )
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
              left.sequence - right.sequence || left.id.localeCompare(right.id)
          )[0]
        if (!item) break
        const currentHead = discoveryQueue
          .filter(
            (candidate) =>
              candidate.status === 'queued' && candidate.downloadOptions
          )
          .sort(
            (left, right) =>
              left.sequence - right.sequence || left.id.localeCompare(right.id)
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
          console.error(
            `Queued EPUB job ${item.id} could not be started:`,
            error
          )
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
