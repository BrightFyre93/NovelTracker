import type { Result, ResultErrorCode } from './contracts/common'

export function unwrapResult<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  )
}

export class OperationCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationCancelledError'
  }
}

export class VerificationRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationRequiredError'
  }
}

export class NoReadableContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoReadableContentError'
  }
}

export class TransientNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientNetworkError'
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(`The page returned HTTP ${status}.`)
    this.name = 'HttpStatusError'
  }
}

export function errorCode(error: unknown): ResultErrorCode {
  if (error instanceof OperationCancelledError) return 'cancelled'
  if (error instanceof VerificationRequiredError) return 'verification-required'
  if (error instanceof NoReadableContentError) return 'no-readable-content'
  if (error instanceof TransientNetworkError) return 'transient-network'
  if (error instanceof HttpStatusError) return 'http-status'
  if (isNodeError(error)) return 'filesystem'
  return 'operation-failed'
}
