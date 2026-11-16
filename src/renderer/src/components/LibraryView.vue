<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import VirtualScroller from 'primevue/virtualscroller'
import type { VirtualScrollerLazyEvent } from 'primevue/virtualscroller'
import type {
  EpubMergeProgress,
  LibraryFileListItem,
  LibraryFileRecord,
  LibraryIndexOverview,
  LibraryNovelSummary
} from '../../../shared/contracts'
import { toMessage, unwrapResult } from '../../../shared/errors'
import { analyzeLibraryCoverage } from '../../../shared/libraryCoverage'
import { useLibraryStore } from '../stores/library'

const emit = defineEmits<{
  openConfiguration: []
}>()

const libraryState = useLibraryStore()
const libraryRoot = ref('')
const outputDirectory = ref('')
const index = shallowRef<LibraryIndexOverview | null>(null)
const novelSummaries = shallowRef<Array<LibraryNovelSummary | null>>([])
const totalNovelCount = ref(0)
const backupDate = ref<string | null>(null)
const selectedFiles = shallowRef<LibraryFileRecord[]>([])
const search = ref('')
const multipleFilesOnly = ref(false)
const selectedNovel = ref('')
const selectedNovelSummary = shallowRef<LibraryNovelSummary | null>(null)
const selectedFileId = ref('')
const fileListItems = shallowRef<Array<LibraryFileListItem | null>>([])
const totalFileListCount = ref(0)
const restoringBackup = ref(false)
const merging = ref(false)
const repairing = ref(false)
const mergeProgress = ref<EpubMergeProgress | null>(null)
const mergeFileIds = ref<string[]>([])
const mergeFilename = ref('')
const correctedTitle = ref('')
const correctedCoverage = ref('')
const busy = computed(() =>
  libraryState.scanning || restoringBackup.value || merging.value || repairing.value
)
const error = ref('')
const success = ref('')
const loadingNovelFiles = ref(false)
const searchingNovels = ref(false)
const searchingFiles = ref(false)
const NOVEL_ROW_HEIGHT = 80
const FILE_ROW_HEIGHT = 52
const MIN_LIST_HEIGHT = 160
const MAX_LIST_HEIGHT = 560

const selectedGroup = computed(() => selectedNovelSummary.value)
const selectedFile = computed(() =>
  selectedFiles.value.find((file) => file.id === selectedFileId.value) ?? null
)
const selectedCoverageWarnings = computed(() =>
  analyzeLibraryCoverage(selectedFiles.value.filter((file) => file.format === 'EPUB')).warnings
)
const selectedMergeFiles = computed(() =>
  selectedFiles.value
    .filter((file) => file.format === 'EPUB' && mergeFileIds.value.includes(file.id))
    .sort((left, right) => {
      const leftStart = left.chapterNumbers[0] ?? left.filenameRange?.start ?? Number.MAX_SAFE_INTEGER
      const rightStart = right.chapterNumbers[0] ?? right.filenameRange?.start ?? Number.MAX_SAFE_INTEGER
      return leftStart - rightStart || left.filename.localeCompare(right.filename)
    })
)
const novelListHeight = computed(() =>
  virtualListHeight(totalNovelCount.value, NOVEL_ROW_HEIGHT)
)
const libraryFileListHeight = computed(() =>
  virtualListHeight(totalFileListCount.value, FILE_ROW_HEIGHT)
)

function virtualListHeight(itemCount: number, itemHeight: number): string {
  const height = Math.min(MAX_LIST_HEIGHT, Math.max(MIN_LIST_HEIGHT, itemCount * itemHeight))
  return `${height}px`
}

const NOVEL_SEARCH_DEBOUNCE_MS = 150
const NOVEL_SEARCH_PAGE_SIZE = 100
let novelSearchTimer: ReturnType<typeof setTimeout> | undefined
let novelSearchRevision = 0
const loadedNovelPages = new Set<number>()
const pendingNovelPages = new Map<number, number>()
let fileSearchRevision = 0
const loadedFilePages = new Set<number>()
const pendingFilePages = new Map<number, number>()

function clearSelectedNovel(): void {
  fileSearchRevision += 1
  selectedNovel.value = ''
  selectedNovelSummary.value = null
  selectedFileId.value = ''
  selectedFiles.value = []
  fileListItems.value = []
  totalFileListCount.value = 0
  searchingFiles.value = false
  loadedFilePages.clear()
  pendingFilePages.clear()
  mergeFileIds.value = []
  mergeFilename.value = ''
  loadingNovelFiles.value = false
}

function scheduleNovelSearch(): void {
  if (novelSearchTimer) clearTimeout(novelSearchTimer)
  const requestId = ++novelSearchRevision
  searchingNovels.value = true
  novelSearchTimer = setTimeout(() => {
    novelSearchTimer = undefined
    void refreshNovelSummaries(requestId)
  }, NOVEL_SEARCH_DEBOUNCE_MS)
}

