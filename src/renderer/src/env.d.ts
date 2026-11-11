import type { NovelTrackerApi } from '../../shared/contracts'

declare global {
  interface Window {
    novelTracker: NovelTrackerApi
  }
}

export {}
