import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryResult,
  AppSettings,
  DownloadHistoryEntry,
  GenerateEpubInput,
  LibraryFileCorrection,
  LibraryIndex,
  LibraryProgress,
  JobProgress,
  NovelTrackerApi,
  Result,
  TrackerNovel
} from '../shared/contracts'

const api: NovelTrackerApi = {
  discover: (url) => ipcRenderer.invoke('chapter:discover', url) as Promise<Result<DiscoveryResult>>,
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:choose-output-directory') as Promise<string | null>,
  generateEpub: (input: GenerateEpubInput) => ipcRenderer.invoke('epub:generate', input),
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  chooseLibraryRoot: () => ipcRenderer.invoke('dialog:choose-library-root') as Promise<string | null>,
  chooseTrackerCsv: () => ipcRenderer.invoke('dialog:choose-tracker-csv') as Promise<string | null>,
  getTrackerNovels: () => ipcRenderer.invoke('tracker:list') as Promise<Result<TrackerNovel[]>>,
  getDownloadHistory: () => ipcRenderer.invoke('download-history:list') as Promise<DownloadHistoryEntry[]>,
  getLibraryIndex: () => ipcRenderer.invoke('library:index') as Promise<LibraryIndex | null>,
  scanLibrary: () => ipcRenderer.invoke('library:scan') as Promise<Result<LibraryIndex>>,
  cancelLibraryScan: () => ipcRenderer.invoke('library:cancel-scan') as Promise<void>,
  cancelEpubGeneration: () => ipcRenderer.invoke('epub:cancel-generation') as Promise<void>,
  correctLibraryFile: (fileId: string, correction: LibraryFileCorrection) =>
    ipcRenderer.invoke('library:correct-file', fileId, correction) as Promise<Result<LibraryIndex>>,
  openLibraryPath: (path, reveal) => ipcRenderer.invoke('library:open-path', path, reveal),
  onLibraryProgress: (listener: (progress: LibraryProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: LibraryProgress) => listener(progress)
    ipcRenderer.on('library:progress', handler)
    return () => ipcRenderer.removeListener('library:progress', handler)
  },
  onProgress: (listener: (progress: JobProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: JobProgress) => listener(progress)
    ipcRenderer.on('job:progress', handler)
    return () => ipcRenderer.removeListener('job:progress', handler)
  }
}

contextBridge.exposeInMainWorld('novelTracker', api)
