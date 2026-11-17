import type { Worker } from 'node:worker_threads'
import type { ActiveDownload } from '../services/queue/runtime'

export interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

export class MainProcessState {
  readonly approvedOutputDirectories = new Set<string>()
  readonly reservedOutputPaths = new Set<string>()
  readonly browserAssistedDiscoveries = new Set<string>()
  readonly activeBrowserDiscoveries = new Map<string, AbortController>()
  readonly activeQueueDiscoveries = new Map<string, AbortController>()
  readonly activeDownloads = new Map<string, ActiveDownload>()
  readonly activeLibraryWorkers = new Set<Worker>()
  readonly activeBackgroundTasks = new Set<Promise<void>>()
  activeLibraryScan: ActiveLibraryScan | null = null
  libraryIndexRestoreActive = false
  libraryCorrectionActive = false
  activeLibraryOperationHandlers = 0
  shuttingDown = false
}
