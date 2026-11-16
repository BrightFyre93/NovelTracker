import type { ChapterSelectionUpdate } from './contracts'

export function encodeChapterSelection(
  chapters: readonly { id: string }[],
  selectedIds: ReadonlySet<string>
): ChapterSelectionUpdate {
  const ids = chapters
    .filter((chapter) => selectedIds.has(chapter.id))
    .map((chapter) => chapter.id)
  const ranges: Array<{ start: number; end: number }> = []
  for (const [index, chapter] of chapters.entries()) {
    if (!selectedIds.has(chapter.id)) continue
    const previous = ranges[ranges.length - 1]
    if (previous && previous.end === index - 1) previous.end = index
    else ranges.push({ start: index, end: index })
  }
  const idsUpdate: ChapterSelectionUpdate = { mode: 'ids', ids }
  const rangesUpdate: ChapterSelectionUpdate = { mode: 'ranges', ranges }
  return JSON.stringify(rangesUpdate).length < JSON.stringify(idsUpdate).length
    ? rangesUpdate
    : idsUpdate
}

export function resolveChapterSelection(
  chapters: readonly { id: string }[],
  update: ChapterSelectionUpdate,
  maxSelected: number
): Set<string> {
  if (update.mode === 'ids') {
    const selectedIds = new Set(update.ids)
    if (selectedIds.size > maxSelected)
      throw new Error(`Select no more than ${maxSelected.toLocaleString()} chapters.`)
    return selectedIds
  }

  const selectedIds = new Set<string>()
  let previousEnd = -1
  let selectedCount = 0
  for (const range of update.ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= chapters.length ||
      range.start <= previousEnd
    ) {
      throw new Error('The chapter selection ranges are invalid for this snapshot.')
    }
    selectedCount += range.end - range.start + 1
    if (selectedCount > maxSelected)
      throw new Error(`Select no more than ${maxSelected.toLocaleString()} chapters.`)
    for (let index = range.start; index <= range.end; index += 1) {
      const chapter = chapters[index]
      if (!chapter)
        throw new Error('The chapter selection no longer matches the saved discovery snapshot.')
      selectedIds.add(chapter.id)
    }
    previousEnd = range.end
  }
  return selectedIds
}
