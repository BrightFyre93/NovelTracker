import {
  MAX_DOMAIN_REQUEST_DELAY_MS,
  MAX_DOMAIN_REQUEST_PREFERENCES,
  MIN_DOMAIN_REQUEST_DELAY_MS
} from './constants'
import type { DomainRequestDelayPreference } from './contracts'
import { normalizeSiteHostname } from './siteExtractionPreferences'

export function normalizeDomainRequestDelays(value: unknown): DomainRequestDelayPreference[] {
  if (!Array.isArray(value) || value.length > MAX_DOMAIN_REQUEST_PREFERENCES) {
    throw new Error(`Configure no more than ${MAX_DOMAIN_REQUEST_PREFERENCES} domain request delays.`)
  }

  const preferences: DomainRequestDelayPreference[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error('A domain request delay has an invalid format.')
    }
    const preference = candidate as Record<string, unknown>
    const hostname = normalizeSiteHostname(preference.hostname)
    const delayMs = preference.delayMs
    if (
      typeof delayMs !== 'number' ||
      !Number.isInteger(delayMs) ||
      delayMs < MIN_DOMAIN_REQUEST_DELAY_MS ||
      delayMs > MAX_DOMAIN_REQUEST_DELAY_MS
    ) {
      throw new Error(
        `The request delay for ${hostname} must be a whole number from ${MIN_DOMAIN_REQUEST_DELAY_MS} to ${MAX_DOMAIN_REQUEST_DELAY_MS} milliseconds.`
      )
    }
    if (seen.has(hostname)) throw new Error(`A domain request delay for ${hostname} already exists.`)
    seen.add(hostname)
    preferences.push({ hostname, delayMs })
  }
  return preferences.sort((left, right) => left.hostname.localeCompare(right.hostname))
}