async function refreshNovelSummaries(requestId?: number): Promise<void> {
  if (novelSearchTimer) {
    clearTimeout(novelSearchTimer)
    novelSearchTimer = undefined
  }
  const activeRequestId = requestId ?? ++novelSearchRevision
  loadedNovelPages.clear()
  pendingNovelPages.clear()
  if (!index.value) {
    if (activeRequestId === novelSearchRevision) {
      novelSummaries.value = []
      totalNovelCount.value = 0
      searchingNovels.value = false
      clearSelectedNovel()
    }
    return
  }
  const selectedNovelKey = selectedNovel.value || undefined
  novelSummaries.value = []
  totalNovelCount.value = 0
  searchingNovels.value = true
  try {
    const result = unwrapResult(await window.novelTracker.searchLibraryNovels(
      search.value,
      multipleFilesOnly.value,
      0,
      NOVEL_SEARCH_PAGE_SIZE,
      selectedNovelKey
    ))
    if (activeRequestId !== novelSearchRevision) return
    const items: Array<LibraryNovelSummary | null> =
      Array.from({ length: result.total }, () => null)
    result.items.forEach((novel, index) => {
      items[result.offset + index] = novel
    })
    loadedNovelPages.add(0)
    totalNovelCount.value = result.total
    novelSummaries.value = items
    if (selectedNovelKey && selectedNovel.value === selectedNovelKey) {
      if (result.selectedNovel) {
        selectedNovelSummary.value = result.selectedNovel
        await refreshNovelFileRows()
      } else {
        clearSelectedNovel()
      }
    }
    searchingNovels.value = false
  } catch (reason) {
    if (activeRequestId === novelSearchRevision) {
      error.value = toMessage(reason)
      searchingNovels.value = false
    }
  }
}

function loadNovelRows(event: VirtualScrollerLazyEvent): void {
  if (totalNovelCount.value === 0) return
  const firstPage = Math.floor(event.first / NOVEL_SEARCH_PAGE_SIZE)
  const lastIndex = Math.max(event.first, event.last - 1)
  const lastPage = Math.floor(lastIndex / NOVEL_SEARCH_PAGE_SIZE)
  for (let page = firstPage; page <= lastPage; page += 1) {
    void loadNovelPage(page, novelSearchRevision)
  }
}

async function loadNovelPage(page: number, requestId: number): Promise<void> {
  if (
    requestId !== novelSearchRevision ||
    loadedNovelPages.has(page) ||
    pendingNovelPages.get(page) === requestId
  ) {
    return
  }
  pendingNovelPages.set(page, requestId)
  const offset = page * NOVEL_SEARCH_PAGE_SIZE
  try {
    const result = unwrapResult(await window.novelTracker.searchLibraryNovels(
      search.value,
      multipleFilesOnly.value,
      offset,
      NOVEL_SEARCH_PAGE_SIZE
    ))
    if (requestId !== novelSearchRevision) return
    const items = [...novelSummaries.value]
    result.items.forEach((novel, index) => {
      items[result.offset + index] = novel
    })
    novelSummaries.value = items
    loadedNovelPages.add(page)
  } catch (reason) {
    if (requestId === novelSearchRevision)
      error.value = toMessage(reason)
  } finally {
    if (pendingNovelPages.get(page) === requestId)
      pendingNovelPages.delete(page)
  }
}

async function refreshNovelFileRows(): Promise<void> {
  const novelKey = selectedNovel.value
  const requestId = ++fileSearchRevision
  loadedFilePages.clear()
  pendingFilePages.clear()
  fileListItems.value = []
  totalFileListCount.value = 0
  if (!novelKey) {
    searchingFiles.value = false
    return
  }
  searchingFiles.value = true
  try {
    const result = unwrapResult(await window.novelTracker.searchLibraryNovelFiles(
      novelKey,
      search.value,
      0,
      NOVEL_SEARCH_PAGE_SIZE
    ))
    if (requestId !== fileSearchRevision || selectedNovel.value !== novelKey) return
    const items: Array<LibraryFileListItem | null> =
      Array.from({ length: result.total }, () => null)
    result.items.forEach((file, index) => {
      items[result.offset + index] = file
    })
    fileListItems.value = items
    totalFileListCount.value = result.total
    loadedFilePages.add(0)
  } catch (reason) {
    if (requestId === fileSearchRevision)
      error.value = toMessage(reason)
  } finally {
    if (requestId === fileSearchRevision) searchingFiles.value = false
  }
}

function loadFileRows(event: VirtualScrollerLazyEvent): void {
  if (totalFileListCount.value === 0) return
  const firstPage = Math.floor(event.first / NOVEL_SEARCH_PAGE_SIZE)
  const lastIndex = Math.max(event.first, event.last - 1)
  const lastPage = Math.floor(lastIndex / NOVEL_SEARCH_PAGE_SIZE)
  for (let page = firstPage; page <= lastPage; page += 1) {
    void loadFilePage(page, fileSearchRevision, selectedNovel.value)
  }
}

