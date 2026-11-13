<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type {
  DiscoveryQueueItem,
  DownloadHistoryEntry,
  LibraryOperation,
  TrackerNovel
} from '../../shared/contracts'
import { QUEUE_SELECTION_SAVE_DEBOUNCE_MS } from '../../shared/constants'
import { MAX_EPUB_FILENAME_BASENAME_LENGTH, suggestEpubFilename } from '../../shared/epubFilename'
import ConfigurationView from './components/ConfigurationView.vue'
import LibraryView from './components/LibraryView.vue'
import QueueView from './components/QueueView.vue'
import { useDownloadStore } from './stores/download'
import { useLibraryStore } from './stores/library'

const store = useDownloadStore()
const libraryState = useLibraryStore()
const {
  scanning: libraryScanning,
  cancelling: libraryCancelling,
  progress: libraryProgress,
  cancelError: libraryCancelError
} = storeToRefs(libraryState)
const activeView = ref<'create' | 'queue' | 'library' | 'configuration'>('create')
const browserBusy = ref(false)
const browserAssistOpen = ref(false)
const browserDiscoveryRunning = ref(false)
const browserPageTitle = ref('')
const browserAssistUrl = ref('')
const separateJob = ref(false)
const trackerVisible = ref(false)
const trackerLoading = ref(false)
const trackerNovels = ref<TrackerNovel[]>([])
const trackerSearch = ref('')
const trackerSources = ref<Record<string, string>>({})
const trackerCsvPath = ref('')
const chapterSearch = ref('')
const downloadHistory = ref<DownloadHistoryEntry[]>([])
const convertingHistoryId = ref('')
const libraryOperations = ref<LibraryOperation[]>([])
const {
  url,
  title,
  author,
  description,
  coverUrl,
  alternativeNames,
  genres,
  source,
  novelStatus,
  language,
  filename,
  chapters,
  sourceUrl,
  parserName,
  outputDirectory,
  busy,
  error,
  success,
  selectedCount
} = storeToRefs(store)
const hasCurrentDiscovery = computed(() => Boolean(sourceUrl.value) && url.value.trim() === sourceUrl.value)
const filenamePreview = computed(() => {
  const selected = chapters.value.filter((chapter) => chapter.selected)
  const suggestion =
    selected.length === 0
      ? suggestEpubFilename(title.value, '', '')
      : suggestEpubFilename(title.value, selected[0].title, selected[selected.length - 1].title)
  if (!separateJob.value || !store.queueItemId) return suggestion
  const suffix = ` (separate ${store.queueItemId.slice(0, 8)})`
  const basename = suggestion.replace(/\.epub$/i, '')
  const prefix = basename
    .slice(0, MAX_EPUB_FILENAME_BASENAME_LENGTH - suffix.length)
    .replace(/[. ]+$/g, '')
  return `${prefix}${suffix}.epub`
})
const filteredTrackerNovels = computed(() => {
  const query = trackerSearch.value.trim().toLocaleLowerCase()
  if (!query) return trackerNovels.value.slice(0, 100)
  return trackerNovels.value
    .filter((novel) =>
      `${novel.title} ${novel.siteTitle} ${novel.author} ${novel.alternativeNames}`
        .toLocaleLowerCase()
        .includes(query)
    )
    .slice(0, 100)
})
const filteredChapters = computed(() => {
  const query = chapterSearch.value.trim().toLocaleLowerCase()
  return chapters.value
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) =>
      !query || `${chapter.title} ${chapter.url}`.toLocaleLowerCase().includes(query)
    )
})
const libraryScanProgressValue = computed(() => {
  const currentProgress = libraryState.progress
  return currentProgress && currentProgress.total > 0
    ? Math.round((currentProgress.current / currentProgress.total) * 100)
    : 0
})
const libraryScanCountLabel = computed(() => {
  const currentProgress = libraryState.progress
  if (!currentProgress) return 'Preparing the scan…'
  if (currentProgress.stage === 'scan') {
    return `${currentProgress.discoveredFiles.toLocaleString()} files found · indexing will begin after discovery`
  }
  if (currentProgress.totalFiles === 0) return 'No supported files found'
  return `${currentProgress.indexedFiles.toLocaleString()} of ${currentProgress.totalFiles.toLocaleString()} indexed · ${currentProgress.discoveredFiles.toLocaleString()} found`
})

