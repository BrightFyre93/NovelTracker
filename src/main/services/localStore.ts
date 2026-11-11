import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppSettings,
  DiscoveryQueueItem,
  DownloadHistoryEntry,
  LibraryFileCorrection,
  LibraryIndex
} from '../../shared/contracts'

const EMPTY_SETTINGS: AppSettings = {
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: ''
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { flag: 'wx' })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export function readSettings(dataDirectory: string): Promise<AppSettings> {
  return readJson(join(dataDirectory, 'settings.json'), { ...EMPTY_SETTINGS })
}

export function writeSettings(dataDirectory: string, settings: AppSettings): Promise<void> {
  return writeJson(join(dataDirectory, 'settings.json'), settings)
}

export function readLibraryIndex(dataDirectory: string): Promise<LibraryIndex | null> {
  return readJson<LibraryIndex | null>(join(dataDirectory, 'library-index.json'), null)
}

export function writeLibraryIndex(dataDirectory: string, index: LibraryIndex): Promise<void> {
  return writeJson(join(dataDirectory, 'library-index.json'), index)
}

export function readDownloadHistory(dataDirectory: string): Promise<DownloadHistoryEntry[]> {
  return readJson(join(dataDirectory, 'download-history.json'), [])
}

export function readDiscoveryQueue(dataDirectory: string): Promise<DiscoveryQueueItem[]> {
  return readJson(join(dataDirectory, 'discovery-queue.json'), [])
}

export function writeDiscoveryQueue(dataDirectory: string, items: DiscoveryQueueItem[]): Promise<void> {
  return writeJson(join(dataDirectory, 'discovery-queue.json'), items)
}

export async function saveDownloadHistoryEntry(
  dataDirectory: string,
  entry: DownloadHistoryEntry
): Promise<DownloadHistoryEntry[]> {
  const history = await readDownloadHistory(dataDirectory)
  const existingIndex = history.findIndex((item) => item.id === entry.id)
  if (existingIndex >= 0) history[existingIndex] = entry
  else history.push(entry)
  history.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const latest = history.slice(0, 50)
  await writeJson(join(dataDirectory, 'download-history.json'), latest)
  return latest
}

export async function markInterruptedDownloadJobs(dataDirectory: string): Promise<void> {
  const history = await readDownloadHistory(dataDirectory)
  let changed = false
  for (const entry of history) {
    if (entry.status === 'running') {
      entry.status = 'interrupted'
      entry.error = 'The app closed before this job finished.'
      entry.updatedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) await writeJson(join(dataDirectory, 'download-history.json'), history)
}

export async function writeLibraryCorrection(
  dataDirectory: string,
  fileId: string,
  correction: LibraryFileCorrection
): Promise<LibraryIndex> {
  const index = await readLibraryIndex(dataDirectory)
  if (!index) throw new Error('Scan the library before correcting a file.')

  const file = index.files.find((candidate) => candidate.id === fileId)
  if (!file) throw new Error('The selected library file is no longer indexed. Rescan the library.')

  const corrections = index.corrections ?? {}
  const saved = corrections[fileId] ?? {}
  if (correction.novelTitle !== undefined) saved.novelTitle = correction.novelTitle.trim()
  if (correction.chapterNumbers !== undefined) saved.chapterNumbers = [...new Set(correction.chapterNumbers)]
  corrections[fileId] = saved
  index.corrections = corrections
  if (saved.novelTitle) file.novelTitle = saved.novelTitle
  if (saved.chapterNumbers) {
    file.chapterNumbers = [...saved.chapterNumbers].sort((left, right) => left - right)
    file.coverageConfidence = 'user-corrected'
  }
  await writeLibraryIndex(dataDirectory, index)
  return index
}
