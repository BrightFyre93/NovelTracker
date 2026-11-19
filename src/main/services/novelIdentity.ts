import { createHash } from 'node:crypto'

/**
 * Normalizes a novel source URL so that the same novel always yields the same
 * identity: protocol, a leading "www.", the top-level domain (so .com/.net
 * mirrors of one site match), the query, the fragment, trailing slashes and
 * letter case are ignored. Text that is not a URL is only trimmed and
 * lower-cased.
 */
export function normalizeSourceUrlForIdentity(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const url = new URL(trimmed)
    const labels = url.hostname
      .toLowerCase()
      .split('.')
      .filter((label) => label.length > 0)
    if (labels[0] === 'www') labels.shift()
    if (labels.length >= 2) labels.pop()
    const path = decodeURIComponent(url.pathname)
      .replace(/\/+$/g, '')
      .toLowerCase()
    return `${labels.join('.')}${path}`
  } catch {
    return trimmed.toLowerCase()
  }
}

/** Novel-level id: identical for every file built from the same novel. */
export function novelIdFromSeed(seed: string): string {
  return createHash('sha256')
    .update(`noveltracker-novel-v1:${normalizeSourceUrlForIdentity(seed)}`)
    .digest('hex')
}

/**
 * File-level id. `key` identifies the file within its novel: the first chapter
 * number (stable when a file is rebuilt or extended), or another stable value
 * such as the merged file name.
 */
export function fileIdFromNovelId(novelId: string, key: string): string {
  return createHash('sha256')
    .update(`noveltracker-file-v1:${novelId}:${key}`)
    .digest('hex')
}