watch(url, (value) => {
  if (browserAssistUrl.value && value.trim() !== browserAssistUrl.value) {
    browserAssistOpen.value = false
    browserPageTitle.value = ''
    browserAssistUrl.value = ''
  }
  if (sourceUrl.value && value.trim() !== sourceUrl.value) {
    store.queueItemId = ''
    separateJob.value = false
    sourceUrl.value = ''
    chapters.value = []
    title.value = ''
    author.value = ''
    description.value = ''
    coverUrl.value = ''
    alternativeNames.value = []
    genres.value = []
    source.value = ''
    novelStatus.value = ''
    filename.value = ''
    parserName.value = ''
    store.success = ''
  }
  if (store.trackerRow && value.trim() !== store.trackerSourceUrl) {
    store.trackerRow = null
    store.trackerSourceUrl = ''
  }
})

let removeQueueListener: (() => void) | undefined
let removeLibraryOperationsListener: (() => void) | undefined

onMounted(() => {
  removeLibraryOperationsListener = window.novelTracker.onLibraryOperationsUpdate((operations) => {
    libraryOperations.value = operations
  })
  void window.novelTracker.getLibraryOperations().then((operations) => {
    libraryOperations.value = operations
  }).catch((error: unknown) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
  removeQueueListener = window.novelTracker.onDiscoveryQueueUpdate(() => {
    void window.novelTracker.getDownloadHistory().then((history) => {
      downloadHistory.value = history
    }).catch((reason: unknown) => {
      store.error = reason instanceof Error ? reason.message : String(reason)
    })
  })
  void window.novelTracker.getSettings().then((settings) => {
    if (settings.outputDirectory) store.outputDirectory = settings.outputDirectory
    trackerCsvPath.value = settings.trackerCsvPath
    applyAppTheme(settings.appTheme)
  }).catch((error: unknown) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
  void window.novelTracker.getDownloadHistory().then((history) => {
    downloadHistory.value = history
  }).catch((error: unknown) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
})

onUnmounted(() => {
  removeQueueListener?.()
  removeLibraryOperationsListener?.()
})

function libraryOperationLabel(operation: LibraryOperation): string {
  switch (operation.kind) {
    case 'merge-epubs': return 'Merge EPUBs'
    case 'epub-to-azw3': return 'EPUB to AZW3'
    case 'azw3-to-epub': return 'AZW3 to EPUB'
    case 'repair-epub': return 'Check / repair EPUB'
  }
}

async function discover(): Promise<void> {
  store.error = ''
  store.success = ''
  store.busy = true
  try {
    const result = await window.novelTracker.discover(store.url)
    if (!result.ok) {
      store.error = result.error
      return
    }
    chapterSearch.value = ''
    store.applyDiscovery(result.value)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    store.busy = false
  }
}

async function openBrowserForVerification(): Promise<void> {
  store.error = ''
  browserBusy.value = true
  try {
    const result = await window.novelTracker.openVerificationBrowser(store.url)
    if (!result.ok) {
      browserAssistOpen.value = false
      browserAssistUrl.value = ''
      store.error = result.error
      return
    }
    browserAssistOpen.value = true
    browserPageTitle.value = result.value.title
    browserAssistUrl.value = store.url.trim()
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    browserBusy.value = false
  }
}

async function discoverWithBrowser(): Promise<void> {
  store.error = ''
  store.success = ''
  store.busy = true
  browserBusy.value = true
  try {
    if (!browserAssistOpen.value || browserAssistUrl.value !== store.url.trim()) {
      const session = await window.novelTracker.openVerificationBrowser(store.url)
      if (!session.ok) {
        browserAssistOpen.value = false
        browserAssistUrl.value = ''
        store.error = session.error
        return
      }
      browserAssistOpen.value = true
      browserAssistUrl.value = store.url.trim()
      browserPageTitle.value = session.value.title
      store.success = 'Visible Chromium is open. Complete any sign-in or verification manually, then click Discover using browser again.'
      return
    }

    browserDiscoveryRunning.value = true
    const result = await window.novelTracker.discoverWithBrowser(store.url)
    if (!result.ok) {
      store.error = result.error
      if (result.error.includes('Open the visible browser')) {
        browserAssistOpen.value = false
        browserAssistUrl.value = ''
      }
      return
    }
    chapterSearch.value = ''
    store.applyDiscovery({
      ...result.value,
      parserName: `${result.value.parserName} (browser-assisted)`
    })
    store.success = 'Browser-assisted discovery completed. Browser cookies are used only for browser-assisted requests.'
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    store.busy = false
    browserBusy.value = false
    browserDiscoveryRunning.value = false
  }
}

async function cancelBrowserDiscovery(): Promise<void> {
  try {
    await window.novelTracker.cancelBrowserDiscovery()
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

async function clearBrowserData(): Promise<void> {
  if (!window.confirm('Clear saved browser cookies and site data for NovelTracker? This does not clear other app settings.')) return
  store.error = ''
  store.success = ''
  browserBusy.value = true
  try {
    const result = await window.novelTracker.clearBrowserSession()
    if (!result.ok) {
      store.error = result.error
      return
    }
    browserAssistOpen.value = false
    browserPageTitle.value = ''
    browserAssistUrl.value = ''
    store.success = 'Saved browser session data was cleared.'
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    browserBusy.value = false
  }
}

async function cancelLibraryScan(): Promise<void> {
  if (libraryState.cancelling || libraryState.progress?.stage === 'save') return
  libraryState.cancelling = true
  libraryState.cancelError = ''
  try {
    await window.novelTracker.cancelLibraryScan()
  } catch (error) {
    libraryState.cancelError = error instanceof Error ? error.message : String(error)
    libraryState.cancelling = false
  }
}

async function openTrackerPicker(): Promise<void> {
  trackerVisible.value = true
  trackerSearch.value = ''
  store.error = ''
  trackerLoading.value = true
  try {
    const result = await window.novelTracker.getTrackerNovels()
    if (!result.ok) {
      store.error = result.error
      return
    }
    trackerNovels.value = result.value
    trackerSources.value = Object.fromEntries(
      result.value.map((novel) => [
        novel.stableId,
        novel.sources.find((source) => source.valid)?.url ?? novel.sources[0]?.url ?? ''
      ])
    )
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    trackerLoading.value = false
  }
}

async function openCreateView(): Promise<void> {
  try {
    if (store.queueItemId) {
      const queue = await window.novelTracker.getDiscoveryQueue()
      const currentItem = queue.find((item) => item.id === store.queueItemId)
      if (!currentItem || (currentItem.status !== 'needs-review' && currentItem.status !== 'ready')) {
        resetDiscoveryForm()
      }
    }
    activeView.value = 'create'
    const settings = await window.novelTracker.getSettings()
    if (settings.outputDirectory) store.outputDirectory = settings.outputDirectory
    trackerCsvPath.value = settings.trackerCsvPath
    applyAppTheme(settings.appTheme)
  } catch (error) {
    activeView.value = 'create'
    store.error = error instanceof Error ? error.message : String(error)
  }
}

function applyAppTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme
}

function resetDiscoveryForm(): void {
  if (queueSelectionTimer) {
    clearTimeout(queueSelectionTimer)
    queueSelectionTimer = undefined
  }
  store.queueItemId = ''
  separateJob.value = false
  store.sourceUrl = ''
  store.url = ''
  store.title = ''
  store.author = ''
  store.description = ''
  store.coverUrl = ''
  store.alternativeNames = []
  store.genres = []
  store.source = ''
  store.novelStatus = ''
  store.filename = ''
  store.trackerRow = null
  store.trackerSourceUrl = ''
  store.parserName = ''
  store.chapters = []
  chapterSearch.value = ''
  trackerVisible.value = false
}

function useTrackerNovel(novel: TrackerNovel): void {
  const sourceUrl = trackerSources.value[novel.stableId] ?? ''
  const source = novel.sources.find((candidate) => candidate.url === sourceUrl)
  if (source && !source.valid) {
    store.error = 'This tracker row has an invalid URL. Enter a valid URL manually.'
    return
  }

  store.queueItemId = ''
  separateJob.value = false
  store.sourceUrl = ''
  store.chapters = []
  store.parserName = ''
  store.filename = ''
  store.title = novel.siteTitle || novel.title
  store.author = novel.author
  store.url = sourceUrl
  store.trackerRow = {
    stableId: novel.stableId,
    rowNumber: novel.rowNumber,
    title: novel.title,
    csvPath: trackerCsvPath.value
  }
  store.trackerSourceUrl = sourceUrl
  store.error = sourceUrl ? '' : 'This tracker row has no source URL. Enter a URL manually.'
  store.success = ''
  trackerVisible.value = false
}

function openQueueItem(item: DiscoveryQueueItem): void {
  chapterSearch.value = ''
  store.queueItemId = ''
  store.url = item.sourceUrl
  store.sourceUrl = item.sourceUrl
  store.title = item.title
  store.author = item.author
  store.description = item.description
  store.coverUrl = item.coverUrl
  store.alternativeNames = [...item.alternativeNames]
  store.genres = [...item.genres]
  store.source = item.source
  store.novelStatus = item.novelStatus
  store.parserName = item.parserName
  store.chapters = item.chapters.map((chapter) => ({ ...chapter }))
  store.queueItemId = item.id
  separateJob.value = item.separateJob ?? false
  store.filename = ''
  store.trackerRow = item.trackerRow ? { ...item.trackerRow } : null
  store.trackerSourceUrl = item.trackerRow ? item.sourceUrl : ''
  store.error = ''
  store.success = ''
  activeView.value = 'create'
}

async function persistQueueSelection(
  id = store.queueItemId,
  selectedUrls = store.chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.url)
): Promise<boolean> {
  if (!id || id !== store.queueItemId) return true
  try {
    const result = await window.novelTracker.updateDiscoveryQueueSelection(id, selectedUrls)
    if (!result.ok) throw new Error(result.error)
    return true
  } catch (reason) {
    store.error = reason instanceof Error ? reason.message : String(reason)
    return false
  }
}

let queueSelectionTimer: ReturnType<typeof setTimeout> | undefined
watch(chapters, (updatedChapters) => {
  const id = store.queueItemId
  if (!id) return
  const selectedUrls = updatedChapters.filter((chapter) => chapter.selected).map((chapter) => chapter.url)
  if (queueSelectionTimer) clearTimeout(queueSelectionTimer)
  queueSelectionTimer = setTimeout(() => {
    queueSelectionTimer = undefined
    if (store.queueItemId !== id || activeView.value !== 'create') return
    void persistQueueSelection(id, selectedUrls)
  }, QUEUE_SELECTION_SAVE_DEBOUNCE_MS)
}, { deep: true })

async function createEpub(): Promise<void> {
  store.error = ''
  store.success = ''
  if (queueSelectionTimer) {
    clearTimeout(queueSelectionTimer)
    queueSelectionTimer = undefined
  }
  if (!(await persistQueueSelection())) return
  store.busy = true
  const queuedTitle = store.title
  try {
    const result = await window.novelTracker.enqueueEpub({
      title: store.title,
      author: store.author,
      description: store.description,
      coverUrl: store.coverUrl,
      alternativeNames: [...store.alternativeNames],
      genres: [...store.genres],
      source: store.source,
      novelStatus: store.novelStatus,
      language: store.language,
      filename: store.filename.trim() || filenamePreview.value,
      sourceUrl: store.sourceUrl,
      outputDirectory: store.outputDirectory,
      chapters: store.chapters
        .filter((chapter) => chapter.selected)
        .map(({ id, title, url }) => ({ id, title, url })),
      trackerRow: store.trackerRow ? { ...store.trackerRow } : undefined
    }, store.queueItemId || undefined)
    if (!result.ok) {
      store.error = result.error
      return
    }
    resetDiscoveryForm()
    store.success = `EPUB job queued for ${queuedTitle}. Track progress and controls in the Queue.`
    activeView.value = 'queue'
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      downloadHistory.value = await window.novelTracker.getDownloadHistory()
    } catch (error) {
      if (!store.error) store.error = error instanceof Error ? error.message : String(error)
    }
    store.busy = false
  }
}

async function convertHistoryEpub(job: DownloadHistoryEntry): Promise<void> {
  if (job.status !== 'completed' || !job.outputPath.toLocaleLowerCase().endsWith('.epub')) return
  store.error = ''
  store.success = ''
  convertingHistoryId.value = job.id
  try {
    const result = await window.novelTracker.convertEpubToAzw3(job.outputPath)
    if (!result.ok) {
      if (!('cancelled' in result)) store.error = result.error
      return
    }
    store.success = `Created ${result.value.outputPath} (${(result.value.outputBytes / 1024 / 1024).toFixed(1)} MB). AZW3 conversion does not guarantee Send-to-Kindle acceptance.`
  } catch (reason) {
    store.error = reason instanceof Error ? reason.message : String(reason)
  } finally {
    convertingHistoryId.value = ''
  }
}

function toggleAll(selected: boolean): void {
  for (const chapter of store.chapters) chapter.selected = selected
}

function selectBoundaryChapter(boundary: 'first' | 'last'): void {
  const selectedIndex = boundary === 'first' ? 0 : store.chapters.length - 1
  for (const [index, chapter] of store.chapters.entries()) {
    chapter.selected = index === selectedIndex
  }
}
</script>

<template>
  <div class="app-frame">
  <main class="shell" :inert="libraryScanning">
    <header class="topbar">
      <div class="brand-mark" aria-hidden="true">N</div>
      <div>
        <p class="eyebrow">NOVEL TRACKER</p>
        <h1>EPUB Builder</h1>
      </div>
      <nav class="main-navigation" aria-label="Main navigation">
        <button :class="{ active: activeView === 'create' }" @click="openCreateView">Prepare EPUB</button>
        <button :class="{ active: activeView === 'queue' }" @click="activeView = 'queue'">Queue</button>
        <button :class="{ active: activeView === 'library' }" @click="activeView = 'library'">Library</button>
        <button :class="{ active: activeView === 'configuration' }" @click="activeView = 'configuration'">Configuration</button>
      </nav>
    </header>

    <section
      v-if="activeView === 'library' && libraryOperations.length"
      class="card operation-history-card"
      aria-label="Library operation history"
      aria-live="polite"
    >
      <div class="section-heading">
        <div>
          <p class="step-label">MERGES AND CONVERSIONS</p>
          <h3>Library activity</h3>
        </div>
        <span>{{ libraryOperations.filter((operation) => operation.status === 'running').length }} active</span>
      </div>
      <div
        v-for="operation in libraryOperations.slice(0, 6)"
        :key="operation.id"
        class="operation-history-row"
      >
        <div class="operation-history-summary">
          <strong>{{ libraryOperationLabel(operation) }}</strong>
          <span>{{ operation.inputFiles.map((path) => path.split(/[\\/]/).pop()).join(', ') }}</span>
          <span>{{ operation.message }}</span>
          <span>{{ new Date(operation.updatedAt).toLocaleString() }}</span>
          <span v-if="operation.outputPath && operation.status === 'completed'">
            Output: {{ operation.outputPath }}
          </span>
          <details v-if="operation.error" class="operation-history-error">
            <summary>{{ operation.error.split(/\r?\n/, 1)[0] }}</summary>
            <pre>{{ operation.error }}</pre>
          </details>
        </div>
        <span class="history-status" :class="`status-${operation.status}`">{{ operation.status }}</span>
        <ProgressBar
          v-if="operation.status === 'running' && operation.progress !== null"
          :value="operation.progress"
          :show-value="false"
          class="operation-history-progress"
        />
        <ProgressBar
          v-else-if="operation.status === 'running'"
          mode="indeterminate"
          :show-value="false"
          class="operation-history-progress"
        />
      </div>
      <details v-if="libraryOperations.length > 6" class="operation-history-older">
        <summary>Show {{ libraryOperations.length - 6 }} older operations</summary>
        <div
          v-for="operation in libraryOperations.slice(6)"
          :key="operation.id"
          class="operation-history-row"
        >
          <div class="operation-history-summary">
            <strong>{{ libraryOperationLabel(operation) }}</strong>
            <span>{{ operation.inputFiles.map((path) => path.split(/[\\/]/).pop()).join(', ') }}</span>
            <span>{{ operation.message }} · {{ new Date(operation.updatedAt).toLocaleString() }}</span>
            <span v-if="operation.outputPath && operation.status === 'completed'">
              Output: {{ operation.outputPath }}
            </span>
            <details v-if="operation.error" class="operation-history-error">
              <summary>{{ operation.error.split(/\r?\n/, 1)[0] }}</summary>
              <pre>{{ operation.error }}</pre>
            </details>
          </div>
          <span class="history-status" :class="`status-${operation.status}`">{{ operation.status }}</span>
        </div>
      </details>
    </section>

    <template v-if="activeView === 'create'">
    <section class="intro">
      <p class="eyebrow">FROM WEBSITE TO EPUB</p>
      <h2>Prepare a personal EPUB from a novel URL</h2>
      <p>Review the book details and chapter order, then add the job to the queue.</p>
    </section>

    <section class="card source-card" aria-labelledby="source-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">STEP 1</p>
          <h3 id="source-heading">Find chapters</h3>
        </div>
      </div>
      <label class="field-label" for="source-url">Novel page or direct chapter URL</label>
      <div class="url-row">
        <InputText
          id="source-url"
          v-model="url"
          class="url-input"
          :disabled="busy || browserBusy"
          placeholder="https://example.com/novel"
          autocomplete="url"
          @keydown.enter="discover"
        />
        <Button label="Discover chapters" icon="pi pi-search" :loading="busy" :disabled="busy || !url.trim()" @click="discover" />
      </div>
      <div class="browser-assist-actions">
        <Button
          label="Open verification browser"
          icon="pi pi-external-link"
          severity="secondary"
          outlined
          :loading="browserBusy && !busy"
          :disabled="busy || browserBusy || !url.trim()"
          @click="openBrowserForVerification"
        />
        <Button
          :label="browserAssistOpen && browserAssistUrl === url.trim() ? 'Discover using browser' : 'Open browser for discovery'"
          icon="pi pi-globe"
          severity="secondary"
          outlined
          :loading="browserBusy && busy"
          :disabled="busy || browserBusy || !url.trim()"
          @click="discoverWithBrowser"
        />
        <Button
          v-if="browserDiscoveryRunning"
          label="Cancel browser discovery"
          icon="pi pi-times"
          severity="danger"
          text
          @click="cancelBrowserDiscovery"
        />
        <Button
          label="Clear browser session"
          icon="pi pi-trash"
          severity="secondary"
          text
          :disabled="busy || browserBusy"
          @click="clearBrowserData"
        />
      </div>
      <p class="help-text">
        Browser-assisted mode opens visible Chromium for manual sign-in, consent, or verification. If it is not already open for this URL, clicking the browser button opens it; complete verification yourself, then click again to discover. Site cookies stay in the browser and are not copied to the HTTP client.
        <template v-if="browserAssistOpen"> Browser ready<template v-if="browserPageTitle">: {{ browserPageTitle }}</template>.</template>
      </p>
      <div class="tracker-picker-toggle">
        <Button label="Browse tracker CSV" icon="pi pi-list" severity="secondary" text size="small" :disabled="busy" @click="openTrackerPicker" />
      </div>
      <div v-if="trackerVisible" class="tracker-picker">
        <div class="tracker-picker-heading">
          <div>
            <h4>Add from Tracker</h4>
            <p>Browsing is local and read-only. Network requests start only when you choose Discover chapters.</p>
          </div>
          <Button icon="pi pi-times" aria-label="Close tracker picker" severity="secondary" text rounded @click="trackerVisible = false" />
        </div>
        <InputText v-model="trackerSearch" class="full-input" placeholder="Search title, author, or alternate name" />
        <div v-if="trackerLoading" class="help-text">Reading the configured CSV…</div>
        <div v-else class="tracker-results">
          <div v-for="novel in filteredTrackerNovels" :key="novel.stableId" class="tracker-row">
            <div class="tracker-title">
              <strong>{{ novel.title }}</strong>
              <span>{{ novel.author || 'Author unknown' }}<template v-if="novel.siteTitle && novel.siteTitle !== novel.title"> · {{ novel.siteTitle }}</template></span>
            </div>
            <div class="tracker-source">
              <select v-if="novel.sources.length" v-model="trackerSources[novel.stableId]" aria-label="Select novel source">
                <option v-for="source in novel.sources" :key="source.label" :value="source.url" :disabled="!source.valid">
                  {{ source.label }}{{ source.valid ? '' : ' (invalid URL)' }}
                </option>
              </select>
              <span v-else class="help-text">No source URL</span>
              <Button
                :label="novel.sources.length ? 'Use' : 'Use details'"
                size="small"
                severity="secondary"
                outlined
                @click="useTrackerNovel(novel)"
              />
            </div>
          </div>
          <p v-if="!trackerLoading && filteredTrackerNovels.length === 0" class="empty-state">
            {{ trackerNovels.length ? 'No matching tracker rows.' : 'No tracker rows loaded. Configure a CSV in Configuration.' }}
          </p>
          <p v-if="trackerNovels.length > filteredTrackerNovels.length" class="help-text">
            Showing up to 100 matches. Refine the search to find other rows.
          </p>
        </div>
      </div>
      <p v-if="parserName.startsWith('NovelFull')" class="help-text">
        {{ parserName }} index pages are collected in reading order. Chapter text is fetched when the queued job runs.
      </p>
    </section>

    <template v-if="chapters.length > 0">
      <section class="card metadata-card" aria-labelledby="metadata-heading">
        <div class="section-heading">
          <div>
            <p class="step-label">STEP 2</p>
            <h3 id="metadata-heading">Review details</h3>
          </div>
          <span class="count-pill">{{ selectedCount }} of {{ chapters.length }} selected</span>
        </div>
        <div class="metadata-grid">
          <div>
            <label class="field-label" for="novel-title">Title</label>
            <InputText id="novel-title" v-model="title" class="full-input" maxlength="300" :disabled="busy" />
          </div>
          <div>
            <label class="field-label" for="novel-author">Author</label>
            <InputText id="novel-author" v-model="author" class="full-input" maxlength="300" placeholder="Optional" :disabled="busy" />
          </div>
          <div>
            <label class="field-label" for="novel-language">Language</label>
            <InputText id="novel-language" v-model="language" class="full-input" maxlength="20" placeholder="en" :disabled="busy" />
          </div>
        </div>

        <div class="chapter-toolbar">
          <div>
            <h4>Discovered chapters</h4>
            <p>{{ parserName }} · {{ chapters.length.toLocaleString() }} chapters · source order</p>
          </div>
          <div class="toolbar-actions">
            <Button label="First only" severity="secondary" text size="small" :disabled="busy || chapters.length === 0" @click="selectBoundaryChapter('first')" />
            <Button label="Last only" severity="secondary" text size="small" :disabled="busy || chapters.length === 0" @click="selectBoundaryChapter('last')" />
            <Button label="Select all" severity="secondary" text size="small" :disabled="busy" @click="toggleAll(true)" />
            <Button label="Clear" severity="secondary" text size="small" :disabled="busy" @click="toggleAll(false)" />
          </div>
        </div>
        <div class="chapter-filter-row">
          <InputText
            v-model="chapterSearch"
            class="full-input"
            placeholder="Filter chapters by title or URL"
            aria-label="Filter chapters by title or URL"
          />
          <span class="help-text">Showing {{ filteredChapters.length.toLocaleString() }} of {{ chapters.length.toLocaleString() }}</span>
        </div>
        <div class="chapter-list" role="group" aria-label="Select chapters to include">
          <label v-for="{ chapter, index } in filteredChapters" :key="chapter.id" class="chapter-row">
            <Checkbox v-model="chapter.selected" :binary="true" :input-id="`chapter-${index}`" :disabled="busy" />
            <span class="chapter-order">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="chapter-detail">
              <span class="chapter-title">{{ chapter.title }}</span>
              <span class="chapter-url">{{ chapter.url }}</span>
              <span v-if="chapter.archiveStatus" class="chapter-archive-status">
                {{ chapter.archiveStatus }} archive coverage
                <template v-if="chapter.chapterNumber !== null && chapter.chapterNumber !== undefined"> · chapter {{ chapter.chapterNumber }}</template>
                <template v-if="chapter.deliberateOverlap"> · included as overlap</template>
                <template v-if="chapter.archiveGap"> · unresolved earlier gap</template>
                <template v-if="chapter.archiveSources?.length"> · {{ chapter.archiveSources.join(', ') }}</template>
              </span>
              <span v-else-if="chapter.recommended === false" class="chapter-archive-status">Not recommended</span>
            </span>
          </label>
        </div>
      </section>

      <section class="card output-card" aria-labelledby="output-heading">
        <div class="section-heading">
          <div>
            <p class="step-label">STEP 3</p>
            <h3 id="output-heading">Queue EPUB</h3>
          </div>
        </div>
        <div class="filename-field">
          <label class="field-label" for="epub-filename">EPUB filename</label>
          <InputText
            id="epub-filename"
            v-model="filename"
            class="full-input"
            maxlength="255"
            :placeholder="filenamePreview"
            :disabled="busy"
          />
          <p class="help-text">
            {{ separateJob ? 'A unique name is suggested for this separate source job; existing files are still protected.' : 'Leave blank to use the suggested name.' }}
          </p>
        </div>
        <div class="output-row">
          <div class="folder-summary">
            <span class="folder-icon" aria-hidden="true">↳</span>
            <div>
              <span class="field-label">Default EPUB output folder</span>
              <span class="folder-path">{{ outputDirectory || 'Set a folder in Configuration' }}</span>
            </div>
          </div>
          <Button
            label="Configuration"
            icon="pi pi-cog"
            severity="secondary"
            outlined
            :disabled="busy"
            @click="activeView = 'configuration'"
          />
        </div>
        <div class="create-row">
          <p class="help-text">If an EPUB with this name already exists, it will be overwritten.</p>
          <Button
            label="Add to EPUB queue"
            icon="pi pi-book"
            :loading="busy"
            :disabled="busy || selectedCount === 0 || !title.trim() || !outputDirectory || !hasCurrentDiscovery"
            @click="createEpub"
          />
        </div>
      </section>
    </template>

    <section v-if="downloadHistory.length" class="card history-card" aria-label="Recent EPUB jobs">
      <div class="section-heading">
        <div>
          <p class="step-label">LOCAL JOB HISTORY</p>
          <h3>Recent EPUB jobs</h3>
        </div>
      </div>
      <div v-for="job in downloadHistory.slice(0, 8)" :key="job.id" class="history-row">
        <div class="history-summary">
          <strong>{{ job.title }}</strong>
          <span>{{ job.completedChapters }} / {{ job.selectedChapterCount }} chapters · {{ new Date(job.updatedAt).toLocaleString() }}</span>
        </div>
        <span class="history-status" :class="`status-${job.status}`">{{ job.status }}</span>
        <span v-if="job.error" class="history-error">{{ job.error }}</span>
        <span v-else-if="job.outputPath" class="history-error">{{ job.outputPath }}</span>
        <Button
          v-if="job.status === 'completed' && job.outputPath.toLocaleLowerCase().endsWith('.epub')"
          label="Convert to AZW3"
          icon="pi pi-file-export"
          severity="secondary"
          text
          size="small"
          :loading="convertingHistoryId === job.id"
          :disabled="Boolean(convertingHistoryId)"
          @click="convertHistoryEpub(job)"
        />
      </div>
    </section>

    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="success" severity="success" :closable="false" class="feedback">{{ success }}</Message>
    </template>
    <QueueView v-else-if="activeView === 'queue'" @open-item="openQueueItem" />
    <LibraryView v-else-if="activeView === 'library'" @open-configuration="activeView = 'configuration'" />
    <ConfigurationView v-else @theme-changed="applyAppTheme" />
  </main>
  <div
    v-if="libraryScanning"
    class="scan-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="scan-dialog-title"
    aria-live="polite"
  >
    <section class="scan-dialog">
      <span class="scan-spinner" aria-hidden="true"></span>
      <p class="eyebrow">LIBRARY INDEX</p>
      <h2 id="scan-dialog-title">Indexing your library</h2>
      <p class="scan-message">
        {{ libraryCancelling ? 'Cancelling scan…' : libraryProgress?.message ?? 'Preparing the scan…' }}
      </p>
      <ProgressBar
        v-if="!libraryProgress || libraryProgress.stage === 'scan'"
        mode="indeterminate"
        :show-value="false"
      />
      <ProgressBar v-else :value="libraryScanProgressValue" :show-value="false" />
      <p class="scan-count">{{ libraryScanCountLabel }}</p>
      <Message v-if="libraryCancelError" severity="error" :closable="false">
        {{ libraryCancelError }}
      </Message>
      <Button
        :label="libraryProgress?.stage === 'save' ? 'Saving index…' : 'Cancel scan'"
        severity="secondary"
        outlined
        :disabled="libraryCancelling || libraryProgress?.stage === 'save'"
        @click="cancelLibraryScan"
      />
      <p class="help-text">The app is locked while the index is updated. Keep this window open.</p>
    </section>
  </div>
  </div>
</template>
