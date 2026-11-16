const filenameRangePattern = /(\d+)\s*[-–]\s*(\d+)/g

interface FilenameRangeMatch {
  start: number
  end: number
  matchStart: number
  matchEnd: number
  startDigits: string
  endDigits: string
}

function findFilenameRange(value: string): FilenameRangeMatch | null {
  for (const match of value.matchAll(filenameRangePattern)) {
    const [rangeText, startDigits, endDigits] = match
    const matchStart = match.index
    const matchEnd = matchStart + rangeText.length
    if (
      (matchStart > 0 && !/[\s_-]/.test(value[matchStart - 1] ?? '')) ||
      (matchEnd < value.length && /\d/.test(value[matchEnd] ?? ''))
    ) {
      continue
    }

    return {
      start: Number(startDigits),
      end: Number(endDigits),
      matchStart,
      matchEnd,
      startDigits,
      endDigits
    }
  }
  return null
}

export function parseFilenameRange(
  value: string
): { start: number; end: number } | null {
  const range = findFilenameRange(value)
  if (!range || range.startDigits.length > 7 || range.endDigits.length > 7) {
    return null
  }
  return { start: range.start, end: range.end }
}

export function stripTrailingFilenameRange(value: string): string {
  const range = findFilenameRange(value)
  if (
    !range ||
    range.matchEnd !== value.length ||
    range.matchStart === 0 ||
    !/\s/.test(value[range.matchStart - 1] ?? '')
  ) {
    return value
  }
  return value.slice(0, range.matchStart).trimEnd()
}
