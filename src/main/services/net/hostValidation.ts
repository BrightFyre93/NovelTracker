import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { TransientNetworkError, isNodeError, toMessage } from '../../../shared/errors'

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (isIP(normalized) === 4) {
    const [first, second, third] = normalized.split('.').map(Number)
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && third === 113)
    )
  }
  if (isIP(normalized) === 6) {
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('::ffff:') ||
      /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    )
  }
  return false
}

export async function validatePublicHost(
  value: string,
  nonPublicMessage: string,
  lookupFailurePrefix: string
): Promise<void> {
  const hostname = new URL(value).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error(nonPublicMessage)
  }

  let addresses: { address: string }[]
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    const message = `${lookupFailurePrefix}: ${toMessage(error)}.`
    if (isNodeError(error) && ['EAI_AGAIN', 'ETIMEOUT'].includes(error.code)) {
      throw new TransientNetworkError(message)
    }
    throw new Error(message)
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error(nonPublicMessage)
  }
}

export async function validateHtmlRedirect(value: string): Promise<void> {
  await validatePublicHost(
    value,
    'A page redirect points to a non-public host.',
    'The redirected page host could not be verified'
  )
}