async function loadFilePage(
  page: number,
  requestId: number,
  novelKey: string
): Promise<void> {
  if (
    requestId !== fileSearchRevision ||
    loadedFilePages.has(page) ||
    pendingFilePages.get(page) === requestId
  ) {
    return
  }
  pendingFilePages.set(page, requestId)
  const offset = page * NOVEL_SEARCH_PAGE_SIZE
  try {
    const result = unwrapResult(await window.novelTracker.searchLibraryNovelFiles(
      novelKey,
      search.value,
      offset,
      NOVEL_SEARCH_PAGE_SIZE
    ))
    if (requestId !== fileSearchRevision || selectedNovel.value !== novelKey) return
    const items = [...fileListItems.value]
    result.items.forEach((file, index) => {
      items[result.offset + index] = file
    })
    fileListItems.value = items
    loadedFilePages.add(page)
  } catch (reason) {
    if (requestId === fileSearchRevision)
      error.value = toMessage(reason)
  } finally {
    if (pendingFilePages.get(page) === requestId)
      pendingFilePages.delete(page)
  }
}

watch([search, multipleFilesOnly], scheduleNovelSearch)
watch(search, () => {
  if (selectedNovel.value) void refreshNovelFileRows()
})

let removeProgressListener: (() => void) | undefined
let removeMergeProgressListener: (() => void) | undefined

onMounted(async () => {
  removeProgressListener = window.novelTracker.onLibraryProgress((value) => {
    libraryState.progress = value
  })
  removeMergeProgressListener = window.novelTracker.onLibraryEpubMergeProgress((value) => {
    mergeProgress.value = value
  })
  let configuredRoot = ''
  try {
    const settings = await window.novelTracker.getSettings()
    configuredRoot = settings.libraryRoot
    libraryRoot.value = configuredRoot
    outputDirectory.value = settings.outputDirectory
  } catch (reason) {
    error.value = toMessage(reason)
  }
  try {
    const savedIndex = await window.novelTracker.getLibraryIndexSummary()
    index.value = savedIndex && (!configuredRoot || savedIndex.libraryRoot === configuredRoot)
      ? savedIndex
      : null
    if (index.value) {
      if (!libraryRoot.value) libraryRoot.value = index.value.libraryRoot
      await refreshNovelSummaries()
      selectFirstNovel()
    }
  } catch (reason) {
    if (!error.value) error.value = toMessage(reason)
  }
  try {
    backupDate.value = await window.novelTracker.getLibraryIndexBackupDate()
  } catch (reason) {
    if (!error.value) error.value = toMessage(reason)
  }
})

onUnmounted(() => {
  if (novelSearchTimer) clearTimeout(novelSearchTimer)
  novelSearchRevision += 1
  removeProgressListener?.()
  removeMergeProgressListener?.()
})

const mergeProgressSteps = [
  { label: 'Read, extract, and combine source chapters', end: 75 },
  { label: 'Build EPUB package', end: 94 },
  { label: 'Validate EPUB contents', end: 99 },
  { label: 'Write output file', end: 100 }
] as const

function mergeProgressStepStatus(index: number): 'done' | 'active' | 'pending' | 'failed' {
  const progress = mergeProgress.value
  const step = mergeProgressSteps[index]
  if (!progress || !step) return 'pending'
  if (progress.stage === 'complete') return 'done'
  if (progress.stage === 'cancelled') return 'pending'
  const start = index === 0 ? 0 : mergeProgressSteps[index - 1]?.end ?? 0
  if (progress.stage === 'failed' && progress.percentage >= start && progress.percentage < step.end) {
    return 'failed'
  }
  if (progress.percentage >= step.end) return 'done'
  if (progress.percentage >= start) return 'active'
  return 'pending'
}

function selectFirstNovel(): void {
  const firstNovel = novelSummaries.value.find(
    (novel): novel is LibraryNovelSummary => novel !== null
  )
  if (!selectedNovel.value && firstNovel) void selectNovel(firstNovel)
  else if (!firstNovel) {
    selectedFiles.value = []
    selectedFileId.value = ''
    loadingNovelFiles.value = false
  }
}

async function selectNovel(novel: LibraryNovelSummary): Promise<void> {
  fileSearchRevision += 1
  selectedNovel.value = novel.key
  selectedNovelSummary.value = novel
  selectedFileId.value = ''
  selectedFiles.value = []
  fileListItems.value = []
  totalFileListCount.value = 0
  mergeFileIds.value = []
  mergeFilename.value = ''
  loadingNovelFiles.value = true
  try {
    const result = await window.novelTracker.getLibraryNovelFiles(novel.key)
    if (!result.ok) {
      error.value = result.error
      return
    }
    if (selectedNovel.value === novel.key) {
      selectedFiles.value = result.value
      await refreshNovelFileRows()
    }
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    if (selectedNovel.value === novel.key) loadingNovelFiles.value = false
  }
}

