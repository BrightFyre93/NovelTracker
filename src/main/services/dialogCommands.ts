import { dialog } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AppSettings } from '../../shared/contracts'
import type { IpcContext } from '../ipc/context'

type DialogCommandContext = Pick<
  IpcContext,
  'approvedOutputDirectories' | 'isNodeError' | 'mainWindow' | 'settingsService'
>

export async function chooseLibraryRoot(
  context: DialogCommandContext
): Promise<string | null> {
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

  const settings = await context.settingsService.updateWith(async (current) => {
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
      if (!(context.isNodeError(error) && error.code === 'ENOENT')) throw error
    }
    return patch
  })
  if (settings.outputDirectory)
    context.approvedOutputDirectories.add(settings.outputDirectory)
  return directory
}
