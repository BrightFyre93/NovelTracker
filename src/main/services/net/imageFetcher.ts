import type { ChapterImage } from '../../../shared/contracts'
import {
  HttpStatusError,
  NoReadableContentError,
  OperationCancelledError,
  TransientNetworkError,
  toMessage
} from '../../../shared/errors'
import {
  APP_USER_AGENT,
  DEFAULT_HTTP_429_RETRY_DELAY_MS,
  EPUB_IMAGE_TYPES,
  HTTP_IMAGE_ACCEPT_HEADER,
  MAX_IMAGE_BYTES,
  type EpubImageMediaType
} from '../../../shared/constants'
import {
  acquireDomainSlot,
  recordDomainRetryAfter,
  validateHttpUrl
} from './requestLimiter'
import { createRequestTimeout, responseRetryAfter } from './httpClient'
import { validatePublicHost } from './hostValidation'

export function imageMediaType(data: Uint8Array): EpubImageMediaType {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) return 'image/png'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...data.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp'
  throw new Error('An image is not a supported JPEG, PNG, GIF, or WebP file.')
}

async function validateImageHost(value: string, pageOrigin: string): Promise<void> {
  const url = new URL(value)
  if (url.origin === pageOrigin) return
  await validatePublicHost(
    value,
    'An image URL points to a non-public host.',
    'The image host could not be verified'
  )
}

export async function fetchImageResource(
  value: unknown,
  sourceUrl: string,
  operationSignal?: AbortSignal
): Promise<ChapterImage> {
  const pageOrigin = new URL(validateHttpUrl(sourceUrl)).origin
  let url = validateHttpUrl(value)

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await validateImageHost(url, pageOrigin)
    const releaseDomain = await acquireDomainSlot(url, operationSignal)
    const controller = new AbortController()
    const requestTimeout = createRequestTimeout(controller)
    const abortOperation = () => controller.abort()
    operationSignal?.addEventListener('abort', abortOperation, { once: true })
    try {
      if (operationSignal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
      const response = await fetch(url, {
        headers: { Accept: HTTP_IMAGE_ACCEPT_HEADER, 'User-Agent': APP_USER_AGENT },
        redirect: 'manual',
        signal: controller.signal
      })
      requestTimeout.beginResponse()
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new Error('The image redirect did not include a destination.')
        const redirectedUrl = validateHttpUrl(new URL(location, url).href)
        await validateImageHost(redirectedUrl, pageOrigin)
        if (redirects === 5) throw new Error('The image redirected too many times.')
        url = redirectedUrl
        continue
      }
      if (!response.ok) {
        const retryAfter =
          responseRetryAfter(response) ??
          (response.status === 429 ? DEFAULT_HTTP_429_RETRY_DELAY_MS : null)
        recordDomainRetryAfter(url, retryAfter)
        throw new HttpStatusError(response.status, retryAfter)
      }
      const finalUrl = validateHttpUrl(response.url || url)
      await validateImageHost(finalUrl, pageOrigin)
      const declaredLength = Number(response.headers.get('content-length') ?? 0)
      if (declaredLength > MAX_IMAGE_BYTES) {
        throw new Error(`An image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB size limit.`)
      }
      if (!response.body) {
        throw new NoReadableContentError('The image response had no readable content.')
      }

      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
      const chunks: Uint8Array[] = []
      let totalLength = 0
      while (true) {
        requestTimeout.refreshResponse()
        const { done, value } = await reader.read()
        if (done) break
        totalLength += value.byteLength
        if (totalLength > MAX_IMAGE_BYTES) {
          await reader.cancel()
          throw new Error(`An image exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB size limit.`)
        }
        chunks.push(value)
      }

      const data = Buffer.concat(chunks, totalLength)
      const mediaType = imageMediaType(data)
      if (!Object.prototype.hasOwnProperty.call(EPUB_IMAGE_TYPES, mediaType)) {
        throw new Error('An image uses an unsupported format.')
      }
      return { sourceUrl: finalUrl, mediaType, dataBase64: data.toString('base64') }
    } catch (error) {
      if (operationSignal?.aborted) throw new OperationCancelledError('EPUB creation was cancelled.')
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TransientNetworkError(requestTimeout.timeoutMessage('The image'))
      }
      if (error instanceof TypeError) {
        throw new TransientNetworkError(toMessage(error))
      }
      throw error
    } finally {
      requestTimeout.clear()
      operationSignal?.removeEventListener('abort', abortOperation)
      releaseDomain()
    }
  }
  throw new Error('The image redirected too many times.')
}

