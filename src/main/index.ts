import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AppSettings,
  ChapterLink,
  DownloadHistoryEntry,
  GenerateEpubInput,
  GenerateEpubResult,
  LibraryFileCorrection,
  LibraryIndex,
  LibraryProgress,
  Result
} from '../shared/contracts'
import {
  markInterruptedDownloadJobs,
  readDownloadHistory,
  readLibraryIndex,
  readSettings,
  saveDownloadHistoryEntry,
  writeLibraryCorrection,
  writeSettings
} from './services/localStore'
import { readTrackerCsv } from './services/trackerCsv'
import { fetchChapterContent, discoverChapters, validateHttpUrl } from './services/scraper'
import { writeEpub } from './services/epub'

let mainWindow: BrowserWindow | null = null
const approvedOutputDirectories = new Set<string>()
interface ActiveLibraryScan {
  worker: Worker | null
  cancelRequested: boolean
}

type LibraryScanWorkerMessage =
  | { type: 'progress'; progress: LibraryProgress }
  | { type: 'complete'; index: LibraryIndex }
  | { type: 'error'; error: string }

let activeLibraryScan: ActiveLibraryScan | null = null
let activeEpubGeneration: AbortController | null = null

function dataDirectory(): string {
  return app.getPath('userData')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runLibraryScanWorker(
  worker: Worker,
  onProgress: (progress: LibraryProgress) => void
): Promise<LibraryIndex> {
  return new Promise((resolveScan, rejectScan) => {
    let settled = false
    const resolveOnce = (index: LibraryIndex) => {
      if (settled) return
      settled = true
      resolveScan(index)
    }
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      rejectScan(error)
    }

    worker.on('message', (message: LibraryScanWorkerMessage) => {
      if (message.type === 'progress') {
        onProgress(message.progress)
      } else if (message.type === 'complete') {
        resolveOnce(message.index)
      } else {
        rejectOnce(new Error(message.error))
      }
    })
    worker.once('error', (error) => rejectOnce(error))
    worker.once('exit', (code) => {
      if (!settled) rejectOnce(new Error(`Library scan worker exited unexpectedly (code ${code}).`))
    })
  })
}

