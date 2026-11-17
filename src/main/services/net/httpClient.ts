import {
  HttpStatusError,
  NoReadableContentError,
  OperationCancelledError,
  TransientNetworkError,
  toMessage
} from '../../../shared/errors'
import {
  APP_USER_AGENT,
  DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS,
  DEFAULT_HTTP_429_RETRY_DELAY_MS,
  HTTP_MAX_RESPONSE_BYTES
} from '../../../shared/constants'
import {
  acquireDomainSlot,
  recordDomainRetryAfter,
  validateHttpUrl
} from './requestLimiter'
import { validateHtmlRedirect } from './hostValidation'

let httpConnectTimeoutMs = DEFAULT_HTTP_CONNECT_TIMEOUT_MS
let httpResponseReadTimeoutMs = DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS
export function setHttpTimeouts(connectTimeoutMs: number, responseReadTimeoutMs: number): void {
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 ||
    !Number.isSafeInteger(responseReadTimeoutMs) || responseReadTimeoutMs < 1) {
    throw new RangeError('HTTP timeouts must be positive whole numbers of milliseconds.')
  }
  httpConnectTimeoutMs = connectTimeoutMs
  httpResponseReadTimeoutMs = responseReadTimeoutMs
}

function declaredCharset(value: string | null): string | null {
  const match = value?.match(/\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s"']+))/i)
  return match?.[1]?.trim() || match?.[2]?.trim() || match?.[3]?.trim() || null
}

function htmlMetaCharset(bytes: Uint8Array): string | null {
  const prefix = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024))
  const metaTags = prefix.match(/<meta\b[^>]*>/gi) ?? []

  for (const metaTag of metaTags) {
    const directCharset = /\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'/>;]+))/i.exec(metaTag)
    if (directCharset) {
      return directCharset[1]?.trim() || directCharset[2]?.trim() || directCharset[3]?.trim() || null
    }

    const httpEquiv = /\bhttp-equiv\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/i.exec(metaTag)
    if (!httpEquiv) continue
    const httpEquivValue = (httpEquiv[1] || httpEquiv[2] || httpEquiv[3] || '').toLowerCase()
    if (httpEquivValue !== 'content-type') continue

    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(metaTag)
    const charset = declaredCharset(content?.[1] ?? content?.[2] ?? content?.[3] ?? null)
    if (charset) return charset
  }

  return null
}

function decodeHtmlDocument(bytes: Uint8Array, contentType: string): string {
  let bomCharset: string | null = null
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bomCharset = 'utf-8'
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bomCharset = 'utf-16le'
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bomCharset = 'utf-16be'
  }

  const encodings = [
    bomCharset,
    declaredCharset(contentType),
    htmlMetaCharset(bytes),
    'utf-8'
  ].filter((encoding): encoding is string => Boolean(encoding))

  for (const encoding of new Set(encodings)) {
    try {
      return new TextDecoder(encoding).decode(bytes)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }

  return new TextDecoder().decode(bytes)
}

export async function fetchHtml(url: string, operationSignal?: AbortSignal): Promise<{ html: string; finalUrl: string }> {
  let requestUrl = url
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (redirects > 0) await validateHtmlRedirect(requestUrl)
    const releaseDomain = await acquireDomainSlot(requestUrl, operationSignal)
    const controller = new AbortController()
    const requestTimeout = createRequestTimeout(controller)
    const abortOperation = () => controller.abort()
    operationSignal?.addEventListener('abort', abortOperation, { once: true })

    try {
      if (operationSignal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
      const response = await fetch(requestUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': APP_USER_AGENT
        },
        redirect: 'manual',
        signal: controller.signal
      })
      requestTimeout.beginResponse()

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new Error('The page redirect did not include a destination.')
        if (redirects === 5) throw new Error('The page redirected too many times.')
        let redirectDestination: string
        try {
          redirectDestination = new URL(location, requestUrl).href
        } catch {
          throw new Error('The page redirect included an invalid destination.')
        }
        requestUrl = validateHttpUrl(redirectDestination)
        continue
      }

      if (!response.ok) {
        const retryAfterMs =
          responseRetryAfter(response) ??
          (response.status === 429 ? DEFAULT_HTTP_429_RETRY_DELAY_MS : null)
        recordDomainRetryAfter(requestUrl, retryAfterMs)
        throw new HttpStatusError(response.status, retryAfterMs)
      }

      const finalUrl = validateHttpUrl(response.url || requestUrl)
      if (finalUrl !== requestUrl) {
        await response.body?.cancel()
        throw new Error('The page request followed an unexpected redirect.')
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !/html|xhtml/i.test(contentType)) {
        throw new Error('The URL did not return an HTML page.')
      }

      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (declaredLength > HTTP_MAX_RESPONSE_BYTES) {
        throw new Error('The page is too large to process safely.')
      }

      if (!response.body) {
        throw new NoReadableContentError('The page response had no readable content.')
      }

      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const chunks: Uint8Array[] = []
      let totalLength = 0

      while (true) {
        requestTimeout.refreshResponse()
        const { done, value } = await reader.read()
        if (done) break
        totalLength += value.byteLength
        if (totalLength > HTTP_MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('The page is too large to process safely.')
        }
        chunks.push(value)
      }

      const bytes = Buffer.concat(chunks, totalLength)
      return { html: decodeHtmlDocument(bytes, contentType), finalUrl }
    } catch (error) {
      if (operationSignal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TransientNetworkError(requestTimeout.timeoutMessage('The page'))
      }
      if (error instanceof TypeError)
        throw new TransientNetworkError(toMessage(error))
      throw error
    } finally {
      requestTimeout.clear()
      operationSignal?.removeEventListener('abort', abortOperation)
      releaseDomain()
    }
  }
  throw new Error('The page redirected too many times.')
}

export function createRequestTimeout(controller: AbortController): {
  beginResponse: () => void
  refreshResponse: () => void
  clear: () => void
  timeoutMessage: (resource: string) => string
} {
  let phase: 'connect' | 'response' = 'connect'
  let timer: ReturnType<typeof setTimeout>
  const arm = (nextPhase: 'connect' | 'response'): void => {
    phase = nextPhase
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(),
      nextPhase === 'connect'
        ? httpConnectTimeoutMs
        : httpResponseReadTimeoutMs
    )
  }
  arm('connect')
  return {
    beginResponse: () => arm('response'),
    refreshResponse: () => {
      if (phase === 'response') arm('response')
    },
    clear: () => clearTimeout(timer),
    timeoutMessage: (resource) => phase === 'connect'
      ? `${resource} connection timed out.`
      : `${resource} response timed out.`
  }
}

export function responseRetryAfter(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  const retryDate = Date.parse(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0 && Number.isFinite(seconds * 1000)) return seconds * 1000
  return Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : null
}

