import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

function isTransientRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))
  )
}

export async function renameWithRetry(source: string, destination: string): Promise<void> {
  const delays = [75, 150, 300, 600, 1200, 2000]
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      const delay = delays[attempt]
      if (!isTransientRenameError(error)) throw error
      if (delay === undefined) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'filesystem error'
        throw new Error(
          `Windows could not replace "${destination}" after several attempts (${code}). Close any application locking the file, then retry.`
        )
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delay))
    }
  }
}

export async function atomicWriteFile(
  path: string,
  contents: string | Uint8Array,
  beforeRename?: () => void
): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.novel-tracker-${randomUUID()}.tmp`)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporaryPath, contents, { flag: 'wx' })
    beforeRename?.()
    await renameWithRetry(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch((cleanupError: unknown) => {
      console.warn(`Temporary file ${temporaryPath} could not be removed:`, cleanupError)
    })
    throw error
  }
}
