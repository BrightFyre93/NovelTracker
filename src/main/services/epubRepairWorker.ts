import { parentPort, workerData } from 'node:worker_threads'
import type {
  EpubRepairProgress,
  EpubRepairResult
} from '../../shared/contracts'
import { repairEpubFile } from './epubRepair'
import type { WorkerMessage as WorkerProtocolMessage } from './workerRunner'
import { toMessage } from '../../shared/errors'

interface WorkerInput {
  inputPath: string
  outputPath: string
}

type WorkerMessage = WorkerProtocolMessage<EpubRepairProgress, EpubRepairResult>

if (!parentPort)
  throw new Error('EPUB repair worker has no parent message port.')
const port = parentPort
const input = workerData as WorkerInput

void repairEpubFile(input.inputPath, input.outputPath, (progress) => {
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
