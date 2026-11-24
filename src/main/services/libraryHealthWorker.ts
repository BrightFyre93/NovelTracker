import { parentPort, workerData } from 'node:worker_threads'
import { toMessage } from '../../shared/errors'
import {
  scanLibraryForEscapedMarkup,
  type LibraryHealthFile,
  type LibraryHealthWorkerProgress,
  type LibraryHealthWorkerResult
} from './libraryHealthScan'
import type { WorkerMessage as WorkerProtocolMessage } from './workerRunner'

interface WorkerInput {
  files: LibraryHealthFile[]
}

type WorkerMessage = WorkerProtocolMessage<
  LibraryHealthWorkerProgress,
  LibraryHealthWorkerResult
>

if (!parentPort) throw new Error('Library health worker has no parent message port.')
const port = parentPort
const input = workerData as WorkerInput

void scanLibraryForEscapedMarkup(input.files, (progress) => {
  port.postMessage({ type: 'progress', progress } satisfies WorkerMessage)
})
  .then((result) =>
    port.postMessage({ type: 'complete', result } satisfies WorkerMessage)
  )
  .catch((error: unknown) => {
    port.postMessage({
      type: 'error',
      error: toMessage(error)
    } satisfies WorkerMessage)
  })
  .finally(() => port.close())
