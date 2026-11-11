export interface ChapterLink {
  id: string
  title: string
  url: string
}

export interface DiscoveryResult {
  sourceUrl: string
  title: string
  author: string
  parserName: string
  chapters: ChapterLink[]
}

export interface ChapterContent {
  title: string
  url: string
  paragraphs: string[]
}

export interface GenerateEpubInput {
  title: string
  author: string
  language: string
  filename?: string
  outputDirectory: string
  chapters: ChapterLink[]
}

export interface JobProgress {
  current: number
  total: number
  message: string
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export interface GenerateEpubResult {
  outputPath: string
  createdNumberedCopy: boolean
}

export interface NovelTrackerApi {
  discover(url: string): Promise<Result<DiscoveryResult>>
  chooseOutputDirectory(): Promise<string | null>
  generateEpub(input: GenerateEpubInput): Promise<Result<GenerateEpubResult>>
  onProgress(listener: (progress: JobProgress) => void): () => void
}
