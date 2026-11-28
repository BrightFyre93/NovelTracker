import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  EpubRepairProgress,
  EpubRepairResult,
  LibraryHealthIssue,
  LibraryHealthRepairResult,
  LibraryHealthStatus,
  Result
} from '../../../shared/contracts'
import { atomicWriteFile } from '../atomicFile'
import type {
  LibraryHealthFile,
  LibraryHealthWorkerProgress,
  LibraryHealthWorkerResult
} from '../libraryHealthScan'
import type { LibraryWorkflowContext } from './libraryWorkflowCommands'

const MAX_REPAIR_FILES = 5000

function emptyStatus(): LibraryHealthStatus {
  return {
    phase: 'idle',
    current: 0,
    total: 0,
    message: '',
    scannedAt: null,
    scannedFileCount: 0,
    skippedFileCount: 0,
    issues: [],
    errors: [],
    repairResults: []
  }
}

function isIssue(value: unknown): value is LibraryHealthIssue {
  if (typeof value !== 'object' || value === null) return false
  const issue = value as Record<string, unknown>
  return (
    typeof issue.fileId === 'string' &&
    typeof issue.filename === 'string' &&
    typeof issue.relativePath === 'string' &&
    typeof issue.folderState === 'string' &&
    typeof issue.affectedChapters === 'number' &&
    Array.isArray(issue.examples)
  )
}

/**
 * Library health: finds EPUBs whose chapters contain escaped page markup and
 * repairs them into copies named "<name>-repaired.epub". The scan runs in a
 * worker and the page polls the status; the last result is kept in a file.
 */
