import { BrowserWindow } from 'electron'
import { join } from 'node:path'

export class MainWindowManager {
  private currentWindow: BrowserWindow | null = null
  private windowReady = false
  private focusRequestedBeforeWindowReady = false

  get current(): BrowserWindow | null {
    return this.currentWindow
  }

  async create(): Promise<void> {
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 820,
      minHeight: 620,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.currentWindow = window
    this.windowReady = false
    window.once('ready-to-show', () => {
      this.windowReady = true
      window.maximize()
      window.show()
      if (this.focusRequestedBeforeWindowReady) {
        this.focusRequestedBeforeWindowReady = false
        window.focus()
      }
    })

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('unresponsive', () => {
      console.error('Renderer became unresponsive.')
    })
    window.webContents.on('responsive', () => {
      console.info('Renderer became responsive.')
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process exited:', details.reason, details.exitCode)
    })
    window.webContents.on('will-navigate', (event, target) => {
      try {
        const current = new URL(window.webContents.getURL())
        const next = new URL(target)
        if (next.origin !== current.origin || next.protocol !== current.protocol)
          event.preventDefault()
      } catch {
        event.preventDefault()
      }
    })
    window.webContents.on('will-attach-webview', (event) =>
      event.preventDefault()
    )

    if (process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      await window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  focusOrRemember(): void {
    const window = this.currentWindow
    if (!window || window.isDestroyed() || !this.windowReady) {
      this.focusRequestedBeforeWindowReady = true
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
