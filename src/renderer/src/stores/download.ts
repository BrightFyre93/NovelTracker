import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { ChapterArchiveStatus, ChapterLink, DiscoveryResult } from '../../../shared/contracts'

export interface SelectableChapter extends ChapterLink {
  archiveStatus?: ChapterArchiveStatus
  archiveSources?: string[]
  chapterNumber?: number | null
  archiveGap?: boolean
  recommended?: boolean
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
    chapters: shallowRef<SelectableChapter[]>([]),
    chapterSelection: shallowRef(new Set<string>()),
    outputDirectory: '',
    busy: false,
    error: '',
    success: ''
  }),
  getters: {
    selectedCount: (state) => state.chapterSelection.size
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
      this.chapters = result.chapters.map(({ ...chapter }) => chapter)
      this.chapterSelection = new Set(result.chapters.map((chapter) => chapter.id))
      this.parserName = result.parserName
      this.error = ''
      this.success = ''
    },
    setChapterSelected(id: string, selected: boolean) {
      const selection = new Set(this.chapterSelection)
      if (selected) selection.add(id)
      else selection.delete(id)
      this.chapterSelection = selection
    },
    selectAllChapters(selected: boolean) {
      this.chapterSelection = selected
        ? new Set(this.chapters.map((chapter) => chapter.id))
        : new Set()
    },
    selectBoundaryChapter(boundary: 'first' | 'last') {
      const index = boundary === 'first' ? 0 : this.chapters.length - 1
      const chapter = this.chapters[index]
      this.chapterSelection = chapter ? new Set([chapter.id]) : new Set()
    }
  }
})
