import type { Worker } from 'node:worker_threads'
import { OperationCancelledError } from '../../shared/errors'

export type WorkerMessage<Progress, Result> =
  | { type: 'progress'; progress: Progress }
  | { type: 'complete'; result: Result }
  | { type: 'error'; error: string }
  | { type: 'cancelled'; error: string }

export interface WorkerRunnerOptions<Progress> {
  workerName: string
  missingResultMessage: string
  onProgress: (progress: Progress) => void
  signal?: AbortSignal
}

export function runWorker<Progress, Result>(
  worker: Worker,
  options: WorkerRunnerOptions<Progress>
): Promise<Result> {
  return new Promise((resolve, reject) => {
    let settled = false
    let completion: { result: Result } | null = null

    const cleanup = (): void => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      options.signal?.removeEventListener('abort', onAbort)
    }

    const resolveOnce = (result: Result): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onMessage = (message: WorkerMessage<Progress, Result>): void => {
      if (message.type === 'progress') {
        try {
          options.onProgress(message.progress)
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error(String(error)))
        }
      } else if (message.type === 'complete') {
        completion = { result: message.result }
      } else if (message.type === 'cancelled') {
        rejectOnce(new OperationCancelledError(message.error))
      } else {
        rejectOnce(new Error(message.error || `${options.workerName} failed.`))
      }
    }

    const onError = (error: Error): void => rejectOnce(error)
    const onExit = (code: number): void => {
      if (settled) return
      if (code !== 0) {
        rejectOnce(
          new Error(
            `${options.workerName} worker exited unexpectedly (code ${code}).`
          )
        )
      } else if (completion) {
        resolveOnce(completion.result)
      } else {
        rejectOnce(new Error(options.missingResultMessage))
      }
    }
    const onAbort = (): void => {
      rejectOnce(
        new OperationCancelledError(`${options.workerName} was cancelled.`)
      )
      void worker.terminate().catch((error: unknown) => {
        console.error(
          `${options.workerName} worker could not be terminated:`,
          error
        )
      })
    }

    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}
