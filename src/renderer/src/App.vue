<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type { JobProgress } from '../../shared/contracts'
import { suggestEpubFilename } from '../../shared/epubFilename'
import { useDownloadStore } from './stores/download'

const store = useDownloadStore()
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
const progressValue = computed(() => {
  const currentProgress = progress.value
  return currentProgress && currentProgress.total > 0
    ? Math.round((currentProgress.current / currentProgress.total) * 100)
    : 0
})

watch(url, (value) => {
  if (sourceUrl.value && value.trim() !== sourceUrl.value) {
    sourceUrl.value = ''
    chapters.value = []
    title.value = ''
    author.value = ''
    filename.value = ''
    parserName.value = ''
    store.success = ''
    store.progress = null
  }
})

let removeProgressListener: (() => void) | undefined

onMounted(() => {
  removeProgressListener = window.novelTracker.onProgress((progress: JobProgress) => store.setProgress(progress))
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

async function chooseOutputDirectory(): Promise<void> {
  store.error = ''
  try {
    const directory = await window.novelTracker.chooseOutputDirectory()
    if (directory) store.outputDirectory = directory
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}

async function createEpub(): Promise<void> {
  store.error = ''
  store.success = ''
  store.progress = null
  store.busy = true
  try {
    const result = await window.novelTracker.generateEpub({
      title: store.title,
      author: store.author,
      language: store.language,
      filename: store.filename.trim() || filenamePreview.value,
      outputDirectory: store.outputDirectory,
      chapters: store.chapters
        .filter((chapter) => chapter.selected)
        .map(({ id, title, url }) => ({ id, title, url }))
    })
    if (!result.ok) {
      store.error = result.error
      return
    }
    const filename = result.value.outputPath.split(/[\\/]/).pop() ?? result.value.outputPath
    store.success = result.value.createdNumberedCopy
      ? `Saved ${filename}. The original file was kept unchanged because it already existed.`
      : `Saved ${filename}.`
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  } finally {
    store.busy = false
  }
}

function toggleAll(selected: boolean): void {
  for (const chapter of store.chapters) chapter.selected = selected
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand-mark" aria-hidden="true">N</div>
      <div>
        <p class="eyebrow">NOVEL TRACKER</p>
        <h1>EPUB Builder</h1>
      </div>
      <span class="phase-badge">Text-first EPUB</span>
    </header>

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
          <p class="help-text">Existing files are kept; a numbered copy is saved if the name is already in use.</p>
          <Button
            label="Create EPUB"
            icon="pi pi-book"
            :loading="busy"
            :disabled="busy || selectedCount === 0 || !title.trim() || !outputDirectory || !hasCurrentDiscovery"
            @click="createEpub"
          />
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

    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="success" severity="success" :closable="false" class="feedback">{{ success }}</Message>
  </main>
</template>
