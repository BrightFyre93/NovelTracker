import type {
  AppSettings,
  DomainRequestDelayPreference,
  SettingsUpdatePatch,
  SiteExtractionPreference
} from './contracts'
import {
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_DOWNLOAD_RETRY_ATTEMPTS,
  MAX_DOMAIN_REQUEST_PREFERENCES,
  MAX_EPUB_CSS_LENGTH,
  MAX_HTTP_CONNECT_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DISCOVERIES,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_SITE_EXTRACTION_PREFERENCES,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_DOWNLOAD_RETRY_ATTEMPTS,
  MIN_HTTP_CONNECT_TIMEOUT_MS,
  MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DISCOVERIES,
  MIN_SIMULTANEOUS_DOWNLOADS
} from './constants'
import { z } from 'zod'
import { epubOutputPreferencesSchema } from './epubOutputOptions'

function integerInRange(
  minimum: number,
  maximum: number,
  message: string
): z.ZodType<number> {
  return z.custom<number>(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum,
    message
  )
}

export const settingsUpdatePatchSchema: z.ZodType<SettingsUpdatePatch> = z
  .object({
    epubCss: z
      .custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= MAX_EPUB_CSS_LENGTH,
        `EPUB CSS must be text of at most ${MAX_EPUB_CSS_LENGTH.toLocaleString()} characters.`
      )
      .optional(),
    epubOutputPreferences: epubOutputPreferencesSchema.optional(),
    appTheme: z
      .custom<AppSettings['appTheme']>(
        (value): value is AppSettings['appTheme'] =>
          value === 'light' || value === 'dark' || value === 'system',
        'The app theme must be light, dark, or follow the system.'
      )
      .optional(),
    discoveryFreshnessHours: integerInRange(
      MIN_DISCOVERY_FRESHNESS_HOURS,
      MAX_DISCOVERY_FRESHNESS_HOURS,
      `The discovery freshness window must be a whole number from ${MIN_DISCOVERY_FRESHNESS_HOURS} to ${MAX_DISCOVERY_FRESHNESS_HOURS} hours.`
    ).optional(),
    maxSimultaneousDownloads: integerInRange(
      MIN_SIMULTANEOUS_DOWNLOADS,
      MAX_SIMULTANEOUS_DOWNLOADS,
      `Maximum simultaneous downloads must be a whole number from ${MIN_SIMULTANEOUS_DOWNLOADS} to ${MAX_SIMULTANEOUS_DOWNLOADS}.`
    ).optional(),
    maxDownloadRetryAttempts: integerInRange(
      MIN_DOWNLOAD_RETRY_ATTEMPTS,
      MAX_DOWNLOAD_RETRY_ATTEMPTS,
      `Maximum download attempts must be a whole number from ${MIN_DOWNLOAD_RETRY_ATTEMPTS} to ${MAX_DOWNLOAD_RETRY_ATTEMPTS}.`
    ).optional(),
    httpConnectTimeoutMs: integerInRange(
      MIN_HTTP_CONNECT_TIMEOUT_MS,
      MAX_HTTP_CONNECT_TIMEOUT_MS,
      `The connection timeout must be a whole number from ${MIN_HTTP_CONNECT_TIMEOUT_MS} to ${MAX_HTTP_CONNECT_TIMEOUT_MS} milliseconds.`
    ).optional(),
    httpResponseReadTimeoutMs: integerInRange(
      MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
      MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
      `The response timeout must be a whole number from ${MIN_HTTP_RESPONSE_READ_TIMEOUT_MS} to ${MAX_HTTP_RESPONSE_READ_TIMEOUT_MS} milliseconds.`
    ).optional(),
    maxSimultaneousDiscoveries: integerInRange(
      MIN_SIMULTANEOUS_DISCOVERIES,
      MAX_SIMULTANEOUS_DISCOVERIES,
      `Maximum simultaneous discoveries must be a whole number from ${MIN_SIMULTANEOUS_DISCOVERIES} to ${MAX_SIMULTANEOUS_DISCOVERIES}.`
    ).optional(),
    maxSimultaneousChaptersPerNovel: integerInRange(
      MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
      MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
      `Maximum chapter requests per novel must be a whole number from ${MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL} to ${MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL}.`
    ).optional(),
    domainRequestDelays: z
      .custom<DomainRequestDelayPreference[]>(
        (value): value is DomainRequestDelayPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_DOMAIN_REQUEST_PREFERENCES,
        `Configure no more than ${MAX_DOMAIN_REQUEST_PREFERENCES} domain request delays.`
      )
      .optional(),
    siteExtractionPreferences: z
      .custom<SiteExtractionPreference[]>(
        (value): value is SiteExtractionPreference[] =>
          Array.isArray(value) &&
          value.length <= MAX_SITE_EXTRACTION_PREFERENCES,
        `Configure no more than ${MAX_SITE_EXTRACTION_PREFERENCES} site extraction preferences.`
      )
      .optional(),
    scanOldFolder: z
      .custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old-folder scan option must be enabled or disabled.'
      )
      .optional(),
    scanOldCompletedFolder: z
      .custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The Old Completed-folder scan option must be enabled or disabled.'
      )
      .optional(),
    omitHttp404Chapters: z
      .custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'The HTTP 404 chapter omission policy must be enabled or disabled.'
      )
      .optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one setting to update.'
  })