async function scan(forceRebuild = false): Promise<void> {
  error.value = ''
  success.value = ''
  libraryState.progress = null
  libraryState.cancelError = ''
  libraryState.cancelling = false
  libraryState.scanning = true
  try {
    const result = await window.novelTracker.scanLibrary(forceRebuild)
    if (!result.ok) {
      error.value = result.error
      return
    }
    index.value = result.value
    backupDate.value = await window.novelTracker.getLibraryIndexBackupDate()
    clearSelectedNovel()
    await refreshNovelSummaries()
    selectFirstNovel()
    const cacheSummary = result.value.scanSummary
    const cacheMessage = cacheSummary
      ? ` Reused metadata for ${cacheSummary.reusedFiles.toLocaleString()} files; inspected ${cacheSummary.inspectedFiles.toLocaleString()}.`
      : ''
    const errorMessage = result.value.scanErrors
      ? ` ${result.value.scanErrors.toLocaleString()} files need attention.`
      : ''
    success.value = `${forceRebuild ? 'Rebuilt' : 'Indexed'} ${result.value.fileCount.toLocaleString()} files.${cacheMessage}${errorMessage}`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    libraryState.scanning = false
    libraryState.cancelling = false
    libraryState.progress = null
    libraryState.cancelError = ''
  }
}

async function restoreBackup(): Promise<void> {
  if (!backupDate.value || restoringBackup.value) return
  if (!window.confirm('Restore the saved library index backup? The current index will be preserved as the new backup.')) {
    return
  }
  error.value = ''
  success.value = ''
  restoringBackup.value = true
  try {
    const result = await window.novelTracker.restoreLibraryIndexBackup()
    if (!result.ok) {
      error.value = result.error
      return
    }
    index.value = result.value
    libraryRoot.value = result.value.libraryRoot
    clearSelectedNovel()
    await refreshNovelSummaries()
    selectFirstNovel()
    backupDate.value = await window.novelTracker.getLibraryIndexBackupDate()
    success.value = 'Library index backup restored.'
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    restoringBackup.value = false
  }
}

async function openFile(file: LibraryFileRecord, reveal: boolean): Promise<void> {
  error.value = ''
  const result = await window.novelTracker.openLibraryPath(file.path, reveal)
  if (!result.ok) error.value = result.error
}

function selectFile(fileSummary: LibraryFileListItem | LibraryFileRecord): void {
  const file = 'chapterTitles' in fileSummary
    ? fileSummary
    : selectedFiles.value.find((candidate) => candidate.id === fileSummary.id)
  if (!file) {
    error.value = 'The selected library file is no longer available. Refresh the library index and try again.'
    return
  }
  selectedFileId.value = file.id
  correctedTitle.value = file.novelTitle
  correctedCoverage.value = ''
}

function toggleMergeFile(file: LibraryFileRecord): void {
  if (file.format !== 'EPUB') return
  if (mergeFileIds.value.includes(file.id)) {
    mergeFileIds.value = mergeFileIds.value.filter((id) => id !== file.id)
  } else if (mergeFileIds.value.length < 20) {
    mergeFileIds.value = [...mergeFileIds.value, file.id]
  } else {
    error.value = 'Select no more than 20 EPUBs for one merge.'
    return
  }
  const selected = selectedFiles.value.filter((candidate) => mergeFileIds.value.includes(candidate.id))
  if (selected.length === 0) {
    mergeFilename.value = ''
    return
  }
  const numbers = selected.flatMap((candidate) =>
    candidate.chapterNumbers.length > 0
      ? candidate.chapterNumbers
      : candidate.filenameRange
        ? [candidate.filenameRange.start, candidate.filenameRange.end]
        : []
  )
  const first = numbers.length ? numbers.reduce((minimum, number) => Math.min(minimum, number), Infinity) : ''
  const last = numbers.length ? numbers.reduce((maximum, number) => Math.max(maximum, number), -Infinity) : ''
  mergeFilename.value = `${selectedGroup.value?.title ?? 'Merged novel'} ${first}-${last}.epub`
}

