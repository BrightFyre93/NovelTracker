import type { LibraryFileRecord } from './contracts'

export type LibraryCoverageWarning =
  | {
      kind: 'gap'
      key: string
      start: number
      end: number
      before: LibraryFileRecord[]
      after: LibraryFileRecord[]
    }
  | {
      kind: 'overlap'
      key: string
      start: number
      end: number
      files: LibraryFileRecord[]
    }
  | {
      kind: 'unverified'
      key: string
      file: LibraryFileRecord
      explanation: string
    }
  | {
      kind: 'range-mismatch'
      key: string
      file: LibraryFileRecord
      chapters: number[]
    }

export interface LibraryCoverageAnalysis {
  warnings: LibraryCoverageWarning[]
  gapCount: number
  overlapNumberCount: number
  unverifiedCount: number
  rangeMismatchCount: number
  filenameEvidenceCount: number
}

export function analyzeLibraryCoverage(
  files: LibraryFileRecord[],
  includeFilenamePdfEvidence: boolean
): LibraryCoverageAnalysis {
  const chapterSources = new Map<number, Map<string, LibraryFileRecord>>()
  const rangeMismatches: Array<{ file: LibraryFileRecord; chapters: number[] }> = []
  const coverageFiles = files.filter(
    (file) =>
      ['extracted-toc', 'extracted-text', 'user-corrected'].includes(file.coverageConfidence) ||
      (includeFilenamePdfEvidence &&
        file.format === 'PDF' &&
        file.coverageConfidence === 'filename' &&
        file.chapterNumbers.length > 0)
  )

  for (const file of coverageFiles) {
    let chapters = [...new Set(file.chapterNumbers)].filter((chapter) => Number.isFinite(chapter) && chapter >= 0)
    const filenameRange = file.filenameRange
    if (
      file.coverageConfidence !== 'user-corrected' &&
      ['extracted-toc', 'extracted-text'].includes(file.coverageConfidence) &&
      filenameRange
    ) {
      const outliers = chapters.filter(
        (chapter) => chapter < filenameRange.start || chapter > filenameRange.end
      )
      if (outliers.length > 0) {
        rangeMismatches.push({ file, chapters: outliers.sort((left, right) => left - right) })
        chapters = chapters.filter(
          (chapter) => chapter >= filenameRange.start && chapter <= filenameRange.end
        )
      }
    }
    for (const chapter of chapters) {
      const sources = chapterSources.get(chapter) ?? new Map<string, LibraryFileRecord>()
      sources.set(file.id, file)
      chapterSources.set(chapter, sources)
    }
  }

  const chapterNumbers = [...chapterSources.keys()].sort((left, right) => left - right)
  const integerChapters = chapterNumbers.filter(Number.isInteger)
  const warnings: LibraryCoverageWarning[] = []
  let gapCount = 0

  for (let index = 1; index < integerChapters.length; index += 1) {
    const previous = integerChapters[index - 1]
    const current = integerChapters[index]
    if (current - previous > 1) {
      warnings.push({
        kind: 'gap',
        key: `gap-${previous}-${current}`,
        start: previous + 1,
        end: current - 1,
        before: [...(chapterSources.get(previous)?.values() ?? [])],
        after: [...(chapterSources.get(current)?.values() ?? [])]
      })
      gapCount += 1
    }
  }

  const overlapNumbers = chapterNumbers.filter((chapter) => (chapterSources.get(chapter)?.size ?? 0) > 1)
  const overlapWarnings: Extract<LibraryCoverageWarning, { kind: 'overlap' }>[] = []
  for (const chapter of overlapNumbers) {
    const sources = [...(chapterSources.get(chapter)?.values() ?? [])].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
    const sourceIds = sources.map((file) => file.id).join('|')
    const previous = overlapWarnings[overlapWarnings.length - 1]
    if (
      previous &&
      previous.end + 1 === chapter &&
      previous.key.endsWith(sourceIds)
    ) {
      previous.end = chapter
    } else {
      overlapWarnings.push({
        kind: 'overlap',
        key: `overlap-${chapter}-${sourceIds}`,
        start: chapter,
        end: chapter,
        files: sources
      })
    }
  }
  warnings.push(...overlapWarnings)

  const unverifiedFiles = files.filter(
    (file) =>
      file.coverageConfidence === 'unknown' ||
      (file.coverageConfidence === 'filename' && file.chapterNumbers.length === 0)
  )
  for (const file of unverifiedFiles) {
    warnings.push({
      kind: 'unverified',
      key: `unverified-${file.id}`,
      file,
      explanation: file.filenameRange
        ? `The filename suggests chapters ${file.filenameRange.start}-${file.filenameRange.end}, but does not confirm chapter-by-chapter coverage.`
        : file.inspectionError || 'No chapter numbers could be extracted from this file.'
    })
  }
  for (const mismatch of rangeMismatches) {
    warnings.push({
      kind: 'range-mismatch',
      key: `range-mismatch-${mismatch.file.id}`,
      file: mismatch.file,
      chapters: mismatch.chapters
    })
  }

  return {
    warnings,
    gapCount,
    overlapNumberCount: overlapNumbers.length,
    unverifiedCount: unverifiedFiles.length,
    rangeMismatchCount: rangeMismatches.length,
    filenameEvidenceCount: includeFilenamePdfEvidence
      ? files.filter(
          (file) => file.format === 'PDF' && file.coverageConfidence === 'filename' && file.chapterNumbers.length > 0
        ).length
      : 0
  }
}
