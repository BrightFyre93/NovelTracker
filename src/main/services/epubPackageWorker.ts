import { parentPort, workerData } from 'node:worker_threads'
import type { EpubMergeProgress } from '../../shared/contracts'
import { OperationCancelledError, toMessage } from '../../shared/errors'
import { writeEpubFromArtifactStore } from './epub'
import type { WorkerMessage } from './workerRunner'
import type {
  EpubPackagingInput,
  EpubPackagingResult
} from './epubPackaging'

type PackageWorkerMessage = WorkerMessage<
  EpubMergeProgress,
  EpubPackagingResult
>

if (!parentPort) {
  throw new Error('EPUB packaging worker has no parent message port.')
}

const port = parentPort
const input = workerData as EpubPackagingInput
const controller = new AbortController()
port.on('message', (message: { type?: string }) => {
  if (message.type === 'cancel') controller.abort()
})

async function packageEpub(): Promise<EpubPackagingResult> {
  return writeEpubFromArtifactStore(
    input,
    controller.signal,
    (progress) => {
      port.postMessage({
        type: 'progress',
        progress
      } satisfies PackageWorkerMessage)
    }
  )
}

void packageEpub()
  .then((result) => {
    port.postMessage({
      type: 'complete',
      result
    } satisfies PackageWorkerMessage)
  })
  .catch((error: unknown) => {
    if (controller.signal.aborted || error instanceof OperationCancelledError) {
      port.postMessage({
        type: 'cancelled',
        error: 'EPUB packaging was cancelled.'
      } satisfies PackageWorkerMessage)
    } else {
      port.postMessage({
        type: 'error',
        error: toMessage(error)
      } satisfies PackageWorkerMessage)
    }
  })
  .finally(() => port.close())
