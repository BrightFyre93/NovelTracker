import { app, dialog, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { lstat, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  EpubMergeProgress,
  EpubRepairProgress,
  EpubRepairResponse,
  EpubRepairResult,
  LibraryEpubMergeResponse,
  LibraryFileCorrection,
  LibraryFileCorrectionResult,
  LibraryIndex,
  LibraryIndexOverview,
  LibraryPossibleMove,
  LibraryProgress,
  Result
} from '../../../shared/contracts'
import { normalizeNovelTitleForGrouping } from '../../../shared/novelTitle'
import type { EpubMergeInput, EpubMergeResult } from '../epubMerger'
import type { IpcContext } from '../../ipc/context'

export type LibraryWorkflowContext = Pick<
  IpcContext,
  | 'MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES'
  | 'MAX_SELECTED_CHAPTERS'
  | 'OperationCancelledError'
  | 'activeLibraryOperationHandlers'
  | 'activeLibraryScan'
  | 'copyLibraryOperations'
  | 'dataDirectory'
  | 'errorMessage'
  | 'getIndexedLibraryFile'
  | 'getSiblingOutputPath'
  | 'handle'
  | 'isNodeError'
  | 'libraryCorrectionActive'
  | 'libraryIndexRepository'
  | 'libraryIndexRestoreActive'
  | 'mainWindow'
  | 'normalizeNovelTitleForMatching'
  | 'runWorker'
  | 'samePath'
  | 'sanitizeEpubFilename'
  | 'sendToCurrentFrame'
  | 'settingsService'
  | 'shuttingDown'
  | 'startLibraryOperation'
  | 'summarizeLibraryIndex'
  | 'summarizeLibraryIndexOverview'
  | 'trackLibraryWorker'
  | 'updateLibraryOperation'
>

interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

export function createLibraryWorkflowCommands(context: LibraryWorkflowContext) {
  const {
    MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
    MAX_SELECTED_CHAPTERS,
    OperationCancelledError,
    dataDirectory,
    errorMessage,
    getIndexedLibraryFile,
    getSiblingOutputPath,
    isNodeError,
    libraryIndexRepository,
    normalizeNovelTitleForMatching,
    runWorker,
    samePath,
    sanitizeEpubFilename,
    sendToCurrentFrame,
    settingsService,
    startLibraryOperation,
    summarizeLibraryIndex,
    summarizeLibraryIndexOverview,
    trackLibraryWorker,
    updateLibraryOperation
  } = context
  return {
    runLibraryRestoreIndexBackup: async (): Promise<
      Result<LibraryIndexOverview>
    > => {
      if (context.shuttingDown)
        return { ok: false, error: 'NovelTracker is closing.' }
      if (
        context.activeLibraryScan ||
        context.libraryIndexRestoreActive ||
        context.libraryCorrectionActive
      ) {
        return {
          ok: false,
          error:
            'Wait for the current library operation to finish before restoring its backup.'
        }
      }
      context.libraryIndexRestoreActive = true
      try {
        const backup = await libraryIndexRepository.readBackup()
        if (!backup) throw new Error('No library index backup is available.')
        const settings = await settingsService.get()
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        const [configuredRoot, backupRoot] = await Promise.all([
          realpath(settings.libraryRoot),
          realpath(backup.libraryRoot)
        ])
        if (!samePath(configuredRoot, backupRoot)) {
          throw new Error(
            'The saved index backup belongs to a different library root.'
          )
        }
        await libraryIndexRepository.write(backup)
        return { ok: true, value: summarizeLibraryIndexOverview(backup) }
      } catch (error) {
        console.error('Library index backup restore failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        context.libraryIndexRestoreActive = false
      }
    },
    runLibraryScan: async (
      event: IpcMainInvokeEvent,
      rawForceRebuild: boolean | undefined = false
    ): Promise<Result<LibraryIndexOverview>> => {
      if (context.shuttingDown)
        return { ok: false, error: 'NovelTracker is closing.' }
      if (
        context.activeLibraryScan ||
        context.libraryIndexRestoreActive ||
        context.libraryCorrectionActive
      ) {
        return {
          ok: false,
          error: 'Another library operation is already running.'
        }
      }
      const scan: ActiveLibraryScan = { worker: null, cancelRequested: false }
      context.activeLibraryScan = scan
      try {
        const settings = await settingsService.get()
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        if (scan.cancelRequested)
          throw new OperationCancelledError('Library scan cancelled.')
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'libraryScanWorker.js'), {
            workerData: {
              libraryRoot: settings.libraryRoot,
              dataDirectory: dataDirectory(),
              forceRebuild: rawForceRebuild,
              scanOldFolder: settings.scanOldFolder,
              scanOldCompletedFolder: settings.scanOldCompletedFolder
            },
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        scan.worker = worker
        if (scan.cancelRequested) worker.postMessage({ type: 'cancel' })
        const scanResult = await runWorker<LibraryProgress, { possibleMoves: LibraryPossibleMove[] }>(worker, {
          workerName: 'Library scan',
          missingResultMessage:
            'Library scan worker exited without saving an index.',
          onProgress: (progress) => {
            sendToCurrentFrame(
              event.sender,
              event.senderFrame,
              'library:progress',
              progress
            )
          }
        })
        const overview = await libraryIndexRepository.readOverview()
        if (!overview)
          throw new Error('The library scan completed without saving an index.')
        return {
          ok: true,
          value: { ...overview, possibleMoves: scanResult.possibleMoves }
        }
      } catch (error) {
        if (!scan.cancelRequested) console.error('Library scan failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        if (context.activeLibraryScan === scan) context.activeLibraryScan = null
      }
    },
    runLibraryCorrectFile: async (
      _event: IpcMainInvokeEvent,
      rawFileId: string,
      rawCorrection: LibraryFileCorrection
    ): Promise<Result<LibraryFileCorrectionResult>> => {
      if (context.shuttingDown)
        return { ok: false, error: 'NovelTracker is closing.' }
      if (
        context.activeLibraryScan ||
        context.libraryIndexRestoreActive ||
        context.libraryCorrectionActive
      ) {
        return {
          ok: false,
          error:
            'Wait for the current library operation to finish before correcting files.'
        }
      }
      context.libraryCorrectionActive = true
      try {
        const novelTitle = rawCorrection.novelTitle
        const chapterNumbers = rawCorrection.chapterNumbers
        if (
          novelTitle !== undefined &&
          (typeof novelTitle !== 'string' || novelTitle.length > 300)
        ) {
          throw new Error('Novel title must be 300 characters or fewer.')
        }
        if (
          chapterNumbers !== undefined &&
          (!Array.isArray(chapterNumbers) ||
            chapterNumbers.length > MAX_SELECTED_CHAPTERS ||
            chapterNumbers.some(
              (number) =>
                typeof number !== 'number' ||
                !Number.isFinite(number) ||
                number < 0
            ))
        ) {
          throw new Error(
            'Chapter corrections must be a list of non-negative numbers.'
          )
        }
        const correctedFile = await libraryIndexRepository.writeCorrection(
          rawFileId,
          {
            novelTitle,
            chapterNumbers
          } satisfies LibraryFileCorrection
        )
        const novelKey = normalizeNovelTitleForGrouping(
          correctedFile.novelTitle
        )
        const [index, novelFiles] = await Promise.all([
          libraryIndexRepository.readOverview(),
          libraryIndexRepository.readNovelFiles(novelKey)
        ])
        if (!index || !novelFiles)
          throw new Error(
            'The corrected file could not be found in the library index.'
          )
        const summaryIndex: LibraryIndex = {
          schemaVersion: 1,
          libraryRoot: index.libraryRoot,
          scannedAt: index.scannedAt,
          files: novelFiles,
          corrections: {},
          scanErrors: index.scanErrors,
          ...(index.scanSummary ? { scanSummary: index.scanSummary } : {})
        }
        const novel = summarizeLibraryIndex(summaryIndex).novels.find(
          (group) => group.key === novelKey
        )
        if (!novel)
          throw new Error(
            'The corrected file could not be found in the library index.'
          )
        return {
          ok: true,
          value: {
            index,
            novel
          }
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      } finally {
        context.libraryCorrectionActive = false
      }
    },
    runLibraryMergeEpubs: async (
      event: IpcMainInvokeEvent,
      rawFileIds: string[],
      rawFilename: string
    ): Promise<LibraryEpubMergeResponse> => {
      if (context.shuttingDown)
        return { ok: false, error: 'NovelTracker is closing.' }
      let operationId: string | null = null
      context.activeLibraryOperationHandlers += 1
      try {
        if (
          context.activeLibraryScan ||
          context.libraryIndexRestoreActive ||
          context.libraryCorrectionActive
        ) {
          throw new Error(
            'Wait for the current library operation to finish before combining EPUBs.'
          )
        }
        const [overview, indexedFiles] = await Promise.all([
          libraryIndexRepository.readOverview(),
          libraryIndexRepository.readFilesByIds(rawFileIds)
        ])
        if (!overview || !indexedFiles)
          throw new Error('Scan the library before combining existing EPUBs.')
        const settings = await settingsService.get()
        if (!settings.libraryRoot)
          throw new Error(
            'Go to Configuration and choose a historical library root first.'
          )
        if (!settings.outputDirectory)
          throw new Error(
            'Go to Configuration and choose an EPUB output folder first.'
          )
        const outputDirectory = await realpath(settings.outputDirectory)
        if (!(await stat(outputDirectory)).isDirectory())
          throw new Error('The configured EPUB output path is not a folder.')
        const filename = sanitizeEpubFilename(rawFilename)
        const outputPath = resolve(outputDirectory, filename)
        const indexedFilesById = new Map(
          indexedFiles.map((file) => [file.id, file])
        )
        const sourceFiles = rawFileIds.map((id) => {
          const file = indexedFilesById.get(id)
          if (!file || file.format !== 'EPUB')
            throw new Error('A selected source EPUB is no longer indexed.')
          return file
        })
        const novelKeys = new Set(
          sourceFiles.map((file) =>
            normalizeNovelTitleForMatching(file.novelTitle)
          )
        )
        if (novelKeys.size !== 1)
          throw new Error('Select EPUBs belonging to the same indexed novel.')

        const [configuredRoot, libraryRoot] = await Promise.all([
          realpath(settings.libraryRoot),
          realpath(overview.libraryRoot)
        ])
        if (!samePath(configuredRoot, libraryRoot)) {
          throw new Error(
            'The saved library index belongs to a different root. Scan the configured library first.'
          )
        }
        let totalSourceBytes = 0
        for (const file of sourceFiles) {
          const [currentPath, details] = await Promise.all([
            realpath(file.path),
            lstat(file.path)
          ])
          const relativePath = relative(libraryRoot, currentPath)
          if (
            !relativePath ||
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath) ||
            details.isSymbolicLink() ||
            !details.isFile()
          ) {
            throw new Error(
              `The selected source file is outside the configured library: ${file.filename}`
            )
          }
          if (
            details.size !== file.size ||
            details.mtime.toISOString() !== file.modifiedAt
          ) {
            throw new Error(
              `The source file changed since the last scan: ${file.filename}. Rescan and try again.`
            )
          }
          totalSourceBytes += details.size
          if (totalSourceBytes > MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES) {
            throw new Error(
              `Selected EPUBs exceed the ${MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES / (1024 * 1024)} MB combined input limit.`
            )
          }
        }
        if (sourceFiles.some((file) => samePath(file.path, outputPath))) {
          throw new Error(
            'The merged EPUB cannot overwrite one of its source files.'
          )
        }
        try {
          const target = await lstat(outputPath)
          if (target.isSymbolicLink() || !target.isFile()) {
            throw new Error(
              'The output filename is already used by a folder or symbolic link.'
            )
          }
          if (!context.mainWindow)
            throw new Error(
              'The app window is not available to confirm replacing the existing EPUB.'
            )
          const confirmation = await dialog.showMessageBox(context.mainWindow, {
            type: 'warning',
            buttons: ['Replace', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Replace existing EPUB?',
            message: `Replace "${filename}" in the configured output folder?`
          })
          if (confirmation.response !== 0) {
            return { ok: false, cancelled: true }
          }
        } catch (error) {
          if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
        }

        const input: EpubMergeInput = {
          title: sourceFiles[0]?.novelTitle ?? 'Merged novel',
          filename,
          outputDirectory,
          language: sourceFiles[0]?.language ?? 'en',
          epubCss: settings.epubCss,
          appVersion: app.getVersion(),
          sources: sourceFiles.map((file) => ({
            path: file.path,
            filename: file.filename,
            chapterNumbers: file.chapterNumbers,
            filenameRange: file.filenameRange
          }))
        }
        const trackedOperationId = await startLibraryOperation({
          kind: 'merge-epubs',
          inputFiles: sourceFiles.map((file) => file.path),
          outputPath,
          progress: 0,
          message: 'Preparing EPUB merge…',
          error: ''
        })
        operationId = trackedOperationId
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'epubMergeWorker.js'), {
            workerData: input,
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        const result = await runWorker<EpubMergeProgress, EpubMergeResult>(
          worker,
          {
            workerName: 'EPUB merge',
            missingResultMessage:
              'EPUB merge worker exited without creating an EPUB.',
            onProgress: (progress) => {
              void updateLibraryOperation(
                trackedOperationId,
                {
                  progress: progress.percentage,
                  message: progress.message,
                  status: progress.stage === 'failed' ? 'failed' : 'running',
                  error: progress.stage === 'failed' ? progress.message : ''
                },
                progress.stage === 'failed'
              )
              sendToCurrentFrame(
                event.sender,
                event.senderFrame,
                'library:merge-progress',
                progress
              )
            }
          }
        )
        await updateLibraryOperation(
          operationId,
          {
            status: 'completed',
            outputPath: result.outputPath,
            progress: 100,
            message: 'Merged EPUB created and validated.',
            error: ''
          },
          true
        )
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(
            operationId,
            {
              status: 'failed',
              message: 'EPUB merge failed.',
              error: errorMessage(error)
            },
            true
          )
        }
        console.error('Existing EPUB merge failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        context.activeLibraryOperationHandlers -= 1
      }
    },
    runLibraryRepairEpub: async (
      _event: IpcMainInvokeEvent,
      rawFileId: string
    ): Promise<EpubRepairResponse> => {
      if (context.shuttingDown)
        return { ok: false, error: 'NovelTracker is closing.' }
      let operationId: string | null = null
      context.activeLibraryOperationHandlers += 1
      try {
        const inputPath = await getIndexedLibraryFile(rawFileId)
        const outputPath = await getSiblingOutputPath(inputPath, '-repaired')
        if (!outputPath) return { ok: false, cancelled: true }

        operationId = await startLibraryOperation({
          kind: 'repair-epub',
          inputFiles: [inputPath],
          outputPath,
          progress: 0,
          message: 'Preparing EPUB check and repair…',
          error: ''
        })
        const trackedOperationId = operationId
        const worker = trackLibraryWorker(
          new Worker(join(__dirname, 'epubRepairWorker.js'), {
            workerData: { inputPath, outputPath },
            resourceLimits: { maxOldGenerationSizeMb: 1024 }
          })
        )
        const result = await runWorker<EpubRepairProgress, EpubRepairResult>(
          worker,
          {
            workerName: 'EPUB repair',
            missingResultMessage:
              'EPUB repair worker exited without creating an EPUB.',
            onProgress: (progress) => {
              void updateLibraryOperation(trackedOperationId, {
                progress: progress.percentage,
                message: progress.message
              })
            }
          }
        )
        const summary =
          result.repairedWebpImages > 0
            ? `Converted ${result.repairedWebpImages.toLocaleString()} WebP image(s) to JPEG.`
            : 'No WebP images needed conversion.'
        const coverSummary = result.upscaledCover
          ? ' Upscaled the undersized cover to Kindle minimum dimensions.'
          : ''
        const mimetypeSummary = result.fixedMimetype
          ? ' Corrected EPUB mimetype and ZIP ordering.'
          : ''
        await updateLibraryOperation(
          operationId,
          {
            status: 'completed',
            outputPath: result.outputPath,
            progress: 100,
            message: `${summary}${coverSummary}${mimetypeSummary}`,
            error: ''
          },
          true
        )
        return { ok: true, value: result }
      } catch (error) {
        if (operationId) {
          await updateLibraryOperation(
            operationId,
            {
              status: 'failed',
              message: 'EPUB check and repair failed.',
              error: errorMessage(error)
            },
            true
          )
        }
        console.error('EPUB repair failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        context.activeLibraryOperationHandlers -= 1
      }
    },
    runLibraryOpenPath: async (
      _event: IpcMainInvokeEvent,
      rawPath: string,
      reveal: boolean
    ): Promise<Result<void>> => {
      const settings = await settingsService.get()
      if (!settings.libraryRoot)
        throw new Error(
          'Go to Configuration and choose a historical library root first.'
        )
      const root = await realpath(settings.libraryRoot)
      const target = await realpath(rawPath)
      const relativePath = relative(root, target)
      if (
        !relativePath ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath)
      ) {
        throw new Error('The requested path is outside the configured library.')
      }
      const targetDetails = await stat(target)
      if (
        !targetDetails.isDirectory() &&
        (!targetDetails.isFile() ||
          !['.epub', '.azw3'].includes(extname(target).toLowerCase()))
      ) {
        throw new Error(
          'Only folders and EPUB or AZW3 files can be opened from the library.'
        )
      }
      if (reveal) shell.showItemInFolder(target)
      else {
        const error = await shell.openPath(target)
        if (error) throw new Error(error)
      }
      return { ok: true, value: undefined }
    }
  }
}
