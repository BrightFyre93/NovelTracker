import { dialog, type BrowserWindow } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { AppSettings } from '../../../shared/contracts'
import { isNodeError } from '../../../shared/errors'
import type { LibraryIndexRepository } from './libraryIndexRepository'

interface LibraryFileAccessDependencies {
  libraryIndexRepository: Pick<
    LibraryIndexRepository,
    'readFilesByIds' | 'readOverview'
  >
  getSettings: () => Promise<AppSettings>
  getMainWindow: () => BrowserWindow | null
  samePath: (left: string, right: string) => boolean
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

export function createLibraryFileAccess({
  libraryIndexRepository,
  getSettings,
  getMainWindow,
  samePath
}: LibraryFileAccessDependencies) {
  async function getIndexedLibraryFile(fileId: string): Promise<string> {
    if (!fileId) throw new Error('Select an indexed library file.')
    const [files, overview, settings] = await Promise.all([
      libraryIndexRepository.readFilesByIds([fileId]),
      libraryIndexRepository.readOverview(),
      getSettings()
    ])
    if (!files || !overview)
      throw new Error('Scan the library before working with indexed files.')
    if (!settings.libraryRoot)
      throw new Error(
        'Go to Configuration and choose a historical library root first.'
      )
    const file = files[0]
    if (!file || file.format !== 'EPUB') {
      throw new Error(
        'The selected EPUB is no longer indexed. Rescan and try again.'
      )
    }
    const [libraryRoot, indexRoot] = await Promise.all([
      realpath(settings.libraryRoot),
      realpath(overview.libraryRoot)
    ])
    if (!samePath(libraryRoot, indexRoot)) {
      throw new Error(
        'The saved library index belongs to a different root. Scan the configured library first.'
      )
    }
    const inputDetails = await lstat(file.path)
    const inputPath = await realpath(file.path)
    if (
      inputDetails.isSymbolicLink() ||
      !inputDetails.isFile() ||
      !isWithinDirectory(libraryRoot, inputPath) ||
      extname(inputPath).toLowerCase() !== '.epub'
    ) {
      throw new Error(
        'The selected EPUB is not a regular file inside the configured library.'
      )
    }
    if (
      inputDetails.size !== file.size ||
      inputDetails.mtime.toISOString() !== file.modifiedAt
    ) {
      throw new Error(
        `The source file changed since the last scan: ${file.filename}. Rescan and try again.`
      )
    }
    return inputPath
  }

  async function getSiblingOutputPath(
    inputPath: string,
    suffix: string
  ): Promise<string | null> {
    const sourceName = basename(inputPath, extname(inputPath))
    const outputPath = join(dirname(inputPath), `${sourceName}${suffix}.epub`)
    if (samePath(outputPath, inputPath)) {
      throw new Error('The output cannot replace the source file.')
    }
    try {
      const existing = await lstat(outputPath)
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(
          `The output path is already used by a folder or symbolic link: ${basename(outputPath)}`
        )
      }
      const mainWindow = getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error(
          'The app window is not available to confirm replacing the existing EPUB.'
        )
      }
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Replace existing EPUB?',
        message: `Replace "${basename(outputPath)}"?`
      })
      if (confirmation.response !== 0) return null
    } catch (error) {
      if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
    }
    return outputPath
  }

  return { getIndexedLibraryFile, getSiblingOutputPath }
}
