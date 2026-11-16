import type { IpcContext } from './context'

type DialogsIpcContext = Pick<
  IpcContext,
  | 'approvedOutputDirectories'
  | 'dialog'
  | 'handleTypedIpc'
  | 'isNodeError'
  | 'lstat'
  | 'mainWindow'
  | 'realpath'
  | 'resolve'
  | 'settingsService'
  | 'stat'
  | 'z'
>
import type { AppSettings } from '../../shared/contracts'

export function registerDialogsIpcHandlers(context: DialogsIpcContext): void {
  const {
    approvedOutputDirectories,
    dialog,
    handleTypedIpc,
    isNodeError,
    lstat,
    realpath,
    resolve,
    settingsService,
    stat,
    z
  } = context

  handleTypedIpc('dialog:choose-output-directory', z.tuple([]), async () => {
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

  handleTypedIpc('dialog:choose-library-root', z.tuple([]), async () => {
    if (!context.mainWindow)
      throw new Error('The application window is not available.')
    const result = await dialog.showOpenDialog(context.mainWindow, {
      title: 'Choose historical library root',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const directory = await realpath(result.filePaths[0])
    const details = await lstat(directory)
    if (!details.isDirectory() || details.isSymbolicLink())
      throw new Error('The selected library root is not a folder.')

    const settings = await settingsService.updateWith(async (current) => {
      const patch: Partial<AppSettings> = { libraryRoot: directory }
      const downloaded = resolve(directory, 'Downloaded')
      try {
        const downloadedDetails = await lstat(downloaded)
        if (
          downloadedDetails.isDirectory() &&
          !downloadedDetails.isSymbolicLink() &&
          !current.outputDirectory
        ) {
          patch.outputDirectory = await realpath(downloaded)
        }
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
      }
      return patch
    })
    if (settings.outputDirectory)
      approvedOutputDirectories.add(settings.outputDirectory)
    return directory
  })

  handleTypedIpc('dialog:choose-tracker-csv', z.tuple([]), async () => {
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
