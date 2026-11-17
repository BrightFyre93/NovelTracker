import { parseChapterNumber } from './chapterNumber'

export const MAX_EPUB_FILENAME_BASENAME_LENGTH = 175

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
  const safeBasename = cleanFilenamePart(basename, MAX_EPUB_FILENAME_BASENAME_LENGTH, '')
  if (!safeBasename) throw new Error('Enter a filename containing letters or numbers.')
  return `${safeBasename}.epub`
}

export function suggestEpubFilename(title: string, firstChapter: string, lastChapter: string): string {
  const safeTitle = cleanFilenamePart(title, 130, 'Untitled')
  const firstNumber = parseChapterNumber(firstChapter)
  const lastNumber = parseChapterNumber(lastChapter)
  const safeFirst = firstNumber === null ? cleanFilenamePart(firstChapter, 20, 'Chapter') : String(firstNumber)
  const safeLast = lastNumber === null ? cleanFilenamePart(lastChapter, 20, 'Chapter') : String(lastNumber)
  return sanitizeEpubFilename(`${safeTitle} ${safeFirst}-${safeLast}`)
}

export interface EpubFilenameTemplateValues {
  title: string
  author: string
  firstChapterTitle: string
  lastChapterTitle: string
  filename?: string
}

export function resolveEpubFilename(
  template: string,
  values: EpubFilenameTemplateValues,
  requestedFilename = ''
): string {
  if (requestedFilename.trim()) return sanitizeEpubFilename(requestedFilename)
  if (!template.trim()) {
    return suggestEpubFilename(
      values.title,
      values.firstChapterTitle,
      values.lastChapterTitle
    )
  }
  const firstNumber = parseChapterNumber(values.firstChapterTitle)
  const lastNumber = parseChapterNumber(values.lastChapterTitle)
  const tokens: Record<string, string> = {
    filename: (values.filename || values.title).replace(/\.epub$/i, ''),
    title: values.title,
    author: values.author,
    firstchapter:
      firstNumber === null ? values.firstChapterTitle : String(firstNumber),
    lastchapter:
      lastNumber === null ? values.lastChapterTitle : String(lastNumber)
  }
  const expanded = template.replace(
    /%(Filename|Title|Author|FirstChapter|LastChapter)%/gi,
    (_token, name: string) => tokens[name.toLowerCase()] ?? ''
  )
  return sanitizeEpubFilename(expanded)
}
