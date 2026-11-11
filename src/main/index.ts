import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ChapterLink, GenerateEpubInput, Result } from '../shared/contracts'
import { fetchChapterContent, discoverChapters, validateHttpUrl } from './services/scraper'
import { writeEpub } from './services/epub'

let mainWindow: BrowserWindow | null = null
const approvedOutputDirectories = new Set<string>()

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    outputDirectory: resolve(outputDirectory),
    chapters
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

    const directory = resolve(result.filePaths[0])
    const details = await stat(directory)
    if (!details.isDirectory()) throw new Error('The selected output path is not a folder.')
    approvedOutputDirectories.add(directory)
    return directory
  })

  ipcMain.handle('epub:generate', async (event, rawInput: unknown): Promise<Result<{ outputPath: string; createdNumberedCopy: boolean }>> => {
    try {
      const input = parseGenerateInput(rawInput)
      const chapters = []

      for (let index = 0; index < input.chapters.length; index += 1) {
        event.sender.send('job:progress', {
          current: index + 1,
          total: input.chapters.length,
          message: `Fetching chapter ${index + 1} of ${input.chapters.length}: ${input.chapters[index].title}`
        })
        chapters.push(await fetchChapterContent(input.chapters[index]))
        if (index + 1 < input.chapters.length) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000))
        }
      }

      event.sender.send('job:progress', {
        current: input.chapters.length,
        total: input.chapters.length,
        message: 'Validating and packaging EPUB…'
      })
      const result = await writeEpub(
        input.outputDirectory,
        input.title,
        input.author,
        input.language,
        chapters,
        input.filename
      )
      return { ok: true, value: result }
    } catch (error) {
      console.error('EPUB creation failed:', error)
      return { ok: false, error: errorMessage(error) }
    }
  })
}

app.whenReady().then(async () => {
  registerIpcHandlers()
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
