import { createLibraryWorkflowCommands } from '../services/library/libraryWorkflowCommands'
import type { LibraryWorkflowContext } from '../services/library/libraryWorkflowCommands'
import { z } from 'zod'
import type { LibraryFileCorrection } from '../../shared/contracts'
import { inspectEpub } from '../services/epubInspector'

export function registerLibraryIpcHandlers(
  context: LibraryWorkflowContext
): void {
  const {
    copyLibraryOperations,
    getIndexedLibraryFile,
    handle,
    libraryIndexRepository
  } = context
  const workflows = createLibraryWorkflowCommands(context)

  handle(
    'validated-result',
    'library:search-novels',
    z.tuple([
      z.string(),
      z.boolean(),
      z.number().int().min(0),
      z.number().int().min(1).max(100),
      z.string().optional()
    ]),
    async (
      _event,
      query,
      multipleFilesOnly,
      offset,
      limit,
      selectedNovelKey
    ) => {
      const value = await libraryIndexRepository.searchNovels(
        query,
        multipleFilesOnly,
        offset,
        limit,
        selectedNovelKey
      )
      if (!value) throw new Error('Scan the library before searching novels.')
      return {
        ok: true,
        value
      }
    }
  )

  handle('typed', 'library:index-summary', z.tuple([]), async () => {
    return libraryIndexRepository.readOverview()
  })

  handle(
    'validated-result',
    'library:search-novel-files',
    z.tuple([
      z.string().max(300),
      z.string(),
      z.number().int().min(0),
      z.number().int().min(1).max(100)
    ]),
    async (_event, novelKey, query, offset, limit) => {
      const value = await libraryIndexRepository.searchNovelFiles(
        novelKey,
        query,
        offset,
        limit
      )
      if (!value) throw new Error('Scan the library before viewing its files.')
      return {
        ok: true,
        value
      }
    }
  )

  handle(
    'validated-result',
    'library:novel-files',
    z.tuple([
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 300,
        'Invalid library novel selection.'
      )
    ]),
    async (_event, rawNovelKey) => {
      const value = await libraryIndexRepository.readNovelFiles(rawNovelKey)
      if (!value) throw new Error('Scan the library before viewing its files.')
      return {
        ok: true,
        value
      }
    }
  )

  handle(
    'validated-result',
    'library:file-chapter-titles',
    z.tuple([z.string()]),
    async (_event, fileId) => {
      const files = await libraryIndexRepository.readFilesByIds([fileId])
      const file = files?.[0]
      if (!file)
        throw new Error('The selected library file is no longer indexed.')
      if (file.format !== 'EPUB') return { ok: true, value: [] }

      const path = await getIndexedLibraryFile(fileId)
      const details = await inspectEpub(
        path,
        file.relativePath,
        file.folderState,
        file.size,
        file.modifiedAt,
        file.id
      )
      return { ok: true, value: details.chapterTitles }
    }
  )

  handle('typed', 'library:operations', z.tuple([]), () =>
    copyLibraryOperations()
  )

  handle('typed', 'library:index-backup-date', z.tuple([]), async () =>
    libraryIndexRepository.readBackupDate()
  )

  handle(
    'validated-result',
    'library:restore-index-backup',
    z.tuple([]),
    workflows.runLibraryRestoreIndexBackup
  )

  handle(
    'validated-result',
    'library:scan',
    z.tuple([
      z
        .custom<boolean>(
          (value): value is boolean => typeof value === 'boolean',
          'Invalid library scan option.'
        )
        .optional()
    ]),
    workflows.runLibraryScan
  )

  handle('typed', 'library:cancel-scan', z.tuple([]), () => {
    if (!context.activeLibraryScan) return
    context.activeLibraryScan.cancelRequested = true
    context.activeLibraryScan.worker?.postMessage({ type: 'cancel' })
  })

  handle(
    'validated-result',
    'library:correct-file',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library correction.'
      ),
      z.custom<LibraryFileCorrection>(
        (value): value is LibraryFileCorrection =>
          typeof value === 'object' && value !== null,
        'Invalid library correction.'
      )
    ]),
    workflows.runLibraryCorrectFile
  )

  handle(
    'validated-result',
    'library:merge-epubs',
    z.tuple([
      z.custom<string[]>(
        (value): value is string[] =>
          Array.isArray(value) &&
          value.length >= 2 &&
          value.length <= 20 &&
          value.every((id) => typeof id === 'string') &&
          new Set(value).size === value.length,
        'Select between 2 and 20 distinct EPUB files to combine.'
      ),
      z.custom<string>(
        (value): value is string =>
          typeof value === 'string' && value.length <= 200,
        'Enter an EPUB filename of 200 characters or fewer.'
      )
    ]),
    workflows.runLibraryMergeEpubs
  )

  handle(
    'validated-result',
    'library:repair-epub',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Select an indexed library file.'
      )
    ]),
    workflows.runLibraryRepairEpub
  )

  handle(
    'validated-result',
    'library:open-path',
    z.tuple([
      z.custom<string>(
        (value): value is string => typeof value === 'string',
        'Invalid library path request.'
      ),
      z.custom<boolean>(
        (value): value is boolean => typeof value === 'boolean',
        'Invalid library path request.'
      )
    ]),
    workflows.runLibraryOpenPath
  )
}
