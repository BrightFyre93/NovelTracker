import { parentPort, workerData } from 'node:worker_threads'
import type { LibraryProgress } from '../../shared/contracts'
import { OperationCancelledError, toMessage } from '../../shared/errors'
import { createJsonLibraryIndexRepository } from './library/libraryIndexRepository'
import { scanLibrary } from './libraryScanner'
import type { WorkerMessage } from './workerRunner'

interface LibraryScanWorkerInput {
  libraryRoot: string
  dataDirectory: string
  forceRebuild?: boolean
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
}

type LibraryScanWorkerMessage = WorkerMessage<LibraryProgress, void>

function getWorkerPort(): NonNullable<typeof parentPort> {
  if (!parentPort)
    throw new Error('Library scan worker has no parent message port.')
  return parentPort
}

const port = getWorkerPort()
const input = workerData as LibraryScanWorkerInput
const libraryIndexRepository = createJsonLibraryIndexRepository(
  () => input.dataDirectory
)
const controller = new AbortController()
port.on('message', (message: { type?: string }) => {
  if (message?.type === 'cancel') controller.abort()
})

async function run(): Promise<void> {
  const previousIndex = input.forceRebuild
    ? null
    : await libraryIndexRepository.read()
  const index = await scanLibrary(
    input.libraryRoot,
    previousIndex,
    controller.signal,
    (progress) =>
      port.postMessage({
        type: 'progress',
        progress
      } satisfies LibraryScanWorkerMessage),
    {
      scanOldFolder: input.scanOldFolder,
      scanOldCompletedFolder: input.scanOldCompletedFolder
    }
  )
  if (controller.signal.aborted)
    throw new OperationCancelledError('Library scan cancelled.')
  port.postMessage({
    type: 'progress',
    progress: {
      stage: 'save',
      current: 1,
      total: 1,
      discoveredFiles: index.files.length,
      indexedFiles: index.files.length,
      totalFiles: index.files.length,
      message: 'Saving library index…'
    }
  } satisfies LibraryScanWorkerMessage)
  await libraryIndexRepository.write(
    index,
    input.forceRebuild ? undefined : previousIndex
  )
  port.postMessage({
    type: 'complete',
    result: undefined
  } satisfies LibraryScanWorkerMessage)
}

void run()
  .catch((error: unknown) => {
    port.postMessage({
      type: error instanceof OperationCancelledError ? 'cancelled' : 'error',
      error: toMessage(error)
    } satisfies LibraryScanWorkerMessage)
  })
  .finally(() => port.close())
