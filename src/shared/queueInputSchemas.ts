import { z } from 'zod'
import {
  MAX_NOVEL_DESCRIPTION_LENGTH,
  MAX_SELECTED_CHAPTERS
} from './constants'

const trackerRowInputSchema = z.object({
  stableId: z.string().max(200).trim().min(1),
  rowNumber: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
  title: z.string().max(300).trim().min(1),
  alternativeNames: z.string().max(5000).optional(),
  csvPath: z.string().max(2048).trim().min(1)
})

const discoveryQueueItemInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.preprocess(
      (value) => (typeof value === 'string' ? value : ''),
      z.string().trim().max(300)
    ),
    sourceUrl: z.string(),
    origin: z.enum(['tracker', 'manual']),
    separateJob: z.boolean().optional().default(false),
    trackerRow: trackerRowInputSchema.optional()
  })
  .superRefine((item, context) => {
    if (item.origin === 'tracker' && !item.trackerRow) {
      context.addIssue({
        code: 'custom',
        path: ['trackerRow'],
        message: 'missing-tracker-row'
      })
    }
  })

export const discoveryQueueInputsSchema = z
  .array(discoveryQueueItemInputSchema)
  .min(1)
  .max(100)

function metadataLabelsSchema(label: string) {
  return z
    .array(
      z
        .string({
          error: `Each ${label.toLowerCase()} value must be text of 300 characters or fewer.`
        })
        .trim()
        .max(
          300,
          `Each ${label.toLowerCase()} value must be text of 300 characters or fewer.`
        )
    )
    .max(100, `${label} must contain no more than 100 values.`)
    .optional()
    .default([])
    .transform((values) => [...new Set(values.filter(Boolean))])
}

export const generateEpubInputSchema = z.object({
  title: z.preprocess(
    (value) => (typeof value === 'string' ? value : ''),
    z
      .string()
      .trim()
      .min(1, 'Enter a title of 1–300 characters.')
      .max(300, 'Enter a title of 1–300 characters.')
  ),
  author: z.preprocess(
    (value) => (typeof value === 'string' ? value : ''),
    z.string().trim().max(300, 'Author must be 300 characters or fewer.')
  ),
  description: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z
      .string({ error: 'The novel description must be text.' })
      .trim()
      .max(
        MAX_NOVEL_DESCRIPTION_LENGTH,
        `The novel description must be ${MAX_NOVEL_DESCRIPTION_LENGTH.toLocaleString()} characters or fewer.`
      )
  ),
  coverUrl: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z.string({ error: 'The novel cover URL must be text.' }).trim()
  ),
  alternativeNames: metadataLabelsSchema('Alternative names'),
  genres: metadataLabelsSchema('Genres'),
  source: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z
      .string({ error: 'The novel source must be text.' })
      .trim()
      .max(300, 'Novel source and status must be 300 characters or fewer.')
  ),
  novelStatus: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z
      .string({ error: 'The novel status must be text.' })
      .trim()
      .max(300, 'Novel source and status must be 300 characters or fewer.')
  ),
  language: z
    .string({ error: 'Enter a valid language code, such as en or en-US.' })
    .regex(
      /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/,
      'Enter a valid language code, such as en or en-US.'
    ),
  filename: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z
      .string({ error: 'The EPUB filename must be text.' })
      .trim()
      .max(255, 'The EPUB filename must be 255 characters or fewer.')
  ),
  sourceUrl: z.preprocess(
    (value) => (value === undefined ? '' : value),
    z.string()
  ),
  outputDirectory: z.preprocess(
    (value) => (typeof value === 'string' ? value : ''),
    z.string()
  ),
  chapters: z
    .array(
      z.object({
        title: z
          .string()
          .trim()
          .min(1, 'Chapter title is required.')
          .max(500, 'Chapter title must be 500 characters or fewer.'),
        url: z.string()
      })
    )
    .min(
      1,
      `Select between 1 and ${MAX_SELECTED_CHAPTERS.toLocaleString()} chapters.`
    )
    .max(
      MAX_SELECTED_CHAPTERS,
      `Select between 1 and ${MAX_SELECTED_CHAPTERS.toLocaleString()} chapters.`
    ),
  trackerRow: trackerRowInputSchema.optional()
})
