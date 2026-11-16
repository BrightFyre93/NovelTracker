export interface AppSettings {
  libraryRoot: string
  trackerCsvPath: string
  outputDirectory: string
  scanOldFolder: boolean
  scanOldCompletedFolder: boolean
  maxSimultaneousDownloads: number
  maxSimultaneousDiscoveries: number
  maxSimultaneousChaptersPerNovel: number
  domainRequestDelays: DomainRequestDelayPreference[]
  discoveryFreshnessHours: number
  siteExtractionPreferences: SiteExtractionPreference[]
  epubCss: string
  appTheme: 'light' | 'dark'
}

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
