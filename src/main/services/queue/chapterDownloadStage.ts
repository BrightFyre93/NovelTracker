import type {
  ChapterContent,
  ChapterLink,
  DiscoveryQueueItem
} from '../../../shared/contracts'
import {
  HttpStatusError,
  VerificationRequiredError
} from '../../../shared/errors'
import { ArtifactValidationError } from '../localStore'
import { withRetry } from '../retry'
import type {
  QueueChapterDownloadState,
  QueueChapterDownloadStatus
} from './repository'
import type { ActiveDownload } from './runtime'
import type { createDownloadArtifactStore } from './artifactStore'

type DownloadOptions = NonNullable<DiscoveryQueueItem['downloadOptions']>
type ArtifactStore = ReturnType<typeof createDownloadArtifactStore>
type ChapterStateUpdate = Partial<
  Pick<
    QueueChapterDownloadState,
    'attemptCount' | 'lastHttpStatus' | 'lastError' | 'artifactRef'
  >
>

export interface ChapterProcessorProgress {
  completedSelectedChapterCount: number
  activeChapterRequests: number
}

export interface ChapterProcessorContext {
  itemId: string
  item: DiscoveryQueueItem
  options: DownloadOptions
  controller: AbortController
  activeDownloads: Map<string, ActiveDownload>
  selectedChapters: DiscoveryQueueItem['chapters']
  chapterStates: Map<string, QueueChapterDownloadState>
  missingSelectedChapterUrls: Set<string>
  progress: ChapterProcessorProgress
  artifactStore: ArtifactStore
  retryAttempts: number
  saveAvailableChaptersOnly: boolean
  updateChapterState: (
    chapter: ChapterLink,
    sourceOrder: number,
    state: QueueChapterDownloadStatus,
    update?: ChapterStateUpdate
  ) => Promise<void>
  recordUnavailableChapter: (chapter: ChapterLink, reason: string) => void
  updateChapterIssueSummary: () => void
  persistChapterProgress: () => Promise<void>
  persistDownloadState: (
    item: DiscoveryQueueItem,
    checkpoint?: boolean
  ) => Promise<void>
  errorMessage: (error: unknown) => string
  canRetryChapter: (error: unknown) => boolean
  fetchChapterContentWithBrowserFallback: (
    chapter: ChapterLink,
    signal: AbortSignal
  ) => Promise<ChapterContent>
}