async function mergeSelectedEpubs(): Promise<void> {
  if (mergeFileIds.value.length < 2) return
  error.value = ''
  success.value = ''
  merging.value = true
  mergeProgress.value = {
    stage: 'reading',
    percentage: 0,
    message: 'Starting EPUB merge…'
  }
  try {
    const result = await window.novelTracker.mergeLibraryEpubs([...mergeFileIds.value], mergeFilename.value)
    if (!result.ok) {
      if ('cancelled' in result) {
        mergeProgress.value = {
          stage: 'cancelled',
          percentage: mergeProgress.value?.percentage ?? 0,
          message: 'Merge cancelled. The existing output file was not changed.'
        }
        return
      }
      error.value = result.error
      mergeProgress.value = {
        stage: 'failed',
        percentage: mergeProgress.value?.percentage ?? 0,
        message: 'Merge stopped before completion.'
      }
      return
    }
    const duplicates = result.value.duplicateChapterCount
      ? ` Removed ${result.value.duplicateChapterCount.toLocaleString()} duplicate chapter(s); the earlier-range copy was kept.`
      : ''
    const conflicts = result.value.conflictingChapterCount
      ? ` ${result.value.conflictingChapterCount.toLocaleString()} duplicate(s) had different text; the earlier-range copy was kept.`
      : ''
    success.value = `Created ${result.value.chapterCount.toLocaleString()} chapters at ${result.value.outputPath}.${duplicates}${conflicts}`
    mergeFileIds.value = []
  } catch (reason) {
    error.value = toMessage(reason)
    mergeProgress.value = {
      stage: 'failed',
      percentage: mergeProgress.value?.percentage ?? 0,
      message: 'Merge stopped before completion.'
    }
  } finally {
    merging.value = false
  }
}

