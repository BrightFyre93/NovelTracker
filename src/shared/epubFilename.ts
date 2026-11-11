function cleanFilenamePart(value: string, maximumLength: number, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()

  if (!cleaned) return fallback
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned
  return safe.slice(0, maximumLength).replace(/[. ]+$/g, '') || fallback
}

export function sanitizeEpubFilename(value: string): string {
  const basename = value.trim().replace(/\.epub$/i, '')
  if (!basename) throw new Error('Enter a filename for the EPUB.')
  const safeBasename = cleanFilenamePart(basename, 175, '')
  if (!safeBasename) throw new Error('Enter a filename containing letters or numbers.')
  return `${safeBasename}.epub`
}

function chapterNumber(value: string): string | undefined {
  const labeled = value.match(/\b(?:chapter|episode|part|volume)\s*#?\s*(\d+(?:\.\d+)?)/i)
  const leading = value.match(/^\s*#?\s*(\d+(?:\.\d+)?)(?=\s|$|[:.-])/)
  const number = labeled?.[1] ?? leading?.[1]
  if (number) return number.replace(/^0+(?=\d)/, '')
  if (/\bprologue\b/i.test(value)) return '0'
  return undefined
}

export function suggestEpubFilename(title: string, firstChapter: string, lastChapter: string): string {
  const safeTitle = cleanFilenamePart(title, 130, 'Untitled')
  const safeFirst = chapterNumber(firstChapter) ?? cleanFilenamePart(firstChapter, 20, 'Chapter')
  const safeLast = chapterNumber(lastChapter) ?? cleanFilenamePart(lastChapter, 20, 'Chapter')
  return sanitizeEpubFilename(`${safeTitle} ${safeFirst}-${safeLast}`)
}
