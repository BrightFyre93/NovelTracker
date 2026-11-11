import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'csv-parse/sync'
import type { TrackerNovel, TrackerSource } from '../../shared/contracts'

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
  } catch {
    return false
  }
}

export async function readTrackerCsv(path: string): Promise<TrackerNovel[]> {
  const source = await readFile(path, 'utf8')
  const rows = parse(source, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true
  }) as Record<string, string>[]

  return rows.map((row, index) => {
    const title = row['Name of Series']?.trim() ?? ''
    const stableId = row['Stable ID']?.trim()
    if (!title) throw new Error(`CSV row ${index + 2} has no "Name of Series" value.`)

    const sources: TrackerSource[] = [
      ['URL (com)', row['URL (com)']],
      ['URL (net)', row['URL (net)']]
    ]
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
      .map(([label, url]) => ({ label, url: url.trim(), valid: isHttpUrl(url.trim()) }))

    const identity = stableId || createHash('sha256')
      .update(`${title}\n${row.Slug ?? ''}\n${row['Author'] ?? ''}`)
      .digest('hex')

    return {
      stableId: identity,
      rowNumber: index + 2,
      title,
      siteTitle: row['Site Title']?.trim() ?? '',
      author: row.Author?.trim() ?? '',
      alternativeNames: row['Alternative Names']?.trim() ?? '',
      sources
    }
  })
}
