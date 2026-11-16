import { realpath, stat } from 'node:fs/promises'
import type {
  AppSettings,
  ChapterLink,
  DiscoveryQueueItem,
  LibraryOperation
} from '../../shared/contracts'
import {
  readLibraryOperations,
  readSettings,
  takeStorageRecoveryWarnings
} from '../services/localStore'
import type { QueueRepository } from '../services/queue/repository'
import { transitionQueueItem } from '../services/queue/queueStateMachine'

interface StartupRecoveryDependencies {
  dataDirectory: string
  setLibraryOperations: (operations: LibraryOperation[]) => void
  flushLibraryOperations: () => Promise<void>
  setDiscoveryQueue: (items: DiscoveryQueueItem[]) => void
  queueRepository: Pick<QueueRepository, 'readQueue'>
  hydrateQueueItem: (item: DiscoveryQueueItem) => DiscoveryQueueItem
  hasUnknownProperties: (saved: object, normalized: object) => boolean
  releaseQueueItemChapters: (item: DiscoveryQueueItem) => void
  markQueueItemChaptersDirty: (item: DiscoveryQueueItem) => void
  expectedOutputPath: (
    outputDirectory: string,
    title: string,
    filename: string,
    chapters: ChapterLink[]
  ) => string
  persistDiscoveryQueue: () => Promise<void>
  approvedOutputDirectories: Set<string>
  errorMessage: (error: unknown) => string
}

export interface StartupRecoveryResult {
  settings: AppSettings
  storageRecoveryWarnings: string[]
}

export async function recoverStartupState(
  dependencies: StartupRecoveryDependencies
): Promise<StartupRecoveryResult> {
  const {
    dataDirectory,
    setLibraryOperations,
    flushLibraryOperations,
    setDiscoveryQueue,
    queueRepository,
    hydrateQueueItem,
    hasUnknownProperties,
    releaseQueueItemChapters,
    markQueueItemChaptersDirty,
    expectedOutputPath,
    persistDiscoveryQueue,
    approvedOutputDirectories,
    errorMessage
  } = dependencies

  const libraryOperations = await readLibraryOperations(dataDirectory)
  setLibraryOperations(libraryOperations)
  let interruptedLibraryOperations = false
  for (const operation of libraryOperations) {
    if (operation.status !== 'running') continue
    operation.status = 'interrupted'
    operation.message = 'The app closed before this operation finished.'
    operation.error = operation.message
    operation.updatedAt = new Date().toISOString()
    interruptedLibraryOperations = true
  }
  if (interruptedLibraryOperations) await flushLibraryOperations()

  const savedQueue = await queueRepository.readQueue()
  const discoveryQueue = savedQueue.map(hydrateQueueItem)
  setDiscoveryQueue(discoveryQueue)
  let queueStorageMigrationNeeded = savedQueue.some((saved, index) => {
    const normalized = discoveryQueue[index]
    return (
      !Number.isSafeInteger(saved.sequence) ||
      saved.sequence <= 0 ||
      saved.sequence !== normalized.sequence ||
      saved.downloadStartedAt !== normalized.downloadStartedAt ||
      hasUnknownProperties(saved, normalized) ||
      hasUnknownProperties(saved.chapterSummary, normalized.chapterSummary) ||
      (saved.chapters ?? []).some((chapter, chapterIndex) => {
        const normalizedChapter = normalized.chapters[chapterIndex]
        return (
          normalizedChapter !== undefined &&
          hasUnknownProperties(chapter, normalizedChapter)
        )
      })
    )
  })
  for (const item of discoveryQueue) {
    if (item.chapters.length > 0) {
      if (item.status === 'completed') releaseQueueItemChapters(item)
      else markQueueItemChaptersDirty(item)
      queueStorageMigrationNeeded = true
    }
    if (
      item.downloadOptions &&
      item.status !== 'completed' &&
      !item.targetOutputPath &&
      item.chapters.length > 0
    ) {
      const selectedChapters = item.chapters.filter(
        (chapter) => chapter.selected
      )
      item.targetOutputPath = expectedOutputPath(
        item.downloadOptions.outputDirectory,
        item.downloadOptions.title,
        item.downloadOptions.filename,
        selectedChapters
      )
      queueStorageMigrationNeeded = true
    }
    if (item.completedChapterUrls.length > 0) {
      item.completedChapterUrls = []
      queueStorageMigrationNeeded = true
    }
  }
  if (queueStorageMigrationNeeded) await persistDiscoveryQueue()
  for (const item of discoveryQueue) releaseQueueItemChapters(item)

  let interruptedDownloads = false
  for (const item of discoveryQueue) {
    if (item.status !== 'downloading' && item.status !== 'queued') continue
    if (!item.downloadOptions) {
      transitionQueueItem(item, 'failed')
      item.error = 'The saved EPUB job details are missing.'
      item.recoveryReason = undefined
      item.updatedAt = new Date().toISOString()
      interruptedDownloads = true
      continue
    }
    if (item.status === 'downloading') {
      transitionQueueItem(item, 'queued')
      item.error = ''
      item.progress = {
        current: item.progress?.current ?? 0,
        total: item.chapterSummary.selected,
        message: 'Resuming after app restart'
      }
      interruptedDownloads = true
    }
  }
  if (interruptedDownloads) await persistDiscoveryQueue()

  let interruptedDiscoveries = false
  for (const item of discoveryQueue) {
    if (item.status === 'discovering') {
      transitionQueueItem(item, 'failed')
      item.error =
        'Discovery was interrupted when the app closed. Retry to refresh the chapter list.'
      item.updatedAt = new Date().toISOString()
      interruptedDiscoveries = true
    }
  }
  if (interruptedDiscoveries) await persistDiscoveryQueue()

  const settings = await readSettings(dataDirectory)
  const storageRecoveryWarnings = takeStorageRecoveryWarnings()
  if (settings.outputDirectory) {
    try {
      const directory = await realpath(settings.outputDirectory)
      if ((await stat(directory)).isDirectory())
        approvedOutputDirectories.add(directory)
    } catch (error) {
      console.warn(
        'Saved EPUB output folder is unavailable:',
        errorMessage(error)
      )
    }
  }

  return { settings, storageRecoveryWarnings }
}