function parseGenerateInput(value: unknown): GenerateEpubInput {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid EPUB request.')
  const input = value as Record<string, unknown>
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const author = typeof input.author === 'string' ? input.author.trim() : ''
  const language = typeof input.language === 'string' ? input.language.trim() : ''
  if (input.filename !== undefined && typeof input.filename !== 'string') {
    throw new Error('The EPUB filename must be text.')
  }
  const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
  const sourceUrl = input.sourceUrl === undefined ? '' : validateHttpUrl(input.sourceUrl)
  const outputDirectory = typeof input.outputDirectory === 'string' ? input.outputDirectory : ''

  if (!title || title.length > 300) throw new Error('Enter a title of 1–300 characters.')
  if (author.length > 300) throw new Error('Author must be 300 characters or fewer.')
  if (filename.length > 255) throw new Error('The EPUB filename must be 255 characters or fewer.')
  if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language)) {
    throw new Error('Enter a valid language code, such as en or en-US.')
  }
  if (!approvedOutputDirectories.has(resolve(outputDirectory))) {
    throw new Error('Choose an output folder using the folder picker before creating the EPUB.')
  }
  if (!Array.isArray(input.chapters) || input.chapters.length === 0 || input.chapters.length > 10_000) {
    throw new Error('Select between 1 and 10,000 chapters.')
  }
  let trackerRow: GenerateEpubInput['trackerRow']
  if (input.trackerRow !== undefined) {
    if (typeof input.trackerRow !== 'object' || input.trackerRow === null) {
      throw new Error('The selected tracker row is invalid.')
    }
    const row = input.trackerRow as Record<string, unknown>
    if (
      typeof row.stableId !== 'string' || !row.stableId.trim() || row.stableId.length > 200 ||
      typeof row.rowNumber !== 'number' || !Number.isSafeInteger(row.rowNumber) || row.rowNumber < 2 ||
      typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300 ||
      typeof row.csvPath !== 'string' || !row.csvPath.trim() || row.csvPath.length > 2048
    ) {
      throw new Error('The selected tracker row is invalid.')
    }
    trackerRow = {
      stableId: row.stableId.trim(),
      rowNumber: row.rowNumber,
      title: row.title.trim(),
      csvPath: row.csvPath
    }
  }

  const chapters: ChapterLink[] = input.chapters.map((chapter, index) => {
    if (typeof chapter !== 'object' || chapter === null) throw new Error(`Chapter ${index + 1} is invalid.`)
    const item = chapter as Record<string, unknown>
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 500) {
      throw new Error(`Chapter ${index + 1} needs a title of 1–500 characters.`)
    }
    return {
      id: `chapter-${index + 1}`,
      title: item.title.trim(),
      url: validateHttpUrl(item.url)
    }
  })

  return {
    title,
    author,
    language,
    filename: filename || undefined,
    sourceUrl: sourceUrl || undefined,
    outputDirectory: resolve(outputDirectory),
    chapters,
    trackerRow
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, target) => {
    try {
      const current = new URL(mainWindow!.webContents.getURL())
      const next = new URL(target)
      if (next.origin !== current.origin || next.protocol !== current.protocol) event.preventDefault()
    } catch {
      event.preventDefault()
    }
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('chapter:discover', async (event, value: unknown): Promise<Result<Awaited<ReturnType<typeof discoverChapters>>>> => {
    try {
      return {
        ok: true,
        value: await discoverChapters(value, (progress) => event.sender.send('job:progress', progress))
      }
    } catch (error) {
      console.error('Chapter discovery failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('dialog:choose-output-directory', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose EPUB output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await stat(directory)
    if (!details.isDirectory()) throw new Error('The selected output path is not a folder.')
    approvedOutputDirectories.add(directory)
    const settings = await readSettings(dataDirectory())
    settings.outputDirectory = directory
    await writeSettings(dataDirectory(), settings)
    return directory
  })

  ipcMain.handle('settings:get', async (): Promise<AppSettings> => readSettings(dataDirectory()))

  ipcMain.handle('dialog:choose-library-root', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose historical library root',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('The selected library root is not a folder.')

    const settings = await readSettings(dataDirectory())
    settings.libraryRoot = directory
    const downloaded = resolve(directory, 'Downloaded')
    try {
      const downloadedDetails = await lstat(downloaded)
      if (downloadedDetails.isDirectory() && !downloadedDetails.isSymbolicLink() && !settings.outputDirectory) {
        settings.outputDirectory = await realpath(downloaded)
        approvedOutputDirectories.add(settings.outputDirectory)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await writeSettings(dataDirectory(), settings)
    return directory
  })

  ipcMain.handle('dialog:choose-tracker-csv', async () => {
    if (!mainWindow) throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Novel Tracker CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = await realpath(result.filePaths[0])
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('The selected CSV path is not a file.')
    const settings = await readSettings(dataDirectory())
    settings.trackerCsvPath = path
    await writeSettings(dataDirectory(), settings)
    return path
  })

  ipcMain.handle('tracker:list', async (): Promise<Result<Awaited<ReturnType<typeof readTrackerCsv>>>> => {
    try {
      const settings = await readSettings(dataDirectory())
      if (!settings.trackerCsvPath) throw new Error('Choose a tracker CSV file in Library settings first.')
      return { ok: true, value: await readTrackerCsv(settings.trackerCsvPath) }
    } catch (error) {
      console.error('Tracker CSV load failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('download-history:list', async () => readDownloadHistory(dataDirectory()))

  ipcMain.handle('library:index', async () => readLibraryIndex(dataDirectory()))

  ipcMain.handle('library:scan', async (event): Promise<Result<LibraryIndex>> => {
    if (activeLibraryScan) return { ok: false, error: 'A library scan is already running.' }
    const scan: ActiveLibraryScan = { worker: null, cancelRequested: false }
    activeLibraryScan = scan
    try {
      const settings = await readSettings(dataDirectory())
      if (!settings.libraryRoot) throw new Error('Choose a historical library root first.')
      if (scan.cancelRequested) throw new Error('Library scan cancelled.')
      const worker = new Worker(join(__dirname, 'libraryScanWorker.js'), {
        workerData: { libraryRoot: settings.libraryRoot, dataDirectory: dataDirectory() }
      })
      scan.worker = worker
      if (scan.cancelRequested) worker.postMessage({ type: 'cancel' })
      const index = await runLibraryScanWorker(worker, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('library:progress', progress)
      })
      return { ok: true, value: index }
    } catch (error) {
      if (!scan.cancelRequested) console.error('Library scan failed:', error)
      return { ok: false, error: errorMessage(error) }
    } finally {
      if (activeLibraryScan === scan) activeLibraryScan = null
    }
  })

  ipcMain.handle('library:cancel-scan', () => {
    if (!activeLibraryScan) return
    activeLibraryScan.cancelRequested = true
    activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  })

  ipcMain.handle('epub:cancel-generation', () => {
    activeEpubGeneration?.abort()
  })

  ipcMain.handle('library:correct-file', async (_event, rawFileId: unknown, rawCorrection: unknown) => {
    try {
      if (typeof rawFileId !== 'string' || typeof rawCorrection !== 'object' || rawCorrection === null) {
        throw new Error('Invalid library correction.')
      }
      const correction = rawCorrection as Record<string, unknown>
      const novelTitle = correction.novelTitle
      const chapterNumbers = correction.chapterNumbers
      if (novelTitle !== undefined && (typeof novelTitle !== 'string' || novelTitle.length > 300)) {
        throw new Error('Novel title must be 300 characters or fewer.')
      }
      if (
        chapterNumbers !== undefined &&
        (!Array.isArray(chapterNumbers) ||
          chapterNumbers.length > 10_000 ||
          chapterNumbers.some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0))
      ) {
        throw new Error('Chapter corrections must be a list of non-negative numbers.')
      }
      return {
        ok: true,
        value: await writeLibraryCorrection(dataDirectory(), rawFileId, {
          novelTitle: novelTitle as string | undefined,
          chapterNumbers: chapterNumbers as number[] | undefined
        } satisfies LibraryFileCorrection)
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('library:open-path', async (_event, rawPath: unknown, reveal: unknown): Promise<Result<void>> => {
    try {
      if (typeof rawPath !== 'string' || typeof reveal !== 'boolean') throw new Error('Invalid library path request.')
      const settings = await readSettings(dataDirectory())
      if (!settings.libraryRoot) throw new Error('Choose a historical library root first.')
      const root = await realpath(settings.libraryRoot)
      const target = await realpath(rawPath)
      const relativePath = relative(root, target)
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('The requested path is outside the configured library.')
      }
      if (reveal) shell.showItemInFolder(target)
      else {
        const error = await shell.openPath(target)
        if (error) throw new Error(error)
      }
      return { ok: true, value: undefined }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })

  ipcMain.handle('epub:generate', async (event, rawInput: unknown): Promise<Result<GenerateEpubResult>> => {
    if (activeEpubGeneration) return { ok: false, error: 'EPUB creation is already running.' }
    try {
      const input = parseGenerateInput(rawInput)
      const controller = new AbortController()
      activeEpubGeneration = controller
      const now = new Date().toISOString()
      const historyEntry: DownloadHistoryEntry = {
        id: randomUUID(),
        title: input.title,
        author: input.author,
        sourceUrl: input.sourceUrl || input.chapters[0].url,
        trackerRow: input.trackerRow ?? null,
        selectedChapterCount: input.chapters.length,
        status: 'running',
        completedChapters: 0,
        outputPath: '',
        error: '',
        startedAt: now,
        updatedAt: now
      }
      try {
        await saveDownloadHistoryEntry(dataDirectory(), historyEntry)
      } catch (error) {
        activeEpubGeneration = null
        throw error
      }
      const chapters = []

      try {
        for (let index = 0; index < input.chapters.length; index += 1) {
          if (controller.signal.aborted) throw new Error('EPUB creation was cancelled.')
          if (!event.sender.isDestroyed()) {
            event.sender.send('job:progress', {
              current: index,
              total: input.chapters.length,
              message: `Fetching chapter ${index + 1} of ${input.chapters.length}: ${input.chapters[index].title}`
            })
          }
          const chapterContent = await fetchChapterContent(input.chapters[index], controller.signal)
          chapters.push(chapterContent)
          historyEntry.completedChapters = index + 1
          historyEntry.updatedAt = new Date().toISOString()
          await saveDownloadHistoryEntry(dataDirectory(), historyEntry)
          if (!event.sender.isDestroyed()) {
            event.sender.send('job:progress', {
              current: index + 1,
              total: input.chapters.length,
              message: `Fetched chapter ${index + 1} of ${input.chapters.length}: ${input.chapters[index].title}`
            })
          }
          if (index + 1 < input.chapters.length) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
          }
        }

        if (!event.sender.isDestroyed()) {
          event.sender.send('job:progress', {
            current: input.chapters.length,
            total: input.chapters.length,
            message: 'Validating and packaging EPUB…'
          })
        }
        const result = await writeEpub(
          input.outputDirectory,
          input.title,
          input.author,
          input.language,
          chapters,
          input.filename,
          controller.signal
        )
        historyEntry.status = 'completed'
        historyEntry.outputPath = result.outputPath
        historyEntry.updatedAt = new Date().toISOString()
        await saveDownloadHistoryEntry(dataDirectory(), historyEntry)
        return { ok: true, value: result }
      } catch (error) {
        historyEntry.status = controller.signal.aborted ? 'cancelled' : 'failed'
        historyEntry.error = errorMessage(error)
        historyEntry.updatedAt = new Date().toISOString()
        await saveDownloadHistoryEntry(dataDirectory(), historyEntry)
        if (!controller.signal.aborted) console.error('EPUB creation failed:', error)
        return { ok: false, error: historyEntry.error }
      } finally {
        if (activeEpubGeneration === controller) activeEpubGeneration = null
      }
    } catch (error) {
      console.error('EPUB job setup failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })
}

app.whenReady().then(async () => {
  registerIpcHandlers()
  await markInterruptedDownloadJobs(dataDirectory())
  const settings = await readSettings(dataDirectory())
  if (settings.outputDirectory) {
    try {
      const directory = await realpath(settings.outputDirectory)
      if ((await stat(directory)).isDirectory()) approvedOutputDirectories.add(directory)
    } catch (error) {
      console.warn('Saved EPUB output folder is unavailable:', errorMessage(error))
    }
  }
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
}).catch((error: unknown) => {
  console.error('Application startup failed:', error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
