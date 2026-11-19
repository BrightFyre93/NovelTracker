import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNodeError } from '../../shared/errors'

export async function sweepNovelTrackerTemporaryFiles(
  directories: Iterable<string>
): Promise<void> {
  for (const directory of new Set(directories)) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^\.novel-tracker-[\da-f-]+\.tmp$/i.test(entry.name)
      )
        continue
      const path = join(directory, entry.name)
      try {
        await rm(path, { force: true })
      } catch (error) {
        console.warn(
          `Temporary file ${path} could not be removed during shutdown:`,
          error
        )
      }
    }
  }
}

export async function sweepStaleEpubTemporaryDirectories(): Promise<void> {
  const directory = tmpdir()
  const entries = await readdir(directory, { withFileTypes: true })
  const staleBefore = Date.now() - 6 * 60 * 60 * 1000
  const tempDirectoryPattern =
    /^novel-tracker-(?:epub-source|epub|repair|merge)-[\da-z-]+$/i

  for (const entry of entries) {
    if (!entry.isDirectory() || !tempDirectoryPattern.test(entry.name))
      continue
    const path = join(directory, entry.name)
    try {
      const details = await stat(path)
      if (details.mtimeMs >= staleBefore) continue
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      console.warn(
        `Stale temporary directory ${path} could not be removed during startup:`,
        error
      )
    }
  }
}
