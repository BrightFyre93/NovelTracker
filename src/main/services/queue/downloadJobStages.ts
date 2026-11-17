import type { ChapterLink, DiscoveryQueueItem } from '../../../shared/contracts'
import { OperationCancelledError } from '../../../shared/errors'
import { fetchImageResource } from '../scraper'
import { withRetry } from '../retry'
import { transitionQueueItem } from './queueStateMachine'
import { inspectPackagedEpubForLibrary } from '../libraryScanner'
import type { createDownloadArtifactStore } from './artifactStore'
import type { DownloadJobDependencies } from './downloadJob'
import type { EpubPackagingResult } from '../epubPackaging'
import {
  assertOutputPathAvailable,
  expectedOutputPath,
  reserveIncompleteEpubFilename
} from './helpers'
type DownloadOptions = NonNullable<DiscoveryQueueItem['downloadOptions']>

export async function resolveCoverForDownloadJob(input: {
  itemId: string
  item: DiscoveryQueueItem
  options: DownloadOptions
  artifactStore: ReturnType<typeof createDownloadArtifactStore>
  selectedChapterCount: number
  retryAttempts: number
  saveAvailableChaptersOnly: boolean
  signal: AbortSignal
  persistDownloadState: DownloadJobDependencies['persistDownloadState']
  canRetryChapter: DownloadJobDependencies['canRetryChapter']
  errorMessage: DownloadJobDependencies['errorMessage']
}): Promise<boolean> {
  const {
    itemId,
    item,
    options,
    artifactStore,
    selectedChapterCount,
    retryAttempts,
    saveAvailableChaptersOnly,
    signal,
    persistDownloadState,
    canRetryChapter,
    errorMessage
  } = input
  if (!options.coverUrl) return false

  if (item.repackageOnly) {
    let includeCover = false
    try {
      includeCover = Boolean(await artifactStore.readCover(itemId))
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
    return includeCover
  }

  let includeCover = false
  try {
    includeCover = Boolean(await artifactStore.readCover(itemId))
  } catch (error) {
    console.warn(
      `Saved cover artifact for queue item ${itemId} will be fetched again:`,
      errorMessage(error)
    )
  }
  if (includeCover) return true

  item.progress = {
    current: selectedChapterCount,
    total: selectedChapterCount,
    message: 'Fetching novel cover…'
  }
  await persistDownloadState(item)
  try {
    const fetchedCover = await withRetry(
      async () => {
        const cover = await fetchImageResource(
          options.coverUrl,
          options.sourceUrl || item.sourceUrl,
          signal
        )
        await artifactStore.writeCover(itemId, cover)
        return cover
      },
      {
        attempts: retryAttempts,
        shouldRetry: canRetryChapter,
        signal,
        cancellationMessage: 'EPUB creation was cancelled.'
      }
    )
    return Boolean(fetchedCover)
  } catch (error) {
    if (signal.aborted)
      throw new OperationCancelledError('EPUB creation was cancelled.')
    throw error
  }
}

export async function resolveDownloadOutput(input: {
  itemId: string
  item: DiscoveryQueueItem
  options: DownloadOptions
  chapters: Array<Pick<ChapterLink, 'title' | 'url'>>
  selectedChapters: DiscoveryQueueItem['chapters']
  saveAvailableChaptersOnly: boolean
  discoveryQueue: DiscoveryQueueItem[]
  reservedOutputPaths: Set<string>
  persistDownloadState: DownloadJobDependencies['persistDownloadState']
  onReservationRelease: (release: () => void) => void
}) {
  const {
    itemId,
    item,
    options,
    chapters,
    selectedChapters,
    saveAvailableChaptersOnly,
    discoveryQueue,
    reservedOutputPaths,
    persistDownloadState,
    onReservationRelease
  } = input
  const omittedChapterCount = selectedChapters.length - chapters.length
  const incompleteOutput = saveAvailableChaptersOnly && omittedChapterCount > 0
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
    onReservationRelease(reservation.release)
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
  return { outputFilename, incompleteOutput, omittedChapterCount }
}

export async function packageAndFinalizeDownloadJob(input: {
  dependencies: DownloadJobDependencies
  lifecycle: { packagingStarted: boolean; outputPackaged: boolean }
  artifactStore: ReturnType<typeof createDownloadArtifactStore>
  itemId: string
  item: DiscoveryQueueItem
  options: DownloadOptions
  chapters: Array<Pick<ChapterLink, 'title' | 'url'>>
  selectedChapters: DiscoveryQueueItem['chapters']
  missingSelectedChapterUrls: Set<string>
  includeCover: boolean
  outputFilename: string
  incompleteOutput: boolean
  omittedChapterCount: number
  signal: AbortSignal
}): Promise<void> {
  const {
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
    signal
  } = input
  const {
    dataDirectory,
    packageEpub,
    settingsService,
    libraryIndexRepository,
    notifyDiscoveryQueueChanged,
    errorMessage,
    persistDownloadState
  } = dependencies

  lifecycle.packagingStarted = true
  let outputPersistenceTail = Promise.resolve()
  let result: EpubPackagingResult
  try {
    result = await packageEpub(
    {
      dataDirectory: dataDirectory(),
      queueItemId: itemId,
      chapters,
      outputDirectory: options.outputDirectory,
      title: options.title,
      author: options.author,
      filename: outputFilename,
      outputOptions: options.outputOptions,
      completedOutputs: item.outputPaths ?? [],
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
    signal,
    (progress) => {
      if (progress.publishedOutput) {
        const published = progress.publishedOutput
        item.outputPaths = [
          ...(item.outputPaths ?? []).filter(
            (output) => output.volumeIndex !== published.volumeIndex
          ),
          published
        ].sort((left, right) => left.volumeIndex - right.volumeIndex)
        item.outputPath = item.outputPaths[0]?.path ?? published.path
        outputPersistenceTail = outputPersistenceTail.then(() =>
          persistDownloadState(item, true)
        )
      }
      item.progress = {
        current: chapters.length,
        total: selectedChapters.length,
        message: progress.message
      }
      notifyDiscoveryQueueChanged()
      }
    )
  } catch (error) {
    await outputPersistenceTail
    throw error
  }
  await outputPersistenceTail
  lifecycle.packagingStarted = false
  lifecycle.outputPackaged = true

  let libraryIndexWarning = ''
  try {
    const settings = await settingsService.get()
    const warnings: string[] = []
    for (const output of result.outputPaths) {
      const inspection = await inspectPackagedEpubForLibrary(
        output.path,
        settings.libraryRoot,
        settings
      )
      if (inspection.file) {
        await libraryIndexRepository.upsertFile(
          inspection.file,
          inspection.libraryRoot
        )
      } else {
        warnings.push(`${output.filename}: ${inspection.skippedReason}`)
      }
    }
    if (warnings.length > 0) {
      libraryIndexWarning = `EPUB saved, but some volumes were not added to the library index: ${warnings.join('; ')}.`
    }
  } catch (error) {
    libraryIndexWarning = `EPUB saved, but could not be added to the library index: ${errorMessage(error)}`
  }

  transitionQueueItem(
    item,
    incompleteOutput ? 'partially-completed' : 'completed'
  )
  item.repackageOnly = false
  item.saveAvailableChaptersOnly = false
  item.outputPath = result.outputPath
  item.outputPaths = result.outputPaths
  item.targetOutputPath = result.outputPath.toLowerCase()
  item.error = [
    incompleteOutput
      ? `${omittedChapterCount} selected chapter(s) were omitted. Retry to fetch them and create a complete EPUB.`
      : '',
    libraryIndexWarning
  ]
    .filter(Boolean)
    .join(' ')
  item.progress = {
    current: chapters.length,
    total: selectedChapters.length,
    message: incompleteOutput
      ? `Saved ${chapters.length} of ${selectedChapters.length} selected chapters (incomplete)`
      : 'Completed'
  }
  item.failedChapters = incompleteOutput
    ? item.failedChapters.filter((failed) =>
        missingSelectedChapterUrls.has(failed.url)
      )
    : []
  await persistDownloadState(item)
  if (!incompleteOutput) {
    await artifactStore.removeChapters(itemId).catch((error: unknown) => {
      console.warn(
        `Completed chapter artifacts for queue item ${itemId} could not be removed:`,
        errorMessage(error)
      )
    })
  }
}
