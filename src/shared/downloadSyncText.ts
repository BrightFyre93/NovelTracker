import type { LibraryFileRecord } from './contracts'
import { normalizeNovelTitleForGrouping } from './novelTitle'

export interface DownloadSyncRow {
  name: string
  downloaded: number
  slug: string
}

export interface DownloadSyncText {
  text: string
  rows: DownloadSyncRow[]
  /** Novels left out because no downloaded chapter number could be determined. */
  skippedNovelCount: number
}

export const DOWNLOAD_SYNC_HEADER = 'Name,Downloaded,Slug,Stable ID'

/**
 * Highest chapter number that one indexed file proves is downloaded.
 * Chapter evidence from the table of contents counts only inside the range the
 * filename claims (the same rule the coverage analysis uses); files known only
 * by their filename count by the end of that range. 101.1 counts as 101.
 */
function fileDownloadedThrough(file: LibraryFileRecord): number {
  if (file.coverageConfidence === 'extracted-toc' || file.coverageConfidence === 'user-corrected') {
    let chapters = file.chapterNumbers.filter((chapter) => Number.isFinite(chapter) && chapter >= 0)
    const range = file.filenameRange
    if (file.coverageConfidence === 'extracted-toc' && range) {
      chapters = chapters.filter((chapter) => chapter >= range.start && chapter <= range.end)
    }
    return chapters.reduce((highest, chapter) => Math.max(highest, Math.floor(chapter)), 0)
  }
  if (file.coverageConfidence === 'filename' && file.filenameRange) {
    return Math.max(0, Math.floor(file.filenameRange.end))
  }
  return 0
}

/** The site page name of a novel URL, such as "gamer-reborn" for ".../gamer-reborn.html". */
export function slugFromSourceUrl(sourceUrl: string | undefined): string {
  if (!sourceUrl) return ''
  try {
    const segments = new URL(sourceUrl).pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]
    if (!last) return ''
    return decodeURIComponent(last).replace(/\.html?$/i, '').toLowerCase()
  } catch {
    return ''
  }
}

function csvCell(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ').trim()
  // Quote cells that hold a separator or quote, or that would be read as a comment.
  if (/[",;:\t]/.test(text) || text.startsWith('#')) return `"${text.replace(/"/g, '""')}"`
  return text
}

// Ignores case and punctuation but, unlike the Latin-only matcher, keeps letters of every script.
function mergeKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  )[0]?.[0] ?? ''
}

/**
 * Builds the text the Android app reads under "Update downloads from text":
 * a header and one `Name,Downloaded,Slug,Stable ID` line per novel. The Stable
 * ID is left empty because the library does not know it.
 */
export function buildDownloadSyncText(files: LibraryFileRecord[]): DownloadSyncText {
  const novels = new Map<string, LibraryFileRecord[]>()
  for (const file of files) {
    const key = normalizeNovelTitleForGrouping(file.novelTitle)
    if (!key) continue
    const group = novels.get(key) ?? []
    group.push(file)
    novels.set(key, group)
  }

  const rows: DownloadSyncRow[] = []
  let skippedNovelCount = 0
  for (const group of novels.values()) {
    const downloaded = group.reduce(
      (highest, file) => Math.max(highest, fileDownloadedThrough(file)),
      0
    )
    if (downloaded <= 0) {
      skippedNovelCount += 1
      continue
    }
    // The slug comes from the file that reaches the highest chapter.
    const bySlugPriority = [...group].sort(
      (left, right) => fileDownloadedThrough(right) - fileDownloadedThrough(left)
    )
    const slug = bySlugPriority.map((file) => slugFromSourceUrl(file.sourceUrl)).find(Boolean) ?? ''
    rows.push({
      name: mostCommon(group.map((file) => file.novelTitle.trim()).filter(Boolean)),
      downloaded,
      slug
    })
  }
  return formatDownloadSyncText(rows, skippedNovelCount)
}

/**
 * Turns novel rows into the sync text. Rows for the same novel (same name
 * ignoring case and punctuation) are merged: the highest count wins and the
 * first slug that is known is kept.
 */
export function formatDownloadSyncText(
  rows: DownloadSyncRow[],
  skippedNovelCount = 0
): DownloadSyncText {
  const merged = new Map<string, DownloadSyncRow>()
  for (const row of rows) {
    const key = mergeKey(row.name)
    if (!key || row.downloaded <= 0) continue
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...row })
      continue
    }
    existing.downloaded = Math.max(existing.downloaded, row.downloaded)
    if (!existing.slug) existing.slug = row.slug
  }
  const sorted = [...merged.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
  const lines = [
    DOWNLOAD_SYNC_HEADER,
    ...sorted.map((row) => `${csvCell(row.name)},${row.downloaded},${csvCell(row.slug)},`)
  ]
  return { text: lines.join('\n'), rows: sorted, skippedNovelCount }
}
