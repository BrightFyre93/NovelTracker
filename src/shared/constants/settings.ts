export const MAX_SITE_EXTRACTION_PREFERENCES = 50

export const DEFAULT_DISCOVERY_FRESHNESS_HOURS = 24

export const MIN_DISCOVERY_FRESHNESS_HOURS = 1

export const MAX_DISCOVERY_FRESHNESS_HOURS = 720

export const MIN_DOMAIN_REQUEST_DELAY_MS = 0

export const MAX_DOMAIN_REQUEST_DELAY_MS = 60_000

export const MAX_DOMAIN_REQUEST_PREFERENCES = 50

export const DEFAULT_DOMAIN_REQUEST_DELAY_MS = 250

export const DOMAIN_REQUEST_DELAYS_MS: Readonly<Record<string, number>> = {
  'novelfull.com': 250,
  'novelfull.net': 1000
}
