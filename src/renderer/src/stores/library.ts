import { defineStore } from 'pinia'
import type { LibraryProgress } from '../../../shared/contracts'

export const useLibraryStore = defineStore('library', {
  state: () => ({
    scanning: false,
    cancelling: false,
    progress: null as LibraryProgress | null,
    cancelError: ''
  })
})
