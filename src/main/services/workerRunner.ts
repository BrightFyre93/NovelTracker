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
  onCancel?: () => void
  cancelTimeoutMs?: number
}

export function runWorker<Progress, Result>(
  worker: Worker,
  options: WorkerRunnerOptions<Progress>
): Promise<Result> {
  return new Promise((resolve, reject) => {
    let settled = false
    let completion: { result: Result } | null = null
    let cancelTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      options.signal?.removeEventListener('abort', onAbort)
      if (cancelTimer) {
        clearTimeout(cancelTimer)
        cancelTimer = null
      }
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
      if (options.signal?.aborted) {
        rejectOnce(new OperationCancelledError(`${options.workerName} was cancelled.`))
        return
      }
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
      if (options.onCancel) {
        try {
          options.onCancel()
        } catch (error) {
          rejectOnce(
            error instanceof Error ? error : new Error(String(error))
          )
          void worker.terminate().catch((terminateError: unknown) => {
            console.error(
              `${options.workerName} worker could not be terminated:`,
              terminateError
            )
          })
          return
        }
        cancelTimer = setTimeout(() => {
          const error = new OperationCancelledError(
            `${options.workerName} did not stop after cancellation.`
          )
          void worker.terminate().then(
            () => rejectOnce(error),
            (terminateError: unknown) => {
              console.error(
                `${options.workerName} worker could not be terminated:`,
                terminateError
              )
              rejectOnce(error)
            }
          )
        }, options.cancelTimeoutMs ?? 5000)
        return
      }
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
