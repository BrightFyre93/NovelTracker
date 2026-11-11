<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type { DiscoveryQueueItem, DownloadHistoryEntry, JobProgress, TrackerNovel } from '../../shared/contracts'
import { suggestEpubFilename } from '../../shared/epubFilename'
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
const activeView = ref<'create' | 'queue' | 'library'>('create')
const trackerVisible = ref(false)
const trackerLoading = ref(false)
const trackerNovels = ref<TrackerNovel[]>([])
const trackerSearch = ref('')
const trackerSources = ref<Record<string, string>>({})
const trackerCsvPath = ref('')
const downloadHistory = ref<DownloadHistoryEntry[]>([])
const {
  url,
  title,
  author,
  language,
  filename,
  chapters,
  sourceUrl,
  parserName,
  outputDirectory,
  busy,
  creating,
  progress,
  error,
  success,
  selectedCount
} = storeToRefs(store)
const hasCurrentDiscovery = computed(() => Boolean(sourceUrl.value) && url.value.trim() === sourceUrl.value)
const filenamePreview = computed(() => {
  const selected = chapters.value.filter((chapter) => chapter.selected)
  if (selected.length === 0) return suggestEpubFilename(title.value, '', '')
  return suggestEpubFilename(title.value, selected[0].title, selected[selected.length - 1].title)
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
const progressValue = computed(() => {
  const currentProgress = progress.value
  return currentProgress && currentProgress.total > 0
    ? Math.round((currentProgress.current / currentProgress.total) * 100)
    : 0
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
  if (sourceUrl.value && value.trim() !== sourceUrl.value) {
    store.queueItemId = ''
    sourceUrl.value = ''
    chapters.value = []
    title.value = ''
    author.value = ''
    filename.value = ''
    parserName.value = ''
    store.success = ''
    store.progress = null
  }
  if (store.trackerRow && value.trim() !== store.trackerSourceUrl) {
    store.trackerRow = null
    store.trackerSourceUrl = ''
  }
})

let removeProgressListener: (() => void) | undefined

onMounted(() => {
  removeProgressListener = window.novelTracker.onProgress((progress: JobProgress) => store.setProgress(progress))
  void window.novelTracker.getSettings().then((settings) => {
    if (settings.outputDirectory) store.outputDirectory = settings.outputDirectory
    trackerCsvPath.value = settings.trackerCsvPath
  }).catch((error: unknown) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
  void window.novelTracker.getDownloadHistory().then((history) => {
    downloadHistory.value = history
  }).catch((error: unknown) => {
    store.error = error instanceof Error ? error.message : String(error)
  })
})

onUnmounted(() => removeProgressListener?.())

async function discover(): Promise<void> {
  store.error = ''
  store.success = ''
  store.progress = null
  store.busy = true
  try {
    const result = await window.novelTracker.discover(store.url)
    if (!result.ok) {
      store.error = result.error
      store.progress = null
      return
    }
    store.applyDiscovery(result.value)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    store.progress = null
  } finally {
    store.busy = false
  }
}

async function cancelEpubGeneration(): Promise<void> {
  try {
    await window.novelTracker.cancelEpubGeneration()
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
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

async function chooseOutputDirectory(): Promise<void> {
  store.error = ''
  try {
    const directory = await window.novelTracker.chooseOutputDirectory()
    if (directory) store.outputDirectory = directory
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
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
  activeView.value = 'create'
  try {
    const settings = await window.novelTracker.getSettings()
    if (settings.outputDirectory) store.outputDirectory = settings.outputDirectory
    trackerCsvPath.value = settings.trackerCsvPath
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

function useTrackerNovel(novel: TrackerNovel): void {
  const sourceUrl = trackerSources.value[novel.stableId] ?? ''
  const source = novel.sources.find((candidate) => candidate.url === sourceUrl)
  if (source && !source.valid) {
    store.error = 'This tracker row has an invalid URL. Enter a valid URL manually.'
    return
  }

  store.queueItemId = ''
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
  store.queueItemId = ''
  store.url = item.sourceUrl
  store.sourceUrl = item.sourceUrl
  store.title = item.title
  store.author = item.author
  store.parserName = item.parserName
  store.chapters = item.chapters.map((chapter) => ({ ...chapter }))
  store.queueItemId = item.id
  store.filename = ''
  store.trackerRow = item.trackerRow ? { ...item.trackerRow } : null
  store.trackerSourceUrl = item.trackerRow ? item.sourceUrl : ''
  store.progress = null
  store.error = ''
  store.success = ''
  activeView.value = 'create'
}

async function persistQueueSelection(
  id = store.queueItemId,
  selectedUrls = store.chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.url)
): Promise<boolean> {
  if (!id) return true
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
    void persistQueueSelection(id, selectedUrls)
  }, 250)
}, { deep: true })

async function createEpub(): Promise<void> {
  store.error = ''
  store.success = ''
  store.progress = null
  if (queueSelectionTimer) {
    clearTimeout(queueSelectionTimer)
    queueSelectionTimer = undefined
  }
  if (!(await persistQueueSelection())) return
  store.busy = true
  store.creating = true
  try {
    const result = await window.novelTracker.generateEpub({
      title: store.title,
      author: store.author,
      language: store.language,
      filename: store.filename.trim() || filenamePreview.value,
      sourceUrl: store.sourceUrl,
      outputDirectory: store.outputDirectory,
      chapters: store.chapters
        .filter((chapter) => chapter.selected)
        .map(({ id, title, url }) => ({ id, title, url })),
      trackerRow: store.trackerRow ?? undefined
    })
    if (!result.ok) {
      store.error = result.error
      return
    }
    const filename = result.value.outputPath.split(/[\\/]/).pop() ?? result.value.outputPath
    store.success = result.value.overwroteExistingFile
      ? `Saved ${filename}, overwriting the existing file.`
      : `Saved ${filename}.`
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      downloadHistory.value = await window.novelTracker.getDownloadHistory()
    } catch (error) {
      if (!store.error) store.error = error instanceof Error ? error.message : String(error)
    }
    store.creating = false
    store.busy = false
  }
}

function toggleAll(selected: boolean): void {
  for (const chapter of store.chapters) chapter.selected = selected
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
        <button :class="{ active: activeView === 'create' }" @click="openCreateView">Create EPUB</button>
        <button :class="{ active: activeView === 'queue' }" @click="activeView = 'queue'">Queue</button>
        <button :class="{ active: activeView === 'library' }" @click="activeView = 'library'">Library</button>
      </nav>
      <span class="phase-badge">Text-first EPUB</span>
    </header>

    <template v-if="activeView === 'create'">
    <section class="intro">
      <p class="eyebrow">FROM WEBSITE TO EPUB</p>
      <h2>Make a personal EPUB from a novel URL</h2>
      <p>Review the book details and chapter order before saving.</p>
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
          :disabled="busy"
          placeholder="https://example.com/novel"
          autocomplete="url"
          @keydown.enter="discover"
        />
        <Button label="Discover chapters" icon="pi pi-search" :loading="busy" :disabled="busy || !url.trim()" @click="discover" />
      </div>
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
            {{ trackerNovels.length ? 'No matching tracker rows.' : 'No tracker rows loaded. Configure a CSV in Library settings.' }}
          </p>
          <p v-if="trackerNovels.length > filteredTrackerNovels.length" class="help-text">
            Showing up to 100 matches. Refine the search to find other rows.
          </p>
        </div>
      </div>
      <p v-if="parserName === 'NovelFull'" class="help-text">
        {{ parserName }} index pages are collected in reading order. Chapter text is fetched when you create the EPUB.
      </p>
      <div v-if="progress && chapters.length === 0" class="progress-block" aria-live="polite">
        <div class="progress-caption">
          <span>{{ progress.message }}</span>
          <span>{{ progressValue }}%</span>
        </div>
        <ProgressBar :value="progressValue" :show-value="false" />
      </div>
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
            <Button label="Select all" severity="secondary" text size="small" :disabled="busy" @click="toggleAll(true)" />
            <Button label="Clear" severity="secondary" text size="small" :disabled="busy" @click="toggleAll(false)" />
          </div>
        </div>
        <div class="chapter-list" role="group" aria-label="Select chapters to include">
          <label v-for="(chapter, index) in chapters" :key="chapter.id" class="chapter-row">
            <Checkbox v-model="chapter.selected" :binary="true" :input-id="`chapter-${index}`" :disabled="busy" />
            <span class="chapter-order">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="chapter-detail">
              <span class="chapter-title">{{ chapter.title }}</span>
              <span class="chapter-url">{{ chapter.url }}</span>
            </span>
          </label>
        </div>
      </section>

      <section class="card output-card" aria-labelledby="output-heading">
        <div class="section-heading">
          <div>
            <p class="step-label">STEP 3</p>
            <h3 id="output-heading">Create EPUB</h3>
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
          <p class="help-text">Leave blank to use the suggested name.</p>
        </div>
        <div class="output-row">
          <div class="folder-summary">
            <span class="folder-icon" aria-hidden="true">↳</span>
            <div>
              <span class="field-label">Output folder</span>
              <span class="folder-path">{{ outputDirectory || 'Choose a folder on this device' }}</span>
            </div>
          </div>
          <Button label="Choose folder" icon="pi pi-folder-open" severity="secondary" outlined :disabled="busy" @click="chooseOutputDirectory" />
        </div>
        <div class="create-row">
          <p class="help-text">If an EPUB with this name already exists, it will be overwritten.</p>
          <Button
            v-if="!creating"
            label="Create EPUB"
            icon="pi pi-book"
            :loading="busy"
            :disabled="busy || selectedCount === 0 || !title.trim() || !outputDirectory || !hasCurrentDiscovery"
            @click="createEpub"
          />
          <Button v-else label="Cancel creation" severity="danger" outlined @click="cancelEpubGeneration" />
        </div>
        <div v-if="progress" class="progress-block" aria-live="polite">
          <div class="progress-caption">
            <span>{{ progress.message }}</span>
            <span>{{ progressValue }}%</span>
          </div>
          <ProgressBar :value="progressValue" :show-value="false" />
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
      </div>
    </section>

    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="success" severity="success" :closable="false" class="feedback">{{ success }}</Message>
    </template>
    <QueueView v-else-if="activeView === 'queue'" @open-item="openQueueItem" />
    <LibraryView v-else />
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
