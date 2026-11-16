export type ResultErrorCode =
  | 'invalid-arguments'
  | 'cancelled'
  | 'verification-required'
  | 'no-readable-content'
  | 'transient-network'
  | 'http-status'
  | 'filesystem'
  | 'operation-failed'

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: ResultErrorCode }
