import type { DomainRequestDelayPreference } from '../../../shared/contracts'
import { OperationCancelledError } from '../../../shared/errors'
import { getDomainRequestDelayMs } from '../../../shared/domainRequestPreferences'
import { normalizeHostname } from '../../../shared/siteExtractionPreferences'
import { MAX_ACTIVE_REQUESTS_PER_DOMAIN } from '../../../shared/constants'

const domainTails = new Map<string, Promise<void>>()
const domainNextRequestAt = new Map<string, number>()
const domainActiveRequests = new Map<string, number>()
const domainRequestWaiters = new Map<string, Set<() => void>>()
let domainRequestDelays = new Map<string, number>()
export function setDomainRequestDelays(preferences: DomainRequestDelayPreference[]): void {
  domainRequestDelays = new Map(preferences.map(({ hostname, delayMs }) => [hostname, delayMs]))
}

export function validateHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL.')
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Only HTTP or HTTPS URLs without embedded credentials are supported.')
  }

  url.hash = ''
  return url.href
}

function releaseDomainRequest(hostname: string): void {
  const active = domainActiveRequests.get(hostname) ?? 0
  if (active <= 1) domainActiveRequests.delete(hostname)
  else domainActiveRequests.set(hostname, active - 1)

  const waiters = domainRequestWaiters.get(hostname)
  const nextWaiter = waiters?.values().next().value
  nextWaiter?.()
}

export function recordDomainRetryAfter(url: string, retryAfterMs: number | null): void {
  if (retryAfterMs === null) return
  const hostname = normalizeHostname(new URL(url).hostname)
  const retryAt = Date.now() + retryAfterMs
  domainNextRequestAt.set(hostname, Math.max(domainNextRequestAt.get(hostname) ?? 0, retryAt))
}

export async function acquireDomainSlot(url: string, signal?: AbortSignal): Promise<() => void> {
  const hostname = normalizeHostname(new URL(url).hostname)
  const requestDelayMs = getDomainRequestDelayMs(hostname, domainRequestDelays)
  const previous = domainTails.get(hostname) ?? Promise.resolve()
  let release!: () => void
  const hold = new Promise<void>((resolveHold) => {
    release = resolveHold
  })
  const tail = previous.then(() => hold)
  domainTails.set(hostname, tail)
  const removeTailWhenSettled = (): void => {
    if (domainTails.get(hostname) === tail) domainTails.delete(hostname)
  }
  void tail.then(removeTailWhenSettled, removeTailWhenSettled)

  try {
    if (signal) {
      await new Promise<void>((resolveTurn, rejectTurn) => {
        const abort = (): void => {
          signal.removeEventListener('abort', abort)
          rejectTurn(new OperationCancelledError('EPUB creation was cancelled.'))
        }
        signal.addEventListener('abort', abort, { once: true })
        previous.then(() => {
          signal.removeEventListener('abort', abort)
          resolveTurn()
        }, (error: unknown) => {
          signal.removeEventListener('abort', abort)
          rejectTurn(error instanceof Error ? error : new Error(String(error)))
        })
        if (signal.aborted) abort()
      })
    } else {
      await previous
    }
    while ((domainActiveRequests.get(hostname) ?? 0) >= MAX_ACTIVE_REQUESTS_PER_DOMAIN) {
      await new Promise<void>((resolveWait, rejectWait) => {
        let waiters = domainRequestWaiters.get(hostname)
        if (!waiters) {
          waiters = new Set()
          domainRequestWaiters.set(hostname, waiters)
        }
        const cleanup = (): void => {
          waiters?.delete(onAvailable)
          signal?.removeEventListener('abort', abort)
          if (waiters?.size === 0) domainRequestWaiters.delete(hostname)
        }
        const onAvailable = (): void => {
          cleanup()
          resolveWait()
        }
        const abort = (): void => {
          cleanup()
          rejectWait(new OperationCancelledError('EPUB creation was cancelled.'))
        }
        waiters.add(onAvailable)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
    let wait = Math.max(0, (domainNextRequestAt.get(hostname) ?? 0) - Date.now())
    while (wait > 0) {
      await new Promise<void>((resolveWait, rejectWait) => {
        const abort = (): void => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          rejectWait(new OperationCancelledError('EPUB creation was cancelled.'))
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolveWait()
        }, wait)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      wait = Math.max(0, (domainNextRequestAt.get(hostname) ?? 0) - Date.now())
    }
    if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
    domainActiveRequests.set(hostname, (domainActiveRequests.get(hostname) ?? 0) + 1)
    domainNextRequestAt.set(hostname, Date.now() + requestDelayMs)
    release()
    return () => releaseDomainRequest(hostname)
  } catch (error) {
    release()
    throw error
  }
}

export async function withDomainRequestSlot<T>(
  value: unknown,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const url = validateHttpUrl(value)
  const release = await acquireDomainSlot(url, signal)
  try {
    if (signal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
    return await operation()
  } finally {
    release()
  }
}