export function createLibraryHealthCommands(context: LibraryWorkflowContext) {
  const {
    OperationCancelledError,
    dataDirectory,
    errorMessage,
    getIndexedLibraryFile,
    libraryIndexRepository,
    runWorker,
    startLibraryOperation,
    trackLibraryWorker,
    updateLibraryOperation
  } = context

  let status = emptyStatus()
  let loaded = false
  let abort: AbortController | null = null

  const filePath = (): string => join(dataDirectory(), 'library-health.json')
  const snapshot = (): LibraryHealthStatus => ({
    ...status,
    issues: status.issues.map((issue) => ({ ...issue })),
    errors: [...status.errors],
    repairResults: status.repairResults.map((result) => ({ ...result }))
  })

  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath(), 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return
      const saved = parsed as Record<string, unknown>
      status = {
        ...emptyStatus(),
        scannedAt: typeof saved.scannedAt === 'string' ? saved.scannedAt : null,
        scannedFileCount:
          typeof saved.scannedFileCount === 'number' ? saved.scannedFileCount : 0,
        skippedFileCount:
          typeof saved.skippedFileCount === 'number' ? saved.skippedFileCount : 0,
        issues: Array.isArray(saved.issues) ? saved.issues.filter(isIssue) : [],
        errors: Array.isArray(saved.errors)
          ? saved.errors.filter((item): item is string => typeof item === 'string')
          : []
      }
    } catch {
      // No saved result yet, or it could not be read: start empty.
    }
  }

  async function save(): Promise<void> {
    const text = JSON.stringify(
      {
        version: 1,
        scannedAt: status.scannedAt,
        scannedFileCount: status.scannedFileCount,
        skippedFileCount: status.skippedFileCount,
        issues: status.issues,
        errors: status.errors
      },
      null,
      1
    )
    await atomicWriteFile(filePath(), Buffer.from(text, 'utf8'))
  }

  function busyReason(): string {
    if (context.shuttingDown) return 'NovelTracker is closing.'
    if (status.phase !== 'idle') return 'The library health check is already running.'
    if (
      context.activeLibraryScan ||
      context.libraryIndexRestoreActive ||
      context.libraryCorrectionActive
    ) {
      return 'Wait for the current library operation to finish.'
    }
    return ''
  }

  async function runScan(files: LibraryHealthFile[], skipped: number, signal: AbortSignal): Promise<void> {
    context.activeLibraryOperationHandlers += 1
    try {
      const worker = trackLibraryWorker(
        new Worker(join(__dirname, 'libraryHealthWorker.js'), {
          workerData: { files },
          resourceLimits: { maxOldGenerationSizeMb: 512 }
        })
      )
      const result = await runWorker<LibraryHealthWorkerProgress, LibraryHealthWorkerResult>(
        worker,
        {
          workerName: 'Library health scan',
          missingResultMessage: 'The library health scan exited without a result.',
          signal,
          onProgress: (progress) => {
            status.current = progress.current
            status.total = progress.total
            status.message = progress.message
          }
        }
      )
      status = {
        ...status,
        phase: 'idle',
        current: files.length,
        total: files.length,
        scannedAt: new Date().toISOString(),
        scannedFileCount: result.scannedFileCount,
        skippedFileCount: skipped,
        issues: [...result.issues].sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        ),
        errors: result.errors,
        message:
          result.issues.length === 0
            ? 'No broken chapters were found.'
            : `${result.issues.length.toLocaleString()} file(s) have broken chapters.`
      }
      await save()
    } catch (error) {
      const cancelled = error instanceof OperationCancelledError || signal.aborted
      status = {
        ...status,
        phase: 'idle',
        message: cancelled ? 'The scan was cancelled. The earlier result was cleared.' : `The scan failed: ${errorMessage(error)}`
      }
      if (!cancelled) console.error('Library health scan failed:', error)
    } finally {
      abort = null
      context.activeLibraryOperationHandlers -= 1
    }
  }

  async function repairOne(issue: LibraryHealthIssue, signal: AbortSignal): Promise<LibraryHealthRepairResult> {
    let operationId: string | null = null
    try {
      const inputPath = await getIndexedLibraryFile(issue.fileId)
      const outputPath = join(
        dirname(inputPath),
        `${basename(inputPath, extname(inputPath))}-repaired.epub`
      )
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
      const result = await runWorker<EpubRepairProgress, EpubRepairResult>(worker, {
        workerName: 'EPUB repair',
        missingResultMessage: 'EPUB repair worker exited without creating an EPUB.',
        signal,
        onProgress: (progress) => {
          status.message = `${issue.filename}: ${progress.message}`
          void updateLibraryOperation(trackedOperationId, {
            progress: progress.percentage,
            message: progress.message
          })
        }
      })
      await updateLibraryOperation(
        operationId,
        {
          status: 'completed',
          outputPath: result.outputPath,
          progress: 100,
          message: `Cleaned ${result.repairedMarkupChapters.toLocaleString()} chapter(s) with page code.`,
          error: ''
        },
        true
      )
      return {
        fileId: issue.fileId,
        filename: issue.filename,
        ok: true,
        outputPath: result.outputPath,
        repairedChapters: result.repairedMarkupChapters,
        error: ''
      }
    } catch (error) {
      if (error instanceof OperationCancelledError) throw error
      if (operationId) {
        await updateLibraryOperation(
          operationId,
          { status: 'failed', message: 'EPUB check and repair failed.', error: errorMessage(error) },
          true
        )
      }
      console.error('Library health repair failed:', error)
      return {
        fileId: issue.fileId,
        filename: issue.filename,
        ok: false,
        outputPath: '',
        repairedChapters: 0,
        error: errorMessage(error)
      }
    }
  }

  async function runRepairs(issues: LibraryHealthIssue[], signal: AbortSignal): Promise<void> {
    context.activeLibraryOperationHandlers += 1
    try {
      for (const [index, issue] of issues.entries()) {
        if (signal.aborted) break
        status.current = index
        status.message = `Repairing ${issue.filename} (${(index + 1).toLocaleString()} of ${issues.length.toLocaleString()})`
        const result = await repairOne(issue, signal)
        status.repairResults = [...status.repairResults, result]
        if (result.ok) {
          status.issues = status.issues.map((candidate) =>
            candidate.fileId === issue.fileId
              ? { ...candidate, repairedPath: result.outputPath }
              : candidate
          )
          await save()
        }
      }
      const failed = status.repairResults.filter((result) => !result.ok).length
      status = {
        ...status,
        phase: 'idle',
        current: issues.length,
        message: signal.aborted
          ? 'Repair stopped. Files that were already repaired keep their repaired copy.'
          : failed > 0
            ? `Repair finished with ${failed.toLocaleString()} failure(s).`
            : 'Repair finished. Scan the library to index the repaired copies.'
      }
    } catch (error) {
      status = {
        ...status,
        phase: 'idle',
        message:
          error instanceof OperationCancelledError
            ? 'Repair stopped. Files that were already repaired keep their repaired copy.'
            : `Repair failed: ${errorMessage(error)}`
      }
    } finally {
      abort = null
      context.activeLibraryOperationHandlers -= 1
    }
  }

  return {
    getLibraryHealthStatus: async (): Promise<Result<LibraryHealthStatus>> => {
      await load()
      return { ok: true, value: snapshot() }
    },
    startLibraryHealthScan: async (): Promise<Result<LibraryHealthStatus>> => {
      await load()
      const busy = busyReason()
      if (busy) return { ok: false, error: busy }
      try {
        const index = await libraryIndexRepository.read()
        if (!index) throw new Error('Scan the library before checking it for broken chapters.')
        const files: LibraryHealthFile[] = index.files
          .filter((file) => file.format === 'EPUB')
          .map((file) => ({
            id: file.id,
            path: file.path,
            relativePath: file.relativePath,
            filename: file.filename,
            folderState: file.folderState
          }))
        abort = new AbortController()
        status = {
          ...emptyStatus(),
          phase: 'scanning',
          total: files.length,
          message: 'Starting the scan…',
          skippedFileCount: index.files.length - files.length
        }
        void runScan(files, index.files.length - files.length, abort.signal)
        return { ok: true, value: snapshot() }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
    startLibraryHealthRepair: async (
      fileIds: string[]
    ): Promise<Result<LibraryHealthStatus>> => {
      await load()
      const busy = busyReason()
      if (busy) return { ok: false, error: busy }
      const wanted = new Set(fileIds.slice(0, MAX_REPAIR_FILES))
      const issues = status.issues.filter((issue) => wanted.has(issue.fileId))
      if (issues.length === 0) {
        return { ok: false, error: 'None of the selected files has broken chapters in the last scan.' }
      }
      abort = new AbortController()
      status = {
        ...status,
        phase: 'repairing',
        current: 0,
        total: issues.length,
        message: 'Starting the repair…',
        repairResults: []
      }
      void runRepairs(issues, abort.signal)
      return { ok: true, value: snapshot() }
    },
    cancelLibraryHealth: (): Promise<Result<LibraryHealthStatus>> => {
      abort?.abort()
      return Promise.resolve({ ok: true, value: snapshot() })
    }
  }
}