async function repairExistingEpub(fileId: string): Promise<void> {
  error.value = ''
  success.value = ''
  repairing.value = true
  try {
    const result = await window.novelTracker.repairEpub(fileId)
    if (!result.ok) {
      if (!('cancelled' in result)) error.value = result.error
      return
    }
    const imageSummary = result.value.repairedWebpImages
      ? ` Converted ${result.value.repairedWebpImages.toLocaleString()} WebP image(s) to JPEG.`
      : ' No WebP images needed conversion.'
    const coverSummary = result.value.upscaledCover
      ? ' Upscaled the undersized cover to Kindle minimum dimensions; it may appear soft.'
      : ''
    const mimetypeSummary = result.value.fixedMimetype
      ? ' Corrected EPUB mimetype and ZIP ordering.'
      : ''
    success.value = `Checked and repaired EPUB copy at ${result.value.outputPath}.${imageSummary}${coverSummary}${mimetypeSummary} Review it in Kindle Previewer.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    repairing.value = false
  }
}

function parseCoverage(value: string): number[] | undefined {
  const input = value.trim()
  if (!input) return undefined
  if (/^none$/i.test(input)) return []

  const numbers = new Set<number>()
  for (const part of input.split(',')) {
    const token = part.trim()
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (end < start || end - start > 10_000) throw new Error('Enter chapter ranges in ascending order with at most 10,001 chapters.')
      for (let chapter = start; chapter <= end; chapter += 1) numbers.add(chapter)
      continue
    }
    if (!/^\d+$/.test(token)) throw new Error('Use comma-separated chapter numbers or ranges, such as 1-50, 52, 54.')
    numbers.add(Number(token))
  }
  if (numbers.size > 10_000) throw new Error('Enter no more than 10,000 chapter numbers.')
  return [...numbers].sort((left, right) => left - right)
}

async function saveCorrection(): Promise<void> {
  if (!selectedFile.value) return
  error.value = ''
  success.value = ''
  try {
    const chapterNumbers = parseCoverage(correctedCoverage.value)
    const correctedFileId = selectedFile.value.id
    const result = await window.novelTracker.correctLibraryFile(correctedFileId, {
      novelTitle: correctedTitle.value.trim() || undefined,
      chapterNumbers
    })
    if (!result.ok) {
      error.value = result.error
      return
    }
    index.value = result.value.index
    search.value = ''
    await nextTick()
    await refreshNovelSummaries()
    await selectNovel(result.value.novel)
    success.value = 'Library correction saved locally.'
  } catch (reason) {
    error.value = toMessage(reason)
  }
}

function coverageLabel(file: LibraryFileRecord): string {
  if (file.chapterNumbers.length > 0) {
    const first = file.chapterNumbers[0]
    const last = file.chapterNumbers[file.chapterNumbers.length - 1]
    return first === last ? `${first}` : `${first}-${last} (${file.chapterNumbers.length} found)`
  }
  if (file.filenameRange) return `${file.filenameRange.start}-${file.filenameRange.end} (filename only)`
  return 'Unknown'
}

function chapterRangeLabel(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`
}
</script>

<template>
  <section class="library-page">
    <section class="card" aria-labelledby="library-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">HISTORICAL ARCHIVE</p>
          <h3 id="library-heading">Library index</h3>
        </div>
        <div class="library-actions">
          <Button
            label="Configuration"
            icon="pi pi-cog"
            severity="secondary"
            outlined
            @click="emit('openConfiguration')"
          />
          <Button
            label="Scan / rescan"
            icon="pi pi-refresh"
            title="Scan for added or removed files, reusing cached metadata for unchanged files. This does not modify library files; use Rebuild index to reinspect everything."
            :disabled="busy || !libraryRoot"
            @click="scan()"
          />
          <Button
            label="Rebuild index"
            icon="pi pi-sync"
            severity="secondary"
            outlined
            title="Reinspect files without reusing the cached index. The current index is backed up first."
            :disabled="busy || !libraryRoot"
            @click="scan(true)"
          />
          <Button
            v-if="backupDate"
            label="Restore backup"
            icon="pi pi-history"
            severity="secondary"
            outlined
            :title="`Last index backup saved: ${new Date(backupDate).toLocaleString()}`"
            :disabled="busy"
            :loading="restoringBackup"
            @click="restoreBackup"
          />
        </div>
      </div>
      <p class="help-text library-note">
        Set or change the historical library root in Configuration. Scans are read-only; EPUB chapter lists are inspected, while AZW3 files are indexed by filename and file metadata only.
      </p>
      <div v-if="index" class="library-summary">
        <div><strong>{{ totalNovelCount.toLocaleString() }}</strong><span>visible novels</span></div>
        <div><strong>{{ index.fileCount.toLocaleString() }}</strong><span>indexed ebook files</span></div>
        <small>Last scan {{ new Date(index.scannedAt).toLocaleString() }} · {{ index.scanErrors.toLocaleString() }} issues</small>
      </div>
      <Message v-if="!index && !busy" severity="info" :closable="false" class="feedback">
        {{ backupDate
          ? 'No current index is loaded. Restore the saved backup or rebuild the index from the configured library root.'
          : libraryRoot
            ? 'Your library root is configured. Scan it to build the index; the scan will not move or modify files.'
            : 'Go to Configuration and set a historical library root, then scan it here. The scan will not move or modify files.' }}
      </Message>
    </section>

    <div v-if="index" class="library-browser">
      <section class="card library-novels" aria-label="Indexed novels">
        <div class="library-list-heading">
          <h3>Novels</h3>
          <InputText v-model="search" class="library-search" placeholder="Search title or file" />
        </div>
        <label class="library-multi-file-filter">
          <input v-model="multipleFilesOnly" type="checkbox" />
          <span>Show novels with more than one file</span>
        </label>
        <VirtualScroller
          v-if="totalNovelCount > 0"
          :items="novelSummaries"
          :itemSize="NOVEL_ROW_HEIGHT"
          :lazy="true"
          class="novel-list"
          :style="{ height: novelListHeight }"
          aria-label="Indexed novels"
          @lazy-load="loadNovelRows"
        >
          <template #item="{ item: novel }">
            <button
              v-if="novel"
              class="novel-choice"
              :class="{ active: selectedNovel === novel.key }"
              @click="selectNovel(novel)"
            >
              <span class="novel-choice-title">{{ novel.title }}</span>
              <span class="novel-choice-count">
                {{ novel.files.length }} files
                <template v-if="novel.stateCounts.Completed"> · Completed {{ novel.stateCounts.Completed }}</template>
                <template v-if="novel.stateCounts.Sent"> · Sent {{ novel.stateCounts.Sent }}</template>
                <template v-if="novel.stateCounts.Downloaded"> · Downloaded {{ novel.stateCounts.Downloaded }}</template>
                <template v-if="novel.stateCounts.Old"> · Old {{ novel.stateCounts.Old }}</template>
                <template v-if="novel.stateCounts['Old Completed']"> · Old Completed {{ novel.stateCounts['Old Completed'] }}</template>
              </span>
              <span
                v-if="novel.coverage.duplicateNumberCount || novel.coverage.gapCount || novel.coverage.unverifiedCount || novel.coverage.rangeMismatchCount"
                class="novel-coverage-summary"
              >
                <template v-if="novel.coverage.gapCount">{{ novel.coverage.gapCount }} possible gaps</template>
                <template v-if="novel.coverage.duplicateNumberCount">
                  <template v-if="novel.coverage.gapCount"> · </template>
                  {{ novel.coverage.duplicateNumberCount }} duplicate chapter numbers
                </template>
                <template v-if="novel.coverage.unverifiedCount">
                  <template v-if="novel.coverage.gapCount || novel.coverage.duplicateNumberCount"> · </template>
                  {{ novel.coverage.unverifiedCount }} files need review
                </template>
                <template v-if="novel.coverage.rangeMismatchCount">
                  <template v-if="novel.coverage.gapCount || novel.coverage.duplicateNumberCount || novel.coverage.unverifiedCount"> · </template>
                  {{ novel.coverage.rangeMismatchCount }} range mismatch{{ novel.coverage.rangeMismatchCount === 1 ? '' : 'es' }}
                </template>
              </span>
            </button>
            <div v-else class="novel-choice novel-choice-placeholder" aria-hidden="true"></div>
          </template>
        </VirtualScroller>
        <p v-else class="empty-state">
          {{ searchingNovels ? 'Searching…' : 'No matching novels.' }}
        </p>
      </section>

      <section class="card library-files" aria-label="Files and coverage">
        <div class="library-list-heading">
          <div>
            <h3>{{ selectedGroup?.title || 'Source files' }}</h3>
            <p v-if="selectedGroup" class="chapter-toolbar-note">{{ selectedGroup.files.length.toLocaleString() }} indexed files</p>
          </div>
        </div>
        <div v-if="selectedGroup && loadingNovelFiles" class="help-text">Loading this novel's chapter and coverage details…</div>
        <VirtualScroller
          v-else-if="selectedGroup && totalFileListCount > 0"
          :items="fileListItems"
          :itemSize="FILE_ROW_HEIGHT"
          :lazy="true"
          class="library-file-list"
          :style="{ height: libraryFileListHeight }"
          aria-label="Novel files"
          @lazy-load="loadFileRows"
        >
          <template #item="{ item: file }">
            <button
              v-if="file"
              class="library-file-row"
              :class="{ active: selectedFileId === file.id }"
              @click="selectFile(file)"
            >
              <span class="library-file-name">{{ file.filename }}</span>
              <span class="library-file-meta">{{ file.folderState }} · {{ file.format }} · {{ file.coverage }}</span>
            </button>
            <div v-else class="library-file-row library-file-row-placeholder" aria-hidden="true"></div>
          </template>
        </VirtualScroller>
        <p v-else-if="selectedGroup" class="empty-state">
          {{ searchingFiles ? 'Searching files…' : 'No matching files.' }}
        </p>
        <p v-else class="empty-state">Choose a novel to inspect its files.</p>

        <section v-if="selectedGroup" class="library-merge-panel">
          <strong>Combine existing EPUBs offline</strong>
          <p class="help-text">
            Select at least two EPUBs. They are ordered by chapter range; duplicate chapter numbers are included once, preferring the lower-range file. No network requests are made.
          </p>
          <p class="file-evidence">{{ mergeFileIds.length }} of 20 EPUBs selected</p>
          <ul v-if="selectedMergeFiles.length" class="merge-source-list">
            <li v-for="file in selectedMergeFiles" :key="file.id">
              {{ file.filename }} · {{ coverageLabel(file) }}
            </li>
          </ul>
          <div class="merge-filename-row">
            <InputText v-model="mergeFilename" class="full-input" aria-label="Merged EPUB filename" placeholder="Combined EPUB filename" />
            <Button
              label="Create merged EPUB"
              icon="pi pi-clone"
              :loading="merging"
              :disabled="busy || mergeFileIds.length < 2 || !outputDirectory"
              @click="mergeSelectedEpubs"
            />
          </div>
          <div
            v-if="mergeProgress"
            class="merge-progress-panel"
            role="status"
            aria-live="polite"
          >
            <div class="merge-progress-heading">
              <strong>{{
                mergeProgress.stage === 'complete'
                  ? 'Merge complete'
                  : mergeProgress.stage === 'cancelled'
                    ? 'Merge cancelled'
                    : mergeProgress.stage === 'failed'
                      ? 'Merge stopped'
                      : 'Merging EPUBs'
              }}</strong>
              <span>{{ Math.round(mergeProgress.percentage) }}%</span>
            </div>
            <ProgressBar :value="mergeProgress.percentage" :show-value="false" />
            <p class="merge-progress-message">{{ mergeProgress.message }}</p>
            <ol class="merge-progress-steps">
              <li
                v-for="(step, stepIndex) in mergeProgressSteps"
                :key="step.label"
                :class="`is-${mergeProgressStepStatus(stepIndex)}`"
              >
                <i
                  :class="{
                    'pi pi-check-circle': mergeProgressStepStatus(stepIndex) === 'done',
                    'pi pi-spin pi-spinner': mergeProgressStepStatus(stepIndex) === 'active' && merging,
                    'pi pi-exclamation-circle': mergeProgressStepStatus(stepIndex) === 'failed',
                    'pi pi-circle': mergeProgressStepStatus(stepIndex) === 'pending' ||
                      (mergeProgressStepStatus(stepIndex) === 'active' && !merging)
                  }"
                  aria-hidden="true"
                />
                <span>{{ step.label }}</span>
              </li>
            </ol>
          </div>
          <p v-if="!outputDirectory" class="help-text">Choose an EPUB output folder in Configuration before merging.</p>
        </section>

        <details
          v-if="selectedGroup && selectedCoverageWarnings.length"
          class="coverage-warning-panel"
        >
          <summary>Coverage warnings ({{ selectedCoverageWarnings.length }})</summary>
          <p class="coverage-warning-note">
            Gaps mean no chapter evidence was found between the neighboring numbers shown; they are not proof that a source chapter is missing. Beginning and ending gaps need a known source chapter list.
          </p>
          <ul v-if="selectedCoverageWarnings.length" class="coverage-warning-list">
            <li v-for="warning in selectedCoverageWarnings" :key="warning.key">
              <template v-if="warning.kind === 'gap'">
                <strong>Possible missing chapter(s) {{ chapterRangeLabel(warning.start, warning.end) }}</strong>
                <p>Evidence before the gap:</p>
                <button
                  v-for="file in warning.before"
                  :key="`before-${warning.key}-${file.id}`"
                  class="warning-file-link"
                  @click="selectFile(file)"
                >
                  {{ file.chapterNumbers.filter((chapter) => chapter <= warning.start - 1).slice(-1)[0] }} · {{ file.relativePath }}
                </button>
                <p>Evidence after the gap:</p>
                <button
                  v-for="file in warning.after"
                  :key="`after-${warning.key}-${file.id}`"
                  class="warning-file-link"
                  @click="selectFile(file)"
                >
                  {{ file.chapterNumbers.find((chapter) => chapter >= warning.end + 1) }} · {{ file.relativePath }}
                </button>
              </template>
              <template v-else-if="warning.kind === 'duplicate'">
                <strong>
                  Chapter{{ warning.start === warning.end ? '' : 's' }}
                  {{ chapterRangeLabel(warning.start, warning.end) }} appear in multiple files
                </strong>
                <button
                  v-for="file in warning.files"
                  :key="`${warning.key}-${file.id}`"
                  class="warning-file-link"
                  @click="selectFile(file)"
                >
                  {{ file.coverageConfidence }} · {{ file.relativePath }}
                </button>
              </template>
              <template v-else-if="warning.kind === 'unverified'">
                <strong>No chapter coverage verified · {{ warning.file.relativePath }}</strong>
                <p>{{ warning.explanation }}</p>
                <button class="warning-file-link" @click="selectFile(warning.file)">Inspect this file</button>
              </template>
              <template v-else>
                <strong>
                  Extracted chapter numbers {{ warning.chapters[0] }}<template v-if="warning.chapters.length > 1">–{{ warning.chapters[warning.chapters.length - 1] }}</template>
                  fall outside the filename range {{ warning.file.filenameRange?.start }}–{{ warning.file.filenameRange?.end }}
                </strong>
                <p>These out-of-range numbers are excluded from gap and duplicate-number calculations. Check whether this file includes unrelated TOC entries or has a misleading filename.</p>
                <button class="warning-file-link" @click="selectFile(warning.file)">{{ warning.file.relativePath }}</button>
              </template>
            </li>
          </ul>
          <p v-else class="empty-state">No extracted-coverage warnings.</p>
        </details>

        <div v-if="selectedFile" class="library-file-detail">
          <div class="file-detail-heading">
            <div>
              <span class="field-label">{{ selectedFile.folderState }} · {{ selectedFile.format }}</span>
              <strong>{{ selectedFile.relativePath }}</strong>
            </div>
            <div class="toolbar-actions">
              <Button label="Open" severity="secondary" text size="small" @click="openFile(selectedFile, false)" />
              <Button label="Show in folder" severity="secondary" text size="small" @click="openFile(selectedFile, true)" />
              <Button
                v-if="selectedFile.format === 'EPUB'"
                label="Check / repair"
                icon="pi pi-wrench"
                severity="secondary"
                text
                size="small"
                :loading="repairing"
                :disabled="busy"
                @click="repairExistingEpub(selectedFile.id)"
              />
              <Button
                v-if="selectedFile.format === 'EPUB'"
                :label="mergeFileIds.includes(selectedFile.id) ? 'Remove from merge' : 'Add to merge'"
                :icon="mergeFileIds.includes(selectedFile.id) ? 'pi pi-minus-circle' : 'pi pi-plus-circle'"
                severity="secondary"
                text
                size="small"
                :disabled="busy"
                @click="toggleMergeFile(selectedFile)"
              />
            </div>
          </div>
          <p class="file-evidence">
            {{ (selectedFile.size / 1024 / 1024).toFixed(1) }} MB
            · {{ coverageLabel(selectedFile) }} · {{ selectedFile.coverageConfidence }} evidence
          </p>
          <p v-if="selectedFile.chapterTitles.length" class="file-evidence">
            {{ selectedFile.chapterTitles.slice(0, 5).join(' · ') }}<span v-if="selectedFile.chapterTitles.length > 5"> …</span>
          </p>
          <Message v-if="selectedFile.inspectionError" severity="warn" :closable="false">
            {{ selectedFile.inspectionError }}
          </Message>
          <div class="correction-grid" :class="{ 'azw3-correction-grid': selectedFile.format === 'AZW3' }">
            <div v-if="selectedFile.format === 'EPUB'">
              <label class="field-label" for="corrected-novel-title">Match to novel</label>
              <InputText id="corrected-novel-title" v-model="correctedTitle" class="full-input" maxlength="300" />
            </div>
            <div>
              <label class="field-label" for="corrected-coverage">Override chapters (optional)</label>
              <InputText
                id="corrected-coverage"
                v-model="correctedCoverage"
                class="full-input"
                placeholder="e.g. 1-50, 52, 54 (or none)"
              />
            </div>
          </div>
          <Button label="Save correction" severity="secondary" outlined size="small" :disabled="busy" @click="saveCorrection" />
        </div>
      </section>
    </div>

    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="success" severity="success" :closable="false" class="feedback">{{ success }}</Message>
  </section>
</template>
