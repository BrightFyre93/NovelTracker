<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import type { AppSettings, LibraryFileRecord, LibraryIndex, LibraryProgress } from '../../../shared/contracts'
import { DEFAULT_EPUB_CSS, MAX_EPUB_CSS_LENGTH } from '../../../shared/defaultEpubCss'
import { analyzeLibraryCoverage } from '../../../shared/libraryCoverage'
import { useLibraryStore } from '../stores/library'

const libraryState = useLibraryStore()
const settings = ref<AppSettings>({
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: '',
  maxSimultaneousDownloads: 2,
  epubCss: DEFAULT_EPUB_CSS
})
const epubCssDraft = ref(DEFAULT_EPUB_CSS)
const savingEpubCss = ref(false)
const epubCssDirty = computed(() => epubCssDraft.value !== settings.value.epubCss)
const index = ref<LibraryIndex | null>(null)
const search = ref('')
const selectedNovel = ref('')
const selectedFileId = ref('')
const includePdfs = ref(false)
const correctedTitle = ref('')
const correctedCoverage = ref('')
const busy = computed(() => libraryState.scanning)
const error = ref('')
const success = ref('')
const visibleFileLimit = 100

const visibleLibraryFiles = computed(() =>
  (index.value?.files ?? []).filter((file) => includePdfs.value || file.format !== 'PDF')
)

const novelSummaries = computed(() => {
  const grouped = new Map<string, { key: string; title: string; files: LibraryFileRecord[] }>()
  for (const file of visibleLibraryFiles.value) {
    const key = file.novelTitle.trim().toLocaleLowerCase()
    const group = grouped.get(key) ?? { key, title: file.novelTitle, files: [] }
    group.files.push(file)
    grouped.set(key, group)
  }
  const query = search.value.trim().toLocaleLowerCase()
  return [...grouped.values()]
    .map((group) => {
      const stateCounts = {
        Completed: group.files.filter((file) => file.folderState === 'Completed').length,
        Downloaded: group.files.filter((file) => file.folderState === 'Downloaded').length,
        Sent: group.files.filter((file) => file.folderState === 'Sent').length,
        Old: group.files.filter((file) => file.folderState === 'Old').length
      }
      const coverage = analyzeLibraryCoverage(group.files, includePdfs.value)
      return {
        ...group,
        stateCounts,
        coverage
      }
    })
    .filter((group) =>
      !query ||
      group.title.toLocaleLowerCase().includes(query) ||
      group.files.some((file) => file.filename.toLocaleLowerCase().includes(query))
    )
    .sort((left, right) => left.title.localeCompare(right.title))
})

const selectedGroup = computed(() => novelSummaries.value.find((group) => group.key === selectedNovel.value))
const filteredFiles = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const allFiles = selectedGroup.value?.files ?? []
  if (selectedGroup.value?.title.toLocaleLowerCase().includes(query)) return allFiles.slice(0, visibleFileLimit)
  return allFiles
    .filter((file) => !query || `${file.filename} ${file.relativePath}`.toLocaleLowerCase().includes(query))
    .slice(0, visibleFileLimit)
})
const selectedFile = computed(() =>
  selectedGroup.value?.files.find((file) => file.id === selectedFileId.value) ?? null
)
const selectedCoverageWarnings = computed(() => selectedGroup.value?.coverage.warnings ?? [])
const formatCounts = computed(() => ({
  epubs: (index.value?.files ?? []).filter((file) => file.format === 'EPUB').length,
  pdfs: (index.value?.files ?? []).filter((file) => file.format === 'PDF').length
}))

let removeProgressListener: (() => void) | undefined

