import { parentPort, workerData } from 'node:worker_threads'
import type { EpubRepairProgress, EpubRepairResult } from '../../shared/contracts'
import { repairEpubFile } from './epubRepair'

interface WorkerInput {
  inputPath: string
  outputPath: string
}

type WorkerMessage =
  | { type: 'progress'; progress: EpubRepairProgress }
  | { type: 'complete'; result: EpubRepairResult }
  | { type: 'error'; error: string }

if (!parentPort) throw new Error('EPUB repair worker has no parent message port.')
const port = parentPort
const input = workerData as WorkerInput

void repairEpubFile(input.inputPath, input.outputPath, (progress) => {
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
