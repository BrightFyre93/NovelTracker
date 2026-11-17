import type { IpcContext } from './context'
import { dialog } from 'electron'
import { lstat, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { chooseLibraryRoot } from '../services/dialogCommands'

type DialogsIpcContext = Pick<
  IpcContext,
  | 'approvedOutputDirectories'
  | 'handle'
  | 'isNodeError'
  | 'mainWindow'
  | 'settingsService'
>
export function registerDialogsIpcHandlers(context: DialogsIpcContext): void {
  const { approvedOutputDirectories, handle, settingsService } = context

  handle('typed', 'dialog:choose-output-directory', z.tuple([]), async () => {
    if (!context.mainWindow)
      throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(context.mainWindow, {
      title: 'Choose EPUB output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await stat(directory)
    if (!details.isDirectory())
      throw new Error('The selected output path is not a folder.')
    await settingsService.update({ outputDirectory: directory })
    approvedOutputDirectories.add(directory)
    return directory
  })

  handle('typed', 'dialog:choose-library-root', z.tuple([]), () =>
    chooseLibraryRoot(context)
  )

  handle('typed', 'dialog:choose-tracker-csv', z.tuple([]), async () => {
    if (!context.mainWindow)
      throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(context.mainWindow, {
      title: 'Choose Novel Tracker CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV files', extensions: ['csv'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const path = await realpath(result.filePaths[0])
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error('The selected CSV path is not a file.')
    await settingsService.update({ trackerCsvPath: path })
    return path
  })
}
