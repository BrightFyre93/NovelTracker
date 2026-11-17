import { z } from 'zod'
import type { EpubOutputOptions, EpubOutputPreferences } from './contracts/epub'
import { DEFAULT_EPUB_CSS } from './defaultEpubCss'
import { MAX_EPUB_CSS_LENGTH, MAX_SELECTED_CHAPTERS } from './constants'

export const DEFAULT_EPUB_OUTPUT_OPTIONS: EpubOutputOptions = {
  css: DEFAULT_EPUB_CSS,
  language: 'en',
  filenameTemplate: '',
  identifierSeed: '',
  includeNovelInfoPage: true,
  includeChapterListPage: false,
  skipImages: false,
  compressImages: true,
  maxImageDimension: 1080,
  imageFormat: 'jpeg',
  coverJpegOnly: false,
  flattenAnimatedImages: false,
  includeImageAttribution: false,
  maxChaptersPerEpub: 10_000
}

export const epubOutputOptionsSchema = z.object({
  css: z.string().max(MAX_EPUB_CSS_LENGTH).default(DEFAULT_EPUB_CSS),
  language: z.string().trim().min(2).max(35).default('en'),
  filenameTemplate: z.string().max(1000).default(''),
  identifierSeed: z.string().max(4096).default(''),
  includeNovelInfoPage: z.boolean().default(true),
  includeChapterListPage: z.boolean().default(false),
  skipImages: z.boolean().default(false),
  compressImages: z.boolean().default(true),
  maxImageDimension: z.number().int().min(64).max(8192).default(1080),
  imageFormat: z.enum(['jpeg', 'png', 'original']).default('jpeg'),
  coverJpegOnly: z.boolean().default(false),
  flattenAnimatedImages: z.boolean().default(false),
  includeImageAttribution: z.boolean().default(false),
  maxChaptersPerEpub: z.number().int().min(1).max(MAX_SELECTED_CHAPTERS).default(10_000)
})

export const DEFAULT_EPUB_OUTPUT_PREFERENCES: EpubOutputPreferences = {
  filenameTemplate: DEFAULT_EPUB_OUTPUT_OPTIONS.filenameTemplate,
  includeNovelInfoPage: DEFAULT_EPUB_OUTPUT_OPTIONS.includeNovelInfoPage,
  includeChapterListPage: DEFAULT_EPUB_OUTPUT_OPTIONS.includeChapterListPage,
  skipImages: DEFAULT_EPUB_OUTPUT_OPTIONS.skipImages,
  compressImages: DEFAULT_EPUB_OUTPUT_OPTIONS.compressImages,
  maxImageDimension: DEFAULT_EPUB_OUTPUT_OPTIONS.maxImageDimension,
  imageFormat: DEFAULT_EPUB_OUTPUT_OPTIONS.imageFormat,
  coverJpegOnly: DEFAULT_EPUB_OUTPUT_OPTIONS.coverJpegOnly,
  flattenAnimatedImages: DEFAULT_EPUB_OUTPUT_OPTIONS.flattenAnimatedImages,
  includeImageAttribution: DEFAULT_EPUB_OUTPUT_OPTIONS.includeImageAttribution,
  maxChaptersPerEpub: DEFAULT_EPUB_OUTPUT_OPTIONS.maxChaptersPerEpub
}

export const epubOutputPreferencesSchema = epubOutputOptionsSchema.omit({
  css: true,
  language: true,
  identifierSeed: true
})

export function normalizeEpubOutputPreferences(
  value: unknown
): EpubOutputPreferences {
  return epubOutputPreferencesSchema.parse(value)
}

export function normalizeEpubOutputOptions(
  value: unknown,
  legacy: { css?: string; language?: string } = {}
): EpubOutputOptions {
  const parsed = epubOutputOptionsSchema.safeParse(value ?? {})
  if (parsed.success) {
    return {
      ...parsed.data,
      css: parsed.data.css === DEFAULT_EPUB_CSS && legacy.css ? legacy.css : parsed.data.css,
      language: parsed.data.language === 'en' && legacy.language ? legacy.language : parsed.data.language
    }
  }
  return {
    ...DEFAULT_EPUB_OUTPUT_OPTIONS,
    ...(legacy.css ? { css: legacy.css } : {}),
    ...(legacy.language ? { language: legacy.language } : {})
  }
}
