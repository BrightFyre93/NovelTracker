import type { IpcContext } from './context'

type LibraryIpcContext = Pick<
  IpcContext,
  | 'MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES'
  | 'MAX_SELECTED_CHAPTERS'
  | 'OperationCancelledError'
  | 'Worker'
  | 'activeLibraryOperationHandlers'
  | 'activeLibraryScan'
  | 'copyLibraryOperations'
  | 'dataDirectory'
  | 'dialog'
  | 'errorMessage'
  | 'extname'
  | 'getIndexedLibraryFile'
  | 'getSiblingOutputPath'
  | 'handleTypedIpc'
  | 'handleValidatedResultIpc'
  | 'isAbsolute'
  | 'isNodeError'
  | 'join'
  | 'libraryCorrectionActive'
  | 'libraryIndexRepository'
  | 'libraryIndexRestoreActive'
  | 'lstat'
  | 'mainWindow'
  | 'normalizeNovelTitleForGrouping'
  | 'normalizeNovelTitleForMatching'
  | 'readSettings'
  | 'realpath'
  | 'relative'
  | 'resolve'
  | 'runWorker'
  | 'samePath'
  | 'sanitizeEpubFilename'
  | 'searchLibraryFileSummaries'
  | 'searchLibraryNovelSummaries'
  | 'sendToCurrentFrame'
  | 'sep'
  | 'shell'
  | 'shuttingDown'
  | 'startLibraryOperation'
  | 'stat'
  | 'summarizeLibraryIndex'
  | 'summarizeLibraryIndexOverview'
  | 'trackLibraryWorker'
  | 'updateLibraryOperation'
  | 'z'
>
import type { Worker } from 'node:worker_threads'
import type {
  EpubMergeProgress,
  EpubRepairProgress,
  EpubRepairResult,
  LibraryFileCorrection,
  LibraryProgress
} from '../../shared/contracts'
import type { EpubMergeInput, EpubMergeResult } from '../services/epubMerger'

interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

