import type {
  ChapterLink,
  DiscoveryQueueInput,
  GenerateEpubInput
} from '../../../shared/contracts'
import {
  discoveryQueueInputsSchema,
  generateEpubInputSchema
} from '../../../shared/queueInputSchemas'
import { resolve } from 'node:path'
import { validateHttpUrl } from '../net/requestLimiter'
import type { ZodError } from 'zod'

export function createQueueInputParser(approvedOutputDirectories: Set<string>) {
  function parseDiscoveryQueueInputs(value: unknown): DiscoveryQueueInput[] {
    const parsed = discoveryQueueInputsSchema.safeParse(value)
    if (!parsed.success) throw new Error(discoveryQueueInputError(parsed.error))
    return parsed.data.map((input) => ({
      ...input,
      sourceUrl: validateHttpUrl(input.sourceUrl)
    }))
  }

  function parseGenerateInput(value: unknown): GenerateEpubInput {
    const parsed = generateEpubInputSchema.safeParse(value)
    if (!parsed.success) throw new Error(generateInputError(parsed.error))
    const input = parsed.data
    const outputDirectory = resolve(input.outputDirectory)
    if (!approvedOutputDirectories.has(outputDirectory)) {
      throw new Error(
        'Choose an output folder using the folder picker before creating the EPUB.'
      )
    }
    const sourceUrl = input.sourceUrl
      ? validateHttpUrl(input.sourceUrl)
      : undefined
    const coverUrl = input.coverUrl ? validateHttpUrl(input.coverUrl) : ''
    const chapters: ChapterLink[] = input.chapters.map(
      ({ title, url }, index) => ({
        id: `chapter-${index + 1}`,
        title,
        url: validateHttpUrl(url)
      })
    )

    return {
      ...input,
      coverUrl,
      filename: input.filename || undefined,
      sourceUrl,
      outputDirectory,
      chapters
    }
  }

  return { parseDiscoveryQueueInputs, parseGenerateInput }
}

function discoveryQueueInputError(error: ZodError): string {
  const issue = error.issues[0]
  const itemIndex = typeof issue?.path[0] === 'number' ? issue.path[0] + 1 : 0
  if (itemIndex === 0)
    return 'Add between 1 and 100 tracker novels or URLs at a time.'
  const field = issue?.path[1]
  if (field === 'title')
    return `Queue item ${itemIndex} needs a title of 1–300 characters.`
  if (field === 'author')
    return `Queue item ${itemIndex} has an author longer than 300 characters.`
  if (field === 'origin')
    return `Queue item ${itemIndex} has an invalid origin.`
  if (field === 'separateJob')
    return `Queue item ${itemIndex} has an invalid separate-job setting.`
  if (field === 'trackerRow') {
    return issue?.message === 'missing-tracker-row'
      ? `Queue item ${itemIndex} is missing its tracker association.`
      : `Queue item ${itemIndex} has an invalid tracker association.`
  }
  if (field === 'sourceUrl')
    return `Queue item ${itemIndex} has an invalid source URL.`
  return `Queue item ${itemIndex} is invalid.`
}

function generateInputError(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Invalid EPUB request.'
  const [field, index, nestedField] = issue.path
  if (field === 'trackerRow') return 'The selected tracker row is invalid.'
  if (field === 'chapters' && typeof index === 'number') {
    if (nestedField === 'title')
      return `Chapter ${index + 1} needs a title of 1–500 characters.`
    return `Chapter ${index + 1} is invalid.`
  }
  return issue.message || 'Invalid EPUB request.'
}
