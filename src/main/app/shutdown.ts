import type { App } from 'electron'
import type { Worker } from 'node:worker_threads'

interface ActiveDownloadForShutdown {
  requestedAction: string
  controller: AbortController
}

interface ShutdownDependencies {
  setShuttingDown: () => void
  clearDiscoveryQueueNotifications: () => void
  clearDiscoveryScheduler: () => void
  browserAssistedDiscoveries: Set<string>
  activeQueueDiscoveries: Map<string, AbortController>
  activeBrowserDiscoveries: Map<string, AbortController>
  activeDownloads: Map<string, ActiveDownloadForShutdown>
  cancelLibraryScan: () => void
  activeLibraryWorkers: Set<Worker>
  isWorkActive: () => boolean
  closeBrowserSession: () => Promise<void>
  drainWrites: () => Promise<void>
  flushLibraryOperations: () => Promise<void>
  closeDatabase: () => void
  temporaryDirectories: () => string[]
  sweepTemporaryFiles: (directories: Iterable<string>) => Promise<void>
  flushLogger: () => Promise<void>
}

export function registerShutdownHandlers(
  app: App,
  dependencies: ShutdownDependencies
): void {
  let shutdownComplete = false
  let shutdownPromise: Promise<void> | null = null

  async function drainApplicationWork(): Promise<void> {
    dependencies.setShuttingDown()
    dependencies.clearDiscoveryScheduler()
    dependencies.browserAssistedDiscoveries.clear()
    dependencies.clearDiscoveryQueueNotifications()

    for (const controller of dependencies.activeQueueDiscoveries.values())
      controller.abort()
    for (const controller of dependencies.activeBrowserDiscoveries.values())
      controller.abort()
    for (const active of dependencies.activeDownloads.values()) {
      if (active.requestedAction === 'none') active.requestedAction = 'shutdown'
      active.controller.abort()
    }
    dependencies.cancelLibraryScan()

    const workerResults = await Promise.allSettled(
      [...dependencies.activeLibraryWorkers].map((worker) => worker.terminate())
    )
    for (const result of workerResults) {
      if (result.status === 'rejected')
        console.error(
          'A worker could not be terminated during shutdown:',
          result.reason
        )
    }

    const deadline = Date.now() + 15_000
    while (dependencies.isWorkActive() && Date.now() < deadline) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25))
    }
    if (dependencies.isWorkActive()) {
      console.warn(
        'Shutdown continued after the work-drain deadline; some operations did not settle.'
      )
    }

    try {
      await dependencies.closeBrowserSession()
    } catch (error) {
      console.error('The browser session could not be closed cleanly:', error)
    }

    await dependencies.drainWrites()
    await dependencies.flushLibraryOperations()
    try {
      dependencies.closeDatabase()
    } catch (error) {
      console.error('The SQLite database could not be closed cleanly:', error)
    }
    dependencies.clearDiscoveryQueueNotifications()
    try {
      await dependencies.sweepTemporaryFiles(dependencies.temporaryDirectories())
    } catch (error) {
      console.error(
        'NovelTracker temporary files could not be swept during shutdown:',
        error
      )
    }
    await dependencies.flushLogger()
  }

  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownPromise) return
    shutdownPromise = drainApplicationWork()
      .catch((error: unknown) => {
        console.error('Application shutdown did not complete cleanly:', error)
      })
      .finally(() => {
        shutdownComplete = true
        app.quit()
      })
  })
}