onMounted(async () => {
  removeProgressListener = window.novelTracker.onLibraryProgress((value) => {
    libraryState.progress = value
  })
  try {
    settings.value = await window.novelTracker.getSettings()
    epubCssDraft.value = settings.value.epubCss
    const savedIndex = await window.novelTracker.getLibraryIndex()
    index.value = savedIndex && (!settings.value.libraryRoot || savedIndex.libraryRoot === settings.value.libraryRoot)
      ? savedIndex
      : null
    if (index.value) {
      settings.value.libraryRoot ||= index.value.libraryRoot
      selectFirstNovel()
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
})

onUnmounted(() => removeProgressListener?.())

function selectFirstNovel(): void {
  if (!selectedNovel.value && novelSummaries.value.length > 0) {
    selectedNovel.value = novelSummaries.value[0].key
  }
}

async function chooseLibraryRoot(): Promise<void> {
  error.value = ''
  try {
    const directory = await window.novelTracker.chooseLibraryRoot()
    if (directory) {
      const previousRoot = settings.value.libraryRoot
      settings.value = await window.novelTracker.getSettings()
      if (directory !== previousRoot) {
        index.value = null
        selectedNovel.value = ''
        selectedFileId.value = ''
      }
      success.value = 'Library root saved.'
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function chooseTrackerCsv(): Promise<void> {
  error.value = ''
  try {
    const path = await window.novelTracker.chooseTrackerCsv()
    if (path) {
      settings.value = await window.novelTracker.getSettings()
      success.value = 'Tracker CSV saved. It will only be read by the app.'
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function chooseOutputDirectory(): Promise<void> {
  error.value = ''
  try {
    const directory = await window.novelTracker.chooseOutputDirectory()
    if (directory) settings.value = await window.novelTracker.getSettings()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function saveEpubCss(css = epubCssDraft.value): Promise<void> {
  error.value = ''
  success.value = ''
  savingEpubCss.value = true
  try {
    const result = await window.novelTracker.updateEpubCss(css)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    epubCssDraft.value = result.value.epubCss
    success.value = 'EPUB stylesheet saved. Existing queued jobs keep their saved stylesheet.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingEpubCss.value = false
  }
}

async function resetEpubCss(): Promise<void> {
  epubCssDraft.value = DEFAULT_EPUB_CSS
  await saveEpubCss(DEFAULT_EPUB_CSS)
}

async function scan(): Promise<void> {
  error.value = ''
  success.value = ''
  libraryState.progress = null
  libraryState.cancelError = ''
  libraryState.cancelling = false
  libraryState.scanning = true
  try {
    const result = await window.novelTracker.scanLibrary()
    if (!result.ok) {
      error.value = result.error
      return
    }
    index.value = result.value
    selectedNovel.value = ''
    selectedFileId.value = ''
    selectFirstNovel()
    success.value = `Indexed ${result.value.files.length.toLocaleString()} files. ${
      result.value.scanErrors ? `${result.value.scanErrors.toLocaleString()} files need attention.` : ''
    }`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    libraryState.scanning = false
    libraryState.cancelling = false
    libraryState.progress = null
    libraryState.cancelError = ''
  }
}

async function openFile(file: LibraryFileRecord, reveal: boolean): Promise<void> {
  error.value = ''
  const result = await window.novelTracker.openLibraryPath(file.path, reveal)
  if (!result.ok) error.value = result.error
}

function selectFile(file: LibraryFileRecord): void {
  selectedFileId.value = file.id
  correctedTitle.value = file.novelTitle
  correctedCoverage.value = ''
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
    const result = await window.novelTracker.correctLibraryFile(selectedFile.value.id, {
      novelTitle: correctedTitle.value.trim() || undefined,
      chapterNumbers
    })
    if (!result.ok) {
      error.value = result.error
      return
    }
    index.value = result.value
    success.value = 'Library correction saved locally.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    <section class="card library-settings" aria-labelledby="library-settings-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">LOCAL SETTINGS</p>
          <h3 id="library-settings-heading">Library and tracker paths</h3>
        </div>
      </div>
      <div class="library-path-grid">
        <div class="library-path">
          <span class="field-label">Historical library root</span>
          <span class="library-path-value">{{ settings.libraryRoot || 'Not configured' }}</span>
          <Button label="Choose library" severity="secondary" outlined size="small" :disabled="busy" @click="chooseLibraryRoot" />
        </div>
        <div class="library-path">
          <span class="field-label">Novel tracker CSV · read-only</span>
          <span class="library-path-value">{{ settings.trackerCsvPath || 'Not configured' }}</span>
          <Button label="Choose CSV" severity="secondary" outlined size="small" :disabled="busy" @click="chooseTrackerCsv" />
        </div>
        <div class="library-path">
          <span class="field-label">EPUB output folder</span>
          <span class="library-path-value">{{ settings.outputDirectory || 'Not configured' }}</span>
          <Button label="Choose output" severity="secondary" outlined size="small" :disabled="busy" @click="chooseOutputDirectory" />
        </div>
      </div>
      <details class="epub-css-settings">
        <summary>EPUB stylesheet</summary>
        <p class="help-text">Applies to new EPUB jobs. Existing queued jobs keep their saved stylesheet.</p>
        <textarea
          v-model="epubCssDraft"
          class="epub-css-editor"
          aria-label="EPUB stylesheet CSS"
          spellcheck="false"
          :maxlength="MAX_EPUB_CSS_LENGTH"
          :disabled="savingEpubCss"
        />
        <div class="epub-css-actions">
          <span>{{ epubCssDraft.length.toLocaleString() }} / {{ MAX_EPUB_CSS_LENGTH.toLocaleString() }} characters</span>
          <div>
            <Button
              label="Reset to default"
              severity="secondary"
              outlined
              size="small"
              :disabled="savingEpubCss || (epubCssDraft === DEFAULT_EPUB_CSS && settings.epubCss === DEFAULT_EPUB_CSS)"
              @click="resetEpubCss"
            />
            <Button
              label="Save stylesheet"
              size="small"
              :loading="savingEpubCss"
              :disabled="savingEpubCss || !epubCssDirty"
              @click="saveEpubCss()"
            />
          </div>
        </div>
      </details>
    </section>

    <section class="card" aria-labelledby="library-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">HISTORICAL ARCHIVE</p>
          <h3 id="library-heading">Library index</h3>
        </div>
        <div class="library-actions">
          <Button label="Scan / rescan" icon="pi pi-refresh" :disabled="busy || !settings.libraryRoot" @click="scan" />
        </div>
      </div>
      <p class="help-text library-note">
        Scans are read-only. EPUBs are inspected for metadata and chapter lists; PDFs are indexed from their content or chapter filenames.
      </p>
      <div v-if="index" class="library-summary">
        <div><strong>{{ novelSummaries.length.toLocaleString() }}</strong><span>visible novels</span></div>
        <div><strong>{{ visibleLibraryFiles.length.toLocaleString() }}</strong><span>shown files</span></div>
        <div><strong>{{ formatCounts.epubs.toLocaleString() }}</strong><span>EPUBs</span></div>
        <div><strong>{{ formatCounts.pdfs.toLocaleString() }}</strong><span>PDFs indexed</span></div>
        <small>Last scan {{ new Date(index.scannedAt).toLocaleString() }} · {{ index.scanErrors.toLocaleString() }} issues</small>
      </div>
      <Message v-if="!index && !busy" severity="info" :closable="false" class="feedback">
        Choose your library folder, then scan it. The scan will not move or modify files.
      </Message>
    </section>

    <div v-if="index" class="library-browser">
      <section class="card library-novels" aria-label="Indexed novels">
        <div class="library-list-heading">
          <h3>Novels</h3>
          <InputText v-model="search" class="library-search" placeholder="Search title or file" />
        </div>
        <label class="legacy-pdf-toggle">
          <input v-model="includePdfs" type="checkbox" />
          Include legacy PDFs in this list and its warnings ({{ formatCounts.pdfs.toLocaleString() }})
        </label>
        <div class="novel-list">
          <button
            v-for="novel in novelSummaries"
            :key="novel.key"
            class="novel-choice"
            :class="{ active: selectedNovel === novel.key }"
            @click="selectedNovel = novel.key; selectedFileId = ''"
          >
            <span class="novel-choice-title">{{ novel.title }}</span>
            <span class="novel-choice-count">
              {{ novel.files.length }} files
              <template v-if="novel.stateCounts.Completed"> · Completed {{ novel.stateCounts.Completed }}</template>
              <template v-if="novel.stateCounts.Sent"> · Sent {{ novel.stateCounts.Sent }}</template>
              <template v-if="novel.stateCounts.Downloaded"> · Downloaded {{ novel.stateCounts.Downloaded }}</template>
              <template v-if="novel.stateCounts.Old"> · Old {{ novel.stateCounts.Old }}</template>
            </span>
            <span
              v-if="novel.coverage.overlapNumberCount || novel.coverage.gapCount || novel.coverage.unverifiedCount || novel.coverage.rangeMismatchCount"
              class="novel-coverage-summary"
            >
              <template v-if="novel.coverage.gapCount">{{ novel.coverage.gapCount }} possible gaps</template>
              <template v-if="novel.coverage.overlapNumberCount">
                <template v-if="novel.coverage.gapCount"> · </template>
                {{ novel.coverage.overlapNumberCount }} duplicate chapter numbers
              </template>
              <template v-if="novel.coverage.unverifiedCount">
                <template v-if="novel.coverage.gapCount || novel.coverage.overlapNumberCount"> · </template>
                {{ novel.coverage.unverifiedCount }} files need review
              </template>
              <template v-if="novel.coverage.rangeMismatchCount">
                <template v-if="novel.coverage.gapCount || novel.coverage.overlapNumberCount || novel.coverage.unverifiedCount"> · </template>
                {{ novel.coverage.rangeMismatchCount }} range mismatch{{ novel.coverage.rangeMismatchCount === 1 ? '' : 'es' }}
              </template>
            </span>
          </button>
          <p v-if="novelSummaries.length === 0" class="empty-state">No matching novels.</p>
        </div>
      </section>

      <section class="card library-files" aria-label="Files and coverage">
        <div class="library-list-heading">
          <div>
            <h3>{{ selectedGroup?.title || 'Source files' }}</h3>
            <p v-if="selectedGroup" class="chapter-toolbar-note">{{ selectedGroup.files.length.toLocaleString() }} indexed files</p>
          </div>
        </div>
        <div v-if="selectedGroup" class="library-file-list">
          <button
            v-for="file in filteredFiles"
            :key="file.id"
            class="library-file-row"
            :class="{ active: selectedFileId === file.id }"
            @click="selectFile(file)"
          >
            <span class="library-file-name">{{ file.filename }}</span>
            <span class="library-file-meta">{{ file.folderState }} · {{ file.format }} · {{ coverageLabel(file) }}</span>
          </button>
          <p v-if="selectedGroup.files.length > visibleFileLimit" class="empty-state">
            Showing first {{ visibleFileLimit }} files. Search by filename to narrow the list.
          </p>
        </div>
        <p v-else class="empty-state">Choose a novel to inspect its files.</p>

        <details
          v-if="selectedGroup && (selectedCoverageWarnings.length || selectedGroup.coverage.filenameEvidenceCount)"
          class="coverage-warning-panel"
        >
          <summary>Coverage warnings ({{ selectedCoverageWarnings.length }})</summary>
          <p class="coverage-warning-note">
            Gaps mean no chapter evidence was found between the neighboring numbers shown; they are not proof that a source chapter is missing. Beginning and ending gaps need a known source chapter list.
          </p>
          <p v-if="selectedGroup.coverage.filenameEvidenceCount" class="coverage-warning-note">
            {{ selectedGroup.coverage.filenameEvidenceCount.toLocaleString() }} individual PDF chapter number(s) come from filenames, not file contents. They are used as lower-confidence evidence because the PDF list is visible.
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
              <template v-else-if="warning.kind === 'overlap'">
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
                <p>These out-of-range numbers are excluded from gap and overlap calculations. Check whether this file includes unrelated TOC entries or has a misleading filename.</p>
                <button class="warning-file-link" @click="selectFile(warning.file)">{{ warning.file.relativePath }}</button>
              </template>
            </li>
          </ul>
          <p v-else class="empty-state">No extracted-coverage warnings. Filename-only evidence is listed above for context.</p>
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
            </div>
          </div>
          <p class="file-evidence">
            {{ (selectedFile.size / 1024 / 1024).toFixed(1) }} MB
            <span v-if="selectedFile.pageCount"> · {{ selectedFile.pageCount }} pages</span>
            · {{ coverageLabel(selectedFile) }} · {{ selectedFile.coverageConfidence }} evidence
            <span v-if="selectedFile.pdfClassification"> · {{ selectedFile.pdfClassification }}</span>
          </p>
          <p v-if="selectedFile.chapterTitles.length" class="file-evidence">
            {{ selectedFile.chapterTitles.slice(0, 5).join(' · ') }}<span v-if="selectedFile.chapterTitles.length > 5"> …</span>
          </p>
          <Message v-if="selectedFile.inspectionError" severity="warn" :closable="false">
            {{ selectedFile.inspectionError }}
          </Message>
          <div class="correction-grid">
            <div>
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
