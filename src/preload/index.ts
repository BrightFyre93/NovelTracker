import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryResult,
  GenerateEpubInput,
  JobProgress,
  NovelTrackerApi,
  Result
} from '../shared/contracts'

const api: NovelTrackerApi = {
  discover: (url) => ipcRenderer.invoke('chapter:discover', url) as Promise<Result<DiscoveryResult>>,
  chooseOutputDirectory: () => ipcRenderer.invoke('dialog:choose-output-directory') as Promise<string | null>,
  generateEpub: (input: GenerateEpubInput) => ipcRenderer.invoke('epub:generate', input),
  onProgress: (listener: (progress: JobProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: JobProgress) => listener(progress)
    ipcRenderer.on('job:progress', handler)
    return () => ipcRenderer.removeListener('job:progress', handler)
  }
}

contextBridge.exposeInMainWorld('novelTracker', api)
