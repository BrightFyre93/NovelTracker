import { parentPort, workerData } from 'node:worker_threads'
import type { LibraryProgress } from '../../shared/contracts'
import { readLibraryIndex, writeLibraryIndex } from './localStore'
import { scanLibrary } from './libraryScanner'

interface LibraryScanWorkerInput {
  libraryRoot: string
  dataDirectory: string
  forceRebuild?: boolean
  scanOldFolder: boolean
}

type LibraryScanWorkerMessage =
  | { type: 'progress'; progress: LibraryProgress }
  | { type: 'complete' }
  | { type: 'error'; error: string }

function getWorkerPort(): NonNullable<typeof parentPort> {
  if (!parentPort) throw new Error('Library scan worker has no parent message port.')
  return parentPort
}

const port = getWorkerPort()
const input = workerData as LibraryScanWorkerInput
const controller = new AbortController()
port.on('message', (message: { type?: string }) => {
  if (message?.type === 'cancel') controller.abort()
})

async function run(): Promise<void> {
  const previousIndex = input.forceRebuild ? null : await readLibraryIndex(input.dataDirectory)
  const index = await scanLibrary(
    input.libraryRoot,
    previousIndex,
    controller.signal,
    (progress) => port.postMessage({ type: 'progress', progress } satisfies LibraryScanWorkerMessage),
    { scanOldFolder: input.scanOldFolder }
  )
  if (controller.signal.aborted) throw new Error('Library scan cancelled.')
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
  await writeLibraryIndex(input.dataDirectory, index, input.forceRebuild ? undefined : previousIndex)
  port.postMessage({ type: 'complete' } satisfies LibraryScanWorkerMessage)
}

void run()
  .catch((error: unknown) => {
    port.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies LibraryScanWorkerMessage)
  })
  .finally(() => port.close())
