import { defineStore } from 'pinia'
import type { ChapterArchiveStatus, ChapterLink, DiscoveryResult } from '../../../shared/contracts'

export interface SelectableChapter extends ChapterLink {
  selected: boolean
  archiveStatus?: ChapterArchiveStatus
  archiveSources?: string[]
  chapterNumber?: number | null
  archiveGap?: boolean
  recommended?: boolean
  deliberateOverlap?: boolean
}

export const useDownloadStore = defineStore('download', {
  state: () => ({
    url: '',
    title: '',
    author: '',
    description: '',
    coverUrl: '',
    alternativeNames: [] as string[],
    genres: [] as string[],
    source: '',
    novelStatus: '',
    language: 'en',
    filename: '',
    trackerRow: null as { stableId: string; rowNumber: number; title: string; csvPath: string } | null,
    trackerSourceUrl: '',
    queueItemId: '',
    sourceUrl: '',
    parserName: '',
    chapters: [] as SelectableChapter[],
    outputDirectory: '',
    busy: false,
    error: '',
    success: ''
  }),
  getters: {
    selectedCount: (state) => state.chapters.filter((chapter) => chapter.selected).length
  },
  actions: {
    applyDiscovery(result: DiscoveryResult) {
      this.queueItemId = ''
      this.sourceUrl = result.sourceUrl
      this.url = result.sourceUrl
      this.title = result.title || 'Untitled'
      this.author = result.author
      this.description = result.description
      this.coverUrl = result.coverUrl
      this.alternativeNames = [...result.alternativeNames]
      this.genres = [...result.genres]
      this.source = result.source
      this.novelStatus = result.novelStatus
      this.filename = ''
      this.chapters = result.chapters.map((chapter) => ({ ...chapter, selected: true }))
      this.parserName = result.parserName
      this.error = ''
      this.success = ''
    }
  }
})
