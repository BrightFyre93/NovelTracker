import { appendFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { redactLogString } from './localLogger'
import { isNodeError } from '../../shared/errors'

const MAX_JOB_DIAGNOSTIC_BYTES = 512 * 1024

export async function appendJobDiagnostic(
  dataDirectory: string,
  jobId: string,
  entry: Record<string, unknown>
): Promise<void> {
  if (!/^[a-z0-9-]{1,100}$/i.test(jobId)) {
    throw new Error('The job diagnostic identifier is invalid.')
  }
  const directory = join(dataDirectory, 'logs', 'jobs')
  const path = join(directory, `${jobId}.log`)
  const line = `${redactLogString(JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  }))}\n`
  await mkdir(directory, { recursive: true })
  let size = 0
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (!(isNodeError(error) && error.code === 'ENOENT')) throw error
  }
  if (size + Buffer.byteLength(line, 'utf8') > MAX_JOB_DIAGNOSTIC_BYTES) return
  await appendFile(path, line, 'utf8')
}

export async function removeJobDiagnostic(
  dataDirectory: string,
  jobId: string
): Promise<void> {
  if (!/^[a-z0-9-]{1,100}$/i.test(jobId)) return
  await rm(join(dataDirectory, 'logs', 'jobs', `${jobId}.log`), { force: true })
}
