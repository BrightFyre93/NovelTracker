import { statfs } from 'node:fs/promises'
import type { DiscoveryQueueItem } from '../../../shared/contracts'
import { appendJobDiagnostic } from '../jobDiagnostics'

type DownloadOptions = NonNullable<DiscoveryQueueItem['downloadOptions']>

/**
 * Logs a failed job and writes its per-job diagnostic file. Never throws:
 * diagnostics must not hide the original failure.
 */
export async function reportJobFailure(input: {
  event: 'packaging-failed' | 'job-failed'
  itemId: string
  item: DiscoveryQueueItem
  options: DownloadOptions
  error: unknown
  dataDirectory: string
  errorMessage: (error: unknown) => string
}): Promise<void> {
  const { event, itemId, item, options, error, dataDirectory, errorMessage } =
    input
  const stack = error instanceof Error ? error.stack : String(error)
  let freeBytes: number | null = null
  try {
    const filesystem = await statfs(options.outputDirectory)
    freeBytes = filesystem.bavail * filesystem.bsize
  } catch (diagnosticError) {
    console.warn(
      `Free space could not be read for failed job ${itemId}:`,
      errorMessage(diagnosticError)
    )
  }
  if (event === 'packaging-failed') {
    console.error('EPUB packaging failed after chapter processing.', {
      itemId,
      error: errorMessage(error),
      stack,
      freeBytes,
      paths: {
        dataDirectory,
        outputDirectory: options.outputDirectory,
        targetOutputPath: item.targetOutputPath
      },
      options: {
        language: options.outputOptions.language,
        filename: options.filename,
        outputDirectory: options.outputDirectory,
        omitHttp404Chapters: options.omitHttp404Chapters === true,
        outputOptions: {
          filenameTemplate: options.outputOptions.filenameTemplate,
          includeNovelInfoPage: options.outputOptions.includeNovelInfoPage,
          includeChapterListPage: options.outputOptions.includeChapterListPage,
          skipImages: options.outputOptions.skipImages,
          compressImages: options.outputOptions.compressImages,
          maxImageDimension: options.outputOptions.maxImageDimension,
          imageFormat: options.outputOptions.imageFormat,
          coverJpegOnly: options.outputOptions.coverJpegOnly,
          flattenAnimatedImages: options.outputOptions.flattenAnimatedImages,
          includeImageAttribution:
            options.outputOptions.includeImageAttribution,
          maxChaptersPerEpub: options.outputOptions.maxChaptersPerEpub
        }
      }
    })
  }
  try {
    await appendJobDiagnostic(dataDirectory, itemId, {
      event,
      error: errorMessage(error),
      stack,
      freeBytes,
      paths: {
        outputDirectory: options.outputDirectory,
        targetOutputPath: item.targetOutputPath
      },
      options: {
        ...options.outputOptions,
        css: undefined,
        filename: options.filename,
        outputDirectory: options.outputDirectory,
        omitHttp404Chapters: options.omitHttp404Chapters === true
      },
      failedChapters: item.failedChapters.map((chapter) => ({
        title: chapter.title,
        url: chapter.url,
        httpStatus: chapter.httpStatus ?? null,
        omitted: chapter.omitted === true,
        error: chapter.error
      })),
      outputs: item.outputPaths ?? []
    })
  } catch (diagnosticError) {
    console.warn(
      `Job diagnostic could not be written for ${itemId}:`,
      errorMessage(diagnosticError)
    )
  }
}