export function registerLibraryIpcHandlers(context: LibraryIpcContext): void {
  const {
    MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES,
    MAX_SELECTED_CHAPTERS,
    OperationCancelledError,
    Worker,
    copyLibraryOperations,
    dataDirectory,
    dialog,
    errorMessage,
    extname,
    getIndexedLibraryFile,
    getSiblingOutputPath,
    handleTypedIpc,
    handleValidatedResultIpc,
    isAbsolute,
    isNodeError,
    join,
    libraryIndexRepository,
    lstat,
    normalizeNovelTitleForGrouping,
    normalizeNovelTitleForMatching,
    readSettings,
    realpath,
    relative,
    resolve,
    runWorker,
    samePath,
    sanitizeEpubFilename,
    searchLibraryFileSummaries,
    searchLibraryNovelSummaries,
    sendToCurrentFrame,
    sep,
    shell,
    startLibraryOperation,
    stat,
    summarizeLibraryIndex,
    summarizeLibraryIndexOverview,
    trackLibraryWorker,
    updateLibraryOperation,
    z
  } = context

  handleValidatedResultIpc(
    'library:search-novels',
    z.tuple([
      z.string(),
      z.boolean(),
      z.number().int().min(0),
      z.number().int().min(1).max(100),
      z.string().optional()
    ]),
    async (
      _event,
      query,
      multipleFilesOnly,
      offset,
      limit,
      selectedNovelKey
    ) => {
      const index = await libraryIndexRepository.read()
      if (!index) throw new Error('Scan the library before searching novels.')
      return {
        ok: true,
        value: searchLibraryNovelSummaries(
          index,
          query,
          multipleFilesOnly,
          offset,
          limit,
          selectedNovelKey
        )
      }
    }
  )

  handleTypedIpc('library:index-summary', z.tuple([]), async () => {
    const index = await libraryIndexRepository.read()
    return index ? summarizeLibraryIndexOverview(index) : null
  })

  handleValidatedResultIpc(
    'library:search-novel-files',
    z.tuple([
      z.string().max(300),
      z.string(),
      z.number().int().min(0),
      z.number().int().min(1).max(100)
    ]),
    async (_event, novelKey, query, offset, limit) => {
      const index = await libraryIndexRepository.read()
      if (!index) throw new Error('Scan the library before viewing its files.')
      return {
        ok: true,
        value: searchLibraryFileSummaries(index, novelKey, query, offset, limit)
      }
    }
  )

  handleValidatedResultIpc(
    'library:novel-files',
    z.tuple([
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 300,
        'Invalid library novel selection.'
      )
    ]),
    async (_event, rawNovelKey) => {
      const index = await libraryIndexRepository.read()
      if (!index) throw new Error('Scan the library before viewing its files.')
      return {
        ok: true,
        value: index.files.filter(
          (file) =>
            normalizeNovelTitleForGrouping(file.novelTitle) === rawNovelKey
        )
      }
    }
  )

  handleTypedIpc('library:operations', z.tuple([]), () =>
    copyLibraryOperations()
  )

  handleTypedIpc('library:index-backup-date', z.tuple([]), async () =>
    libraryIndexRepository.readBackupDate()
  )

  handleValidatedResultIpc(
    'library:restore-index-backup',
    z.tuple([]),
    async () => {
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
        const settings = await readSettings(dataDirectory())
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
    }
  )

  handleValidatedResultIpc(
    'library:scan',
    z.tuple([
      z
        .custom<boolean>(
          (value): value is boolean => typeof value === 'boolean',
          'Invalid library scan option.'
        )
        .optional()
    ]),
    async (event, rawForceRebuild = false) => {
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
        const settings = await readSettings(dataDirectory())
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
        await runWorker<LibraryProgress, void>(worker, {
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
        const index = await libraryIndexRepository.read()
        if (!index)
          throw new Error('The library scan completed without saving an index.')
        return { ok: true, value: summarizeLibraryIndexOverview(index) }
      } catch (error) {
        if (!scan.cancelRequested) console.error('Library scan failed:', error)
        return { ok: false, error: errorMessage(error) }
      } finally {
        if (context.activeLibraryScan === scan) context.activeLibraryScan = null
      }
    }
  )

  handleTypedIpc('library:cancel-scan', z.tuple([]), () => {
    if (!context.activeLibraryScan) return
    context.activeLibraryScan.cancelRequested = true
    context.activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  })

  handleValidatedResultIpc(
    'library:correct-file',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library correction.'
      ),
      z.custom<LibraryFileCorrection>(
        (value): value is LibraryFileCorrection =>
          typeof value === 'object' && value !== null,
        'Invalid library correction.'
      )
    ]),
    async (_event, rawFileId, rawCorrection) => {
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
        const index = await libraryIndexRepository.writeCorrection(rawFileId, {
          novelTitle,
          chapterNumbers
        } satisfies LibraryFileCorrection)
        const novel = summarizeLibraryIndex(index).novels.find((group) =>
          group.files.some((file) => file.id === rawFileId)
        )
        if (!novel)
          throw new Error(
            'The corrected file could not be found in the library index.'
          )
        return {
          ok: true,
          value: {
            index: summarizeLibraryIndexOverview(index),
            novel
          }
        }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      } finally {
        context.libraryCorrectionActive = false
      }
    }
  )

  handleValidatedResultIpc(
    'library:merge-epubs',
    z.tuple([
      z.custom<string[]>(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length >= 2 &&
          value.length <= 20 &&
          value.every((id) => typeof id === 'string') &&
          new Set(value).size === value.length,
        'Select between 2 and 20 distinct EPUB files to combine.'
      ),
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 200,
        'Enter an EPUB filename of 200 characters or fewer.'
      )
    ]),
    async (event, rawFileIds, rawFilename) => {
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
        const index = await libraryIndexRepository.read()
        if (!index)
          throw new Error('Scan the library before combining existing EPUBs.')
        const settings = await readSettings(dataDirectory())
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
        const sourceFiles = rawFileIds.map((id) => {
          const file = index.files.find((candidate) => candidate.id === id)
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
          realpath(index.libraryRoot)
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
    }
  )

  handleValidatedResultIpc(
    'library:repair-epub',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Select an indexed library file.'
      )
    ]),
    async (_event, rawFileId) => {
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
    }
  )

  handleValidatedResultIpc(
    'library:open-path',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library path request.'
      ),
      z.custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'Invalid library path request.'
      )
    ]),
    async (_event, rawPath, reveal) => {
      const settings = await readSettings(dataDirectory())
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
  )
}
