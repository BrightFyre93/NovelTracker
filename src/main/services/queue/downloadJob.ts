import { statfs } from 'node:fs/promises'
import type {
  ChapterContent,
  ChapterLink,
  DiscoveryQueueItem
} from '../../../shared/contracts'
import { VerificationRequiredError } from '../../../shared/errors'
import { createDownloadArtifactStore } from './artifactStore'
import { runPool } from '../retry'
import type {
  EpubPackagingInput,
  EpubPackagingProgress,
  EpubPackagingResult
} from '../epubPackaging'
import type { SettingsService } from '../settingsService'
import type { QueueHelpers } from './helpers'
import { transitionQueueItem } from './queueStateMachine'
import type { LibraryIndexRepository } from '../library/libraryIndexRepository'
import type {
  QueueChapterDownloadState,
  QueueChapterDownloadStatus,
  QueueChapterStateRepository
} from './repository'
import type { ActiveDownload } from './runtime'
import { createChapterProcessor } from './chapterDownloadStage'
import {
  resolveCoverForDownloadJob,
  resolveDownloadOutput,
  packageAndFinalizeDownloadJob
} from './downloadJobStages'

export interface DownloadJobDependencies {
  discoveryQueue: DiscoveryQueueItem[]
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
  notifyDiscoveryQueueChanged: () => void
  errorMessage: (error: unknown) => string
  withChapters: QueueHelpers['withChapters']
  persistDownloadState: (
    item: DiscoveryQueueItem,
    checkpoint?: boolean
  ) => Promise<void>
  canRetryChapter: (error: unknown) => boolean
  fetchChapterContentWithBrowserFallback: (
    chapter: ChapterLink,
    signal: AbortSignal
  ) => Promise<ChapterContent>
}
export async function runQueuedDownloadJob(
  dependencies: DownloadJobDependencies,

  itemId: string,
  controller: AbortController,
  maxSimultaneousChapters: number
): Promise<void> {
  const {
    discoveryQueue,
    activeDownloads,
    reservedOutputPaths,
    dataDirectory,
    settingsService,
    chapterStateRepository,
    errorMessage,
    withChapters,
    persistDownloadState,
    canRetryChapter,
    fetchChapterContentWithBrowserFallback
  } = dependencies
  const artifactStore = createDownloadArtifactStore(dataDirectory)
  const item = discoveryQueue.find((candidate) => candidate.id === itemId)
  if (!item || !item.downloadOptions) return
  const options = item.downloadOptions
  const retryAttempts = settingsService.current.maxDownloadRetryAttempts
  await withChapters(item, async () => {
    const saveAvailableChaptersOnly = item.saveAvailableChaptersOnly === true
    const selectedChapters = item.chapters.filter((chapter) => chapter.selected)
    const chapterSourceOrder = new Map(
      item.chapters.map((chapter, sourceOrder) => [chapter.id, sourceOrder])
    )
    const savedChapterStates =
      await chapterStateRepository.readChapterStates(itemId)
    const chapterStates = new Map(
      savedChapterStates.map((state) => [state.chapterId, state])
    )
    const missingSelectedChapterUrls = new Set<string>()
    const chapterProgress = {
      completedSelectedChapterCount: 0,
      activeChapterRequests: 0
    }
    let lastCheckpointAt = Date.now()
    let chaptersSinceCheckpoint = 0
    let progressCheckpointTail = Promise.resolve()
    let releaseOutputReservation = (): void => {}
    const lifecycle = { packagingStarted: false, outputPackaged: false }

    const updateChapterState = async (
      chapter: ChapterLink,
      sourceOrder: number,
      state: QueueChapterDownloadStatus,
      update: Partial<
        Pick<
          QueueChapterDownloadState,
          'attemptCount' | 'lastHttpStatus' | 'lastError' | 'artifactRef'
        >
      > = {}
    ): Promise<void> => {
      const previous = chapterStates.get(chapter.id)
      const updatedAt = new Date().toISOString()
      const nextState: QueueChapterDownloadState = {
        chapterId: chapter.id,
        originalUrl: previous?.originalUrl ?? chapter.url,
        currentUrl: chapter.url,
        title: chapter.title,
        sourceOrder: chapterSourceOrder.get(chapter.id) ?? sourceOrder,
        state,
        attemptCount: update.attemptCount ?? previous?.attemptCount ?? 0,
        createdAt: previous?.createdAt ?? updatedAt,
        updatedAt,
        lastHttpStatus:
          update.lastHttpStatus === undefined
            ? state === 'Failed' || state === 'InvalidArtifact'
              ? (previous?.lastHttpStatus ?? null)
              : null
            : update.lastHttpStatus,
        lastError:
          update.lastError === undefined
            ? state === 'Failed' || state === 'InvalidArtifact'
              ? (previous?.lastError ?? null)
              : null
            : update.lastError,
        artifactRef:
          update.artifactRef === undefined
            ? state === 'Downloaded'
              ? (previous?.artifactRef ??
                artifactStore.chapterReference(itemId, chapter.url))
              : null
            : update.artifactRef
      }
      await chapterStateRepository.writeChapterStates(itemId, [nextState])
      chapterStates.set(chapter.id, nextState)
    }

    const initialChapterStates = selectedChapters.flatMap(
      (chapter, sourceOrder) => {
        const previous = chapterStates.get(chapter.id)
        if (previous && previous.state !== 'Skipped') return []
        const now = new Date().toISOString()
        const nextState: QueueChapterDownloadState = {
          chapterId: chapter.id,
          originalUrl: previous?.originalUrl ?? chapter.url,
          currentUrl: chapter.url,
          title: chapter.title,
          sourceOrder: chapterSourceOrder.get(chapter.id) ?? sourceOrder,
          state: 'Pending',
          attemptCount: previous?.attemptCount ?? 0,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          lastHttpStatus: null,
          lastError: null,
          artifactRef: null
        }
        chapterStates.set(chapter.id, nextState)
        return [nextState]
      }
    )
    if (initialChapterStates.length > 0) {
      await chapterStateRepository.writeChapterStates(
        itemId,
        initialChapterStates
      )
    }

    const recordUnavailableChapter = (
      chapter: ChapterLink,
      reason: string
    ): void => {
      missingSelectedChapterUrls.add(chapter.url)
      const previous = item.failedChapters.find(
        (failed) => failed.url === chapter.url
      )
      item.failedChapters = [
        ...item.failedChapters.filter((failed) => failed.url !== chapter.url),
        {
          url: chapter.url,
          title: chapter.title,
          error: reason,
          ...(previous?.httpStatus === undefined
            ? {}
            : { httpStatus: previous.httpStatus }),
          ...(previous?.omitted ? { omitted: true } : {})
        }
      ]
      item.error = `${missingSelectedChapterUrls.size} selected chapter(s) are unavailable; saving the available chapters.`
    }

    const updateChapterIssueSummary = (): void => {
      const omittedCount = item.failedChapters.filter(
        (chapter) => chapter.omitted
      ).length
      const failedCount = item.failedChapters.length - omittedCount
      item.error = [
        failedCount > 0
          ? `${failedCount} chapter(s) failed. Retry failed chapters to continue.`
          : '',
        omittedCount > 0
          ? `${omittedCount} selected chapter(s) omitted after HTTP 404 under the saved policy.`
          : ''
      ]
        .filter(Boolean)
        .join(' ')
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
        throw new Error(
          'Select at least one chapter before queueing this EPUB.'
        )
      const processChapter = createChapterProcessor({
        itemId,
        item,
        options,
        controller,
        activeDownloads,
        selectedChapters,
        chapterStates,
        missingSelectedChapterUrls,
        progress: chapterProgress,
        artifactStore,
        retryAttempts,
        saveAvailableChaptersOnly,
        updateChapterState,
        recordUnavailableChapter,
        updateChapterIssueSummary,
        persistChapterProgress,
        persistDownloadState,
        errorMessage,
        canRetryChapter,
        fetchChapterContentWithBrowserFallback
      })
      let poolError: unknown
      let poolFailed = false
      try {
        await runPool(
          selectedChapters.length,
          maxSimultaneousChapters,
          async (index) => {
            const active = activeDownloads.get(itemId)
            const chapter = selectedChapters[index]
            if (!active || active.requestedAction !== 'none' || !chapter) return
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
          chapterProgress.completedSelectedChapterCount > 0
            ? 'partially-completed'
            : 'failed'
        transitionQueueItem(item, finalStatus)
        updateChapterIssueSummary()
        const omittedCount = item.failedChapters.filter(
          (chapter) => chapter.omitted
        ).length
        const failedCount = item.failedChapters.length - omittedCount
        item.progress = {
          current: chapterProgress.completedSelectedChapterCount,
          total: selectedChapters.length,
          message: [
            failedCount > 0 ? `${failedCount} chapter(s) failed` : '',
            omittedCount > 0 ? `${omittedCount} chapter(s) omitted` : ''
          ]
            .filter(Boolean)
            .join(' · ')
        }
        await persistDownloadState(item)
        return
      }

      const chapters: Array<Pick<ChapterLink, 'title' | 'url'>> =
        selectedChapters
          .filter((chapter) => !missingSelectedChapterUrls.has(chapter.url))
          .map((chapter) => {
            const state = chapterStates.get(chapter.id)
            return {
              title: state?.title ?? chapter.title,
              url: state?.currentUrl ?? chapter.url
            }
          })
      if (chapters.length === 0) {
        throw new Error(
          'No valid saved chapter content is available to create an EPUB.'
        )
      }
      const includeCover = await resolveCoverForDownloadJob({
        itemId,
        item,
        options,
        artifactStore,
        selectedChapterCount: selectedChapters.length,
        retryAttempts,
        saveAvailableChaptersOnly,
        signal: controller.signal,
        persistDownloadState,
        canRetryChapter,
        errorMessage
      })
      item.progress = {
        current: chapters.length,
        total: selectedChapters.length,
        message: 'Validating and packaging EPUB…'
      }
      await persistDownloadState(item)
      const { outputFilename, incompleteOutput, omittedChapterCount } =
        await resolveDownloadOutput({
          itemId,
          item,
          options,
          chapters,
          selectedChapters,
          saveAvailableChaptersOnly,
          discoveryQueue,
          reservedOutputPaths,
          persistDownloadState,
          onReservationRelease: (release) => {
            releaseOutputReservation = release
          }
        })
      await packageAndFinalizeDownloadJob({
        dependencies,
        lifecycle,
        artifactStore,
        itemId,
        item,
        options,
        chapters,
        selectedChapters,
        missingSelectedChapterUrls,
        includeCover,
        outputFilename,
        incompleteOutput,
        omittedChapterCount,
        signal: controller.signal
      })
    } catch (error) {
      const requestedAction =
        activeDownloads.get(itemId)?.requestedAction ?? 'none'
      if (lifecycle.outputPackaged) {
        console.error(
          `EPUB job ${itemId} was packaged, but its final state could not be saved:`,
          error
        )
      } else if (requestedAction === 'shutdown') {
        transitionQueueItem(item, 'downloading')
        item.error = ''
        item.progress = {
          current: chapterProgress.completedSelectedChapterCount,
          total: selectedChapters.length,
          message: 'Interrupted; resuming after app restart'
        }
      } else if (requestedAction === 'pause' || requestedAction === 'cancel') {
        const finalStatus = requestedAction === 'pause' ? 'paused' : 'cancelled'
        transitionQueueItem(item, finalStatus)
        item.error =
          requestedAction === 'pause' &&
          error instanceof VerificationRequiredError
            ? errorMessage(error)
            : ''
      } else {
        const packagingFailed =
          lifecycle.packagingStarted &&
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
            stack: error instanceof Error ? error.stack : String(error),
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
            chapterProgress.completedSelectedChapterCount > 0
              ? 'partially-completed'
              : 'failed'
          transitionQueueItem(item, finalStatus)
        }
        item.error = errorMessage(error)
        console.error(`Queued EPUB job ${itemId} failed:`, error)
      }
      if (requestedAction !== 'shutdown') {
        item.progress = {
          current: chapterProgress.completedSelectedChapterCount,
          total: selectedChapters.length,
          message:
            requestedAction === 'pause' &&
            error instanceof VerificationRequiredError
              ? 'Waiting for manual verification'
              : item.status
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
