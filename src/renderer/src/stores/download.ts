import { defineStore } from 'pinia'
import type { ChapterLink, DiscoveryResult, JobProgress } from '../../../shared/contracts'

export interface SelectableChapter extends ChapterLink {
  selected: boolean
}

export const useDownloadStore = defineStore('download', {
  state: () => ({
    url: '',
    title: '',
    author: '',
    language: 'en',
    filename: '',
    sourceUrl: '',
    parserName: '',
    chapters: [] as SelectableChapter[],
    outputDirectory: '',
    busy: false,
    progress: null as JobProgress | null,
    error: '',
    success: ''
  }),
  getters: {
    selectedCount: (state) => state.chapters.filter((chapter) => chapter.selected).length
  },
  actions: {
    applyDiscovery(result: DiscoveryResult) {
      this.sourceUrl = result.sourceUrl
      this.url = result.sourceUrl
      this.title = result.title || 'Untitled'
      this.author = result.author
      this.filename = ''
      this.chapters = result.chapters.map((chapter) => ({ ...chapter, selected: true }))
      this.parserName = result.parserName
      this.progress = null
      this.error = ''
      this.success = ''
    },
    setProgress(progress: JobProgress) {
      this.progress = progress
    }
  }
})
