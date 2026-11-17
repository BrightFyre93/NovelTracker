import type { MainIpcDependencies } from './mainProcess'
import { registerSettingsIpcHandlers } from '../ipc/settings'
import { registerQueueIpcHandlers } from '../ipc/queue'
import { registerLibraryIpcHandlers } from '../ipc/library'
import { registerBrowserIpcHandlers } from '../ipc/browser'
import { registerDialogsIpcHandlers } from '../ipc/dialogs'
export function registerMainIpcHandlers(
  dependencies: MainIpcDependencies
): void {
  function ipcModuleContext<Key extends keyof typeof dependencies>(
    ...keys: Key[]
  ): Pick<typeof dependencies, Key> {
    const projected: Partial<typeof dependencies> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(dependencies, key)
      if (descriptor?.get || descriptor?.set) {
        const projectedDescriptor: PropertyDescriptor = {
          enumerable: true,
          configurable: true
        }
        if (descriptor.get) projectedDescriptor.get = () => dependencies[key]
        if (descriptor.set) {
          projectedDescriptor.set = (value: (typeof dependencies)[Key]) => {
            ;(dependencies as unknown as Record<string, unknown>)[key] = value
          }
        }
        Object.defineProperty(projected, key, projectedDescriptor)
      } else {
        ;(projected as Record<string, unknown>)[key] = dependencies[key]
      }
    }
    return projected as Pick<typeof dependencies, Key>
  }

  registerSettingsIpcHandlers(
    ipcModuleContext('handle', 'settingsService', 'settingsUpdatePatchSchema')
  )
  registerQueueIpcHandlers(
    ipcModuleContext(
      'MAX_SELECTED_CHAPTERS',
      'activeDownloads',
      'activeQueueDiscoveries',
      'archiveRemovedJobs',
      'assertOutputPathAvailable',
      'browserAssistedDiscoveries',
      'chapterStateRepository',
      'clearDirtyChapterData',
      'copyDiscoveryQueue',
      'copyQueueItem',
      'createQueueItem',
      'dataDirectory',
      'discoveryQueue',
      'discoveryQueueRevision',
      'discoveryScheduler',
      'downloadScheduler',
      'errorMessage',
      'expectedOutputPath',
      'handle',
      'libraryIndexRepository',
      'markQueueItemChaptersDirty',
      'mutateItem',
      'notifyDiscoveryQueueChanged',
      'parseDiscoveryQueueInputs',
      'parseGenerateInput',
      'persistDiscoveryQueue',
      'persistDiscoveryQueueOrRollback',
      'persistDownloadState',
      'projectDownloadHistory',
      'queueStore',
      'readArchivedDownloadHistory',
      'readTrackerCsv',
      'recommendArchiveCoverage',
      'removeChapterArtifacts',
      'resolveChapterSelection',
      'siteExtractionModeForUrl',
      'settingsService',
      'transitionQueueItem',
      'updateQueueChapterSummary',
      'withChapters'
    )
  )
  registerLibraryIpcHandlers(
    ipcModuleContext(
      'MAX_EPUB_MERGE_TOTAL_SOURCE_BYTES',
      'MAX_SELECTED_CHAPTERS',
      'OperationCancelledError',
      'activeLibraryOperationHandlers',
      'activeLibraryScan',
      'copyLibraryOperations',
      'dataDirectory',
      'errorMessage',
      'getIndexedLibraryFile',
      'getSiblingOutputPath',
      'handle',
      'isNodeError',
      'libraryCorrectionActive',
      'libraryIndexRepository',
      'libraryIndexRestoreActive',
      'mainWindow',
      'normalizeNovelTitleForMatching',
      'runWorker',
      'samePath',
      'sanitizeEpubFilename',
      'sendToCurrentFrame',
      'settingsService',
      'shuttingDown',
      'startLibraryOperation',
      'summarizeLibraryIndex',
      'summarizeLibraryIndexOverview',
      'trackLibraryWorker',
      'updateLibraryOperation'
    )
  )
  registerBrowserIpcHandlers(
    ipcModuleContext(
      'activeBrowserDiscoveries',
      'clearBrowserSession',
      'dataDirectory',
      'discoverChapters',
      'discoverChaptersUsingPageLoader',
      'handle',
      'openVerificationBrowser',
      'readBrowserPage',
      'shuttingDown'
    )
  )
  registerDialogsIpcHandlers(
    ipcModuleContext(
      'approvedOutputDirectories',
      'handle',
      'isNodeError',
      'mainWindow',
      'settingsService'
    )
  )
}
