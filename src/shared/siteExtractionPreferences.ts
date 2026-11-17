import { MAX_SITE_EXTRACTION_PREFERENCES, NOVELFULL_HOSTS } from './constants'
import type { SiteExtractionMode, SiteExtractionPreference } from './contracts'

export function normalizeHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
}

export function normalizeSiteHostname(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter a website hostname.')
  const hostname = normalizeHostname(value)
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(
      hostname
    )
  ) {
    throw new Error('Enter a hostname only, such as example.com.')
  }
  return hostname
}

export function normalizeSiteExtractionPreferences(
  value: unknown
): SiteExtractionPreference[] {
  if (!Array.isArray(value) || value.length > MAX_SITE_EXTRACTION_PREFERENCES) {
    throw new Error(
      `Configure no more than ${MAX_SITE_EXTRACTION_PREFERENCES} site extraction preferences.`
    )
  }
  const preferences: SiteExtractionPreference[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) {
      throw new Error('A site extraction preference has an invalid format.')
    }
    const preference = candidate as Record<string, unknown>
    const hostname = normalizeSiteHostname(preference.hostname)
    const mode = preference.mode
    if (mode !== 'automatic' && mode !== 'generic-html' && mode !== 'novelfull') {
      throw new Error(`The extraction mode for ${hostname} is not supported.`)
    }
    if (mode === 'novelfull' && !NOVELFULL_HOSTS.has(hostname)) {
      throw new Error(
        `The NovelFull parser is not compatible with ${hostname}.`
      )
    }
    if (seen.has(hostname))
      throw new Error(
        `A site extraction preference for ${hostname} already exists.`
      )
    seen.add(hostname)
    preferences.push({ hostname, mode })
  }
  return preferences
}

export function isSiteExtractionModeCompatible(
  value: string,
  mode: SiteExtractionMode
): boolean {
  if (mode !== 'novelfull') return true
  try {
    return NOVELFULL_HOSTS.has(normalizeHostname(new URL(value).hostname))
  } catch {
    return false
  }
}

export function siteExtractionModeForUrl(
  value: string,
  preferences: SiteExtractionPreference[]
): SiteExtractionMode {
  const hostname = normalizeSiteHostname(new URL(value).hostname)
  return (
    preferences.find((preference) => preference.hostname === hostname)?.mode ??
    'automatic'
  )
}
