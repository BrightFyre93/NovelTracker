import type { EpubOutputPreferences } from './epub'

export interface AppSettings {
  libraryRoot: string
  trackerCsvPath: string
  outputDirectory: string
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
  omitHttp404Chapters: boolean
  maxSimultaneousDownloads: number
  maxDownloadRetryAttempts: number
  httpConnectTimeoutMs: number
  httpResponseReadTimeoutMs: number
  maxSimultaneousDiscoveries: number
  maxSimultaneousChaptersPerNovel: number
  domainRequestDelays: DomainRequestDelayPreference[]
  discoveryFreshnessHours: number
  siteExtractionPreferences: SiteExtractionPreference[]
  epubCss: string
  epubOutputPreferences: EpubOutputPreferences
  appTheme: 'light' | 'dark'
}

export type SettingsUpdatePatch = Partial<
  Pick<
    AppSettings,
    | 'scanOldFolder'
    | 'scanOldCompletedFolder'
    | 'omitHttp404Chapters'
    | 'maxSimultaneousDownloads'
    | 'maxDownloadRetryAttempts'
    | 'httpConnectTimeoutMs'
    | 'httpResponseReadTimeoutMs'
    | 'maxSimultaneousDiscoveries'
    | 'maxSimultaneousChaptersPerNovel'
    | 'domainRequestDelays'
    | 'discoveryFreshnessHours'
    | 'siteExtractionPreferences'
    | 'epubCss'
    | 'epubOutputPreferences'
    | 'appTheme'
  >
>

export type SiteExtractionMode = 'automatic' | 'generic-html' | 'novelfull'

export interface SiteExtractionPreference {
  hostname: string
  mode: SiteExtractionMode
}

export interface DomainRequestDelayPreference {
  hostname: string
  delayMs: number
}

export interface BrowserSessionInfo {
  title: string
}
