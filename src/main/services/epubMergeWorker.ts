import { parentPort, workerData } from 'node:worker_threads'
import type { EpubMergeProgress } from '../../shared/contracts'
import type { EpubMergeInput, EpubMergeResult } from './epubMerger'
import { mergeEpubFiles } from './epubMerger'
import type { WorkerMessage as WorkerProtocolMessage } from './workerRunner'
import { toMessage } from '../../shared/errors'

type WorkerMessage = WorkerProtocolMessage<EpubMergeProgress, EpubMergeResult>

if (!parentPort)
  throw new Error('EPUB merge worker has no parent message port.')
const port = parentPort
const input = workerData as EpubMergeInput

void mergeEpubFiles(input, (progress) => {
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
