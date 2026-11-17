import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isNodeError } from '../../shared/errors'

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export async function backupLegacyJsonFile(
  path: string,
  backupPath: string
): Promise<void> {
  let sourceHash: string
  try {
    sourceHash = await hashFile(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }

  try {
    const backupHash = await hashFile(backupPath)
    if (backupHash !== sourceHash) {
      throw new Error(
        `The existing SQLite migration backup does not match ${path}; refusing to overwrite it.`
      )
    }
    return
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
  }

  await mkdir(dirname(backupPath), { recursive: true })
  const temporaryPath = `${backupPath}.${randomUUID()}.tmp`
  try {
    await copyFile(path, temporaryPath, constants.COPYFILE_EXCL)
    if ((await hashFile(temporaryPath)) !== sourceHash) {
      throw new Error(`The SQLite migration backup for ${path} failed verification.`)
    }
    await rename(temporaryPath, backupPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}
