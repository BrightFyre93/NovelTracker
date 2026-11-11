import { readFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import type { LibraryFileRecord } from '../../shared/contracts'

const MAX_COMPILED_PDF_BYTES = 100 * 1024 * 1024
const INDIVIDUAL_CHAPTER = /^chapter\s*[-_ ]*\s*(\d+(?:\.\d+)?)/i

interface PdfChapterHeading {
  chapter: number
  page: number
  title: string
}

function chapterHeadings(pages: Array<{ num: number; text: string }>): PdfChapterHeading[] {
  const byChapter = new Map<number, PdfChapterHeading>()
  for (const page of pages) {
    for (const line of page.text.split(/\r?\n/)) {
      const match = line.trim().match(/^(?:chapter|ch\.?)\s*[-:#]?\s*(\d+(?:\.\d+)?)(?:\s*[:.–—-]\s*(.*))?$/i)
      if (!match) continue
      const chapter = Number(match[1])
      if (!byChapter.has(chapter)) {
        byChapter.set(chapter, {
          chapter,
          page: page.num,
          title: `Chapter ${match[1]}${match[2] ? `: ${match[2].trim()}` : ''}`
        })
      }
    }
  }
  return [...byChapter.values()].sort((left, right) => left.chapter - right.chapter)
}

export async function inspectPdf(
  path: string,
  relativePath: string,
  folderState: LibraryFileRecord['folderState'],
  size: number,
  modifiedAt: string,
  id: string
): Promise<LibraryFileRecord> {
  const relativeParts = relativePath.split(/[\\/]/)
  const filename = relativeParts.pop()!
  const novelTitle = relativeParts.length > 1 ? relativeParts[1] : filename
  const chapterMatch = filename.replace(/\.pdf$/i, '').match(INDIVIDUAL_CHAPTER)
  if (chapterMatch) {
    const number = Number(chapterMatch[1])
    return {
      id,
      path,
      relativePath,
      filename,
      format: 'PDF',
      folderState,
      size,
      modifiedAt,
      novelTitle,
      author: '',
      language: '',
      pageCount: null,
      chapterTitles: [],
      chapterNumbers: [number],
      chapterLocations: [],
      filenameRange: null,
      coverageConfidence: 'filename',
      pdfClassification: 'individual-chapter',
      coverPath: null,
      inspectionError: ''
    }
  }

  if (size > MAX_COMPILED_PDF_BYTES) {
    throw new Error(`PDF exceeds the ${MAX_COMPILED_PDF_BYTES / (1024 * 1024)} MB inspection limit.`)
  }

  const parser = new PDFParse({ data: await readFile(path) })
  try {
    const info = await parser.getInfo()
    const textResult = await parser.getText()
    const locations = chapterHeadings(textResult.pages)
    const title = info.info?.Title?.trim() || novelTitle
    const author = info.info?.Author?.trim() || ''
    return {
      id,
      path,
      relativePath,
      filename,
      format: 'PDF',
      folderState,
      size,
      modifiedAt,
      novelTitle: title,
      author,
      language: '',
      pageCount: info.total,
      chapterTitles: locations.map(({ title: chapterTitle }) => chapterTitle),
      chapterNumbers: locations.map(({ chapter }) => chapter),
      chapterLocations: locations,
      filenameRange: null,
      coverageConfidence: locations.length > 0 ? 'extracted-text' : 'unknown',
      pdfClassification: locations.length > 1 ? 'compiled-candidate' : 'unknown',
      coverPath: null,
      inspectionError: ''
    }
  } finally {
    await parser.destroy()
  }
}