export function createChapterProcessor(context: ChapterProcessorContext) {
  const {
    itemId,
    item,
    options,
    controller,
    activeDownloads,
    selectedChapters,
    chapterStates,
    missingSelectedChapterUrls,
    progress,
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
  } = context
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
        current: progress.completedSelectedChapterCount,
        total: selectedChapters.length,
        message: `Validating saved chapter ${index + 1} of ${selectedChapters.length}: ${chapter.title}`
      }
      await persistDownloadState(item, false)
      const savedState = chapterStates.get(chapter.id)
      const expectedArtifactRef = artifactStore.chapterReference(
        itemId,
        chapter.url
      )
      const savedStateIsValid =
        savedState?.state === 'Downloaded' &&
        savedState.currentUrl === chapter.url &&
        savedState.artifactRef === expectedArtifactRef
      const savedArtifactExists = savedStateIsValid
        ? await artifactStore.hasUsableChapter(itemId, chapter.url)
        : false
      if (!savedStateIsValid || !savedArtifactExists) {
        const reason = `Saved chapter content is missing or damaged for "${chapter.title}". Use Retry to download it again.`
        await updateChapterState(
          chapter,
          index,
          savedStateIsValid ? 'InvalidArtifact' : 'Skipped',
          {
            lastError: reason,
            artifactRef: null
          }
        )
        if (!saveAvailableChaptersOnly) throw new Error(reason)
        recordUnavailableChapter(chapter, reason)
        item.progress = {
          current: progress.completedSelectedChapterCount,
          total: selectedChapters.length,
          message: `Skipped unavailable saved chapter: ${chapter.title}`
        }
        await persistChapterProgress()
        return
      }
      savedContent = {
        title: savedState?.title ?? chapter.title,
        url: savedState?.currentUrl ?? chapter.url,
        paragraphs: [],
        images: []
      }
      await updateChapterState(chapter, index, 'Downloaded', {
        artifactRef: expectedArtifactRef
      })
      missingSelectedChapterUrls.delete(chapter.url)
      item.failedChapters = item.failedChapters.filter(
        (failed) => failed.url !== chapter.url
      )
      progress.completedSelectedChapterCount += 1
    } else {
      const savedState = chapterStates.get(chapter.id)
      const expectedArtifactRef = artifactStore.chapterReference(
        itemId,
        chapter.url
      )
      if (
        savedState?.state === 'Downloaded' &&
        savedState.currentUrl === chapter.url &&
        savedState.artifactRef === expectedArtifactRef &&
        (await artifactStore.hasUsableChapter(itemId, chapter.url))
      ) {
        savedContent = {
          title: savedState.title,
          url: savedState.currentUrl,
          paragraphs: [],
          images: []
        }
      }
      if (savedContent) {
        await updateChapterState(chapter, index, 'Downloaded', {
          artifactRef: artifactStore.chapterReference(itemId, chapter.url)
        })
        progress.completedSelectedChapterCount += 1
        item.failedChapters = item.failedChapters.filter(
          (failed) => failed.url !== chapter.url
        )
      }
      if (!savedContent) {
        const previousState = chapterStates.get(chapter.id)
        if (previousState?.state === 'Downloaded') {
          await updateChapterState(chapter, index, 'InvalidArtifact', {
            lastError: `Saved chapter content is missing or invalid for "${chapter.title}".`,
            artifactRef: null
          })
        }
      }
    }

    if (!savedContent) {
      let lastError: unknown = new Error('Chapter could not be fetched.')
      progress.activeChapterRequests += 1
      try {
        item.progress = {
          current: progress.completedSelectedChapterCount,
          total: selectedChapters.length,
          message: `Fetching chapter ${index + 1} of ${selectedChapters.length} (${progress.activeChapterRequests} active): ${chapter.title}`
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
              attempts: retryAttempts,
              shouldRetry: canRetryChapter,
              signal: controller.signal,
              cancellationMessage: 'EPUB creation was cancelled.',
              onAttempt: async (attemptNumber) => {
                await updateChapterState(
                  chapter,
                  index,
                  attemptNumber === 1 ? 'Downloading' : 'Retrying',
                  {
                    attemptCount:
                      (chapterStates.get(chapter.id)?.attemptCount ?? 0) + 1,
                    lastHttpStatus: null,
                    lastError: null,
                    artifactRef: null
                  }
                )
              }
            }
          )
        } catch (error) {
          if (controller.signal.aborted) {
            await updateChapterState(chapter, index, 'Pending', {
              lastHttpStatus: null,
              lastError: null,
              artifactRef: null
            })
            return
          }
          lastError = error
        }

        if (controller.signal.aborted) {
          await updateChapterState(chapter, index, 'Pending', {
            lastHttpStatus: null,
            lastError: null,
            artifactRef: null
          })
          return
        }
        if (lastError instanceof VerificationRequiredError) {
          await updateChapterState(chapter, index, 'Failed', {
            lastHttpStatus:
              lastError instanceof HttpStatusError ? lastError.status : null,
            lastError: errorMessage(lastError),
            artifactRef: null
          })
          item.failedChapters = [
            {
              url: chapter.url,
              title: chapter.title,
              error: errorMessage(lastError)
            },
            ...item.failedChapters.filter(
              (failed) => failed.url !== chapter.url
            )
          ]
          item.error = errorMessage(lastError)
          const active = activeDownloads.get(itemId)
          if (active?.requestedAction === 'none')
            active.requestedAction = 'pause'
          throw lastError
        }
        if (savedContent) {
          try {
            await artifactStore.writeChapter(itemId, savedContent)
          } catch (error) {
            if (!(error instanceof ArtifactValidationError)) throw error
            savedContent = null
            lastError = error
          }
        }
        if (savedContent) {
          await updateChapterState(chapter, index, 'Downloaded', {
            artifactRef: artifactStore.chapterReference(itemId, chapter.url),
            lastHttpStatus: null,
            lastError: null
          })
          progress.completedSelectedChapterCount += 1
          item.failedChapters = item.failedChapters.filter(
            (failed) => failed.url !== chapter.url
          )
        } else {
          const httpStatus =
            lastError instanceof HttpStatusError ? lastError.status : null
          const omitted404 =
            httpStatus === 404 && options.omitHttp404Chapters === true
          const issueMessage = omitted404
            ? 'HTTP 404; omitted under the saved chapter policy.'
            : errorMessage(lastError)
          await updateChapterState(
            chapter,
            index,
            omitted404 ? 'Skipped' : 'Failed',
            {
              lastHttpStatus: httpStatus,
              lastError: issueMessage,
              artifactRef: null
            }
          )
          item.failedChapters = [
            ...item.failedChapters.filter(
              (failed) => failed.url !== chapter.url
            ),
            {
              url: chapter.url,
              title: chapter.title,
              error: issueMessage,
              ...(httpStatus === null ? {} : { httpStatus }),
              ...(omitted404 ? { omitted: true } : {})
            }
          ]
          updateChapterIssueSummary()
        }
      } finally {
        progress.activeChapterRequests -= 1
      }
    }

    item.progress = {
      current: progress.completedSelectedChapterCount,
      total: selectedChapters.length,
      message: savedContent
        ? item.repackageOnly
          ? `Validated saved content for ${chapter.title}`
          : `Fetched ${chapter.title}`
        : `Failed ${chapter.title}`
    }
    await persistChapterProgress()
  }
  return processChapter
}
