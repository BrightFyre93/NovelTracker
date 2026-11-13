import { parentPort, workerData } from 'node:worker_threads'
import type { EpubMergeProgress } from '../../shared/contracts'
import type { EpubMergeInput, EpubMergeResult } from './epubMerger'
import { mergeEpubFiles } from './epubMerger'

type WorkerMessage =
  | { type: 'progress'; progress: EpubMergeProgress }
  | { type: 'complete'; result: EpubMergeResult }
  | { type: 'error'; error: string }

if (!parentPort) throw new Error('EPUB merge worker has no parent message port.')
const port = parentPort
const input = workerData as EpubMergeInput

void mergeEpubFiles(input, (progress) => {
  port.postMessage({ type: 'progress', progress } satisfies WorkerMessage)
})
  .then((result) => port.postMessage({ type: 'complete', result } satisfies WorkerMessage))
  .catch((error: unknown) => {
    port.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    } satisfies WorkerMessage)
  })
  .finally(() => port.close())
