export interface AppSettings {
  libraryRoot: string
  trackerCsvPath: string
  outputDirectory: string
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
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
  appTheme: 'light' | 'dark'
}

export type SettingsUpdatePatch = Partial<
  Pick<
    AppSettings,
    | 'scanOldFolder'
    | 'scanOldCompletedFolder'
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
    | 'appTheme'
  >
>

export type SiteExtractionMode = 'automatic' | 'generic-html'

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
