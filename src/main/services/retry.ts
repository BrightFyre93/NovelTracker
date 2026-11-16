import { MAX_TIMER_DELAY_MS } from '../../shared/constants'
import { HttpStatusError, OperationCancelledError } from '../../shared/errors'

export interface RetryOptions {
  attempts: number
  shouldRetry: (error: unknown) => boolean
  signal?: AbortSignal
  cancellationMessage: string
}

export async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
  cancellationMessage = 'Operation was cancelled.'
): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new RangeError('Delay must be a finite, non-negative number.')
  }
  if (signal?.aborted) {
    throw new OperationCancelledError(cancellationMessage)
  }
  if (milliseconds === 0) return

  await new Promise<void>((resolveDelay, rejectDelay) => {
    const deadline = Date.now() + milliseconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      rejectDelay(new OperationCancelledError(cancellationMessage))
    }
    const schedule = (): void => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        cleanup()
        resolveDelay()
        return
      }
      timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }

    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    schedule()
  })
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new RangeError('Retry attempts must be a positive whole number.')
  }

  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) {
      throw new OperationCancelledError(options.cancellationMessage)
    }
    try {
      return await operation()
    } catch (error) {
      if (options.signal?.aborted) {
        throw new OperationCancelledError(options.cancellationMessage)
      }
      if (attempt + 1 >= options.attempts || !options.shouldRetry(error)) {
        throw error
      }

      const retryAfterMs =
        error instanceof HttpStatusError ? error.retryAfterMs : null
      const delayCapMs = Math.min(30_000, 1000 * 2 ** attempt)
      const delayMs =
        retryAfterMs ??
        Math.ceil(delayCapMs / 2 + Math.random() * (delayCapMs / 2))
      await abortableDelay(delayMs, options.signal, options.cancellationMessage)
    }
  }
}
