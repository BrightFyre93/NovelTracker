<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type {
  EpubMergeProgress,
  LibraryFileRecord,
  LibraryIndexSummary
} from '../../../shared/contracts'
import { analyzeLibraryCoverage } from '../../../shared/libraryCoverage'
import { useLibraryStore } from '../stores/library'

const emit = defineEmits<{
  openConfiguration: []
}>()

const libraryState = useLibraryStore()
const libraryRoot = ref('')
const outputDirectory = ref('')
const index = shallowRef<LibraryIndexSummary | null>(null)
const backupDate = ref<string | null>(null)
const selectedFiles = shallowRef<LibraryFileRecord[]>([])
const search = ref('')
const multipleFilesOnly = ref(false)
const selectedNovel = ref('')
const selectedFileId = ref('')
const restoringBackup = ref(false)
const merging = ref(false)
const converting = ref(false)
const repairing = ref(false)
const mergeProgress = ref<EpubMergeProgress | null>(null)
const mergeFileIds = ref<string[]>([])
const mergeFilename = ref('')
const latestMergedPath = ref('')
const correctedTitle = ref('')
const correctedCoverage = ref('')
const busy = computed(() =>
  libraryState.scanning || restoringBackup.value || merging.value || converting.value || repairing.value
)
const error = ref('')
const success = ref('')
const visibleFileLimit = 100
const loadingNovelFiles = ref(false)

const novelSummaries = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return (index.value?.novels ?? [])
    .filter((group) =>
      (!multipleFilesOnly.value || group.files.length > 1) &&
      (
        !query ||
        group.title.toLocaleLowerCase().includes(query) ||
        group.files.some((file) => file.filename.toLocaleLowerCase().includes(query))
      )
    )
})

const selectedGroup = computed(() => novelSummaries.value.find((group) => group.key === selectedNovel.value))
const filteredFiles = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  const allFiles = selectedFiles.value
  if (selectedGroup.value?.title.toLocaleLowerCase().includes(query)) return allFiles.slice(0, visibleFileLimit)
  return allFiles
    .filter((file) => !query || `${file.filename} ${file.relativePath}`.toLocaleLowerCase().includes(query))
    .slice(0, visibleFileLimit)
})
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

watch(novelSummaries, (summaries) => {
  if (selectedNovel.value && !summaries.some((group) => group.key === selectedNovel.value)) {
    selectedNovel.value = ''
    selectedFileId.value = ''
    selectedFiles.value = []
    mergeFileIds.value = []
    mergeFilename.value = ''
    latestMergedPath.value = ''
    loadingNovelFiles.value = false
  }
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
  try {
    const savedIndex = await window.novelTracker.getLibraryIndexSummary()
    index.value = savedIndex && (!configuredRoot || savedIndex.libraryRoot === configuredRoot)
      ? savedIndex
      : null
    if (index.value) {
      if (!libraryRoot.value) libraryRoot.value = index.value.libraryRoot
      selectFirstNovel()
    }
  } catch (reason) {
    if (!error.value) error.value = reason instanceof Error ? reason.message : String(reason)
  }
  try {
    backupDate.value = await window.novelTracker.getLibraryIndexBackupDate()
  } catch (reason) {
    if (!error.value) error.value = reason instanceof Error ? reason.message : String(reason)
  }
})

onUnmounted(() => {
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
  const firstNovel = novelSummaries.value[0]
  if (!selectedNovel.value && firstNovel) void selectNovel(firstNovel.key)
  else if (!firstNovel) {
    selectedFiles.value = []
    selectedFileId.value = ''
    loadingNovelFiles.value = false
  }
}

async function selectNovel(key: string): Promise<void> {
  selectedNovel.value = key
  selectedFileId.value = ''
  selectedFiles.value = []
  mergeFileIds.value = []
  mergeFilename.value = ''
  latestMergedPath.value = ''
  loadingNovelFiles.value = true
  try {
    const result = await window.novelTracker.getLibraryNovelFiles(key)
    if (!result.ok) {
      error.value = result.error
      return
    }
    if (selectedNovel.value === key) selectedFiles.value = result.value
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (selectedNovel.value === key) loadingNovelFiles.value = false
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
    selectedNovel.value = ''
    selectedFileId.value = ''
    mergeFileIds.value = []
    mergeFilename.value = ''
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    selectedNovel.value = ''
    selectedFileId.value = ''
    mergeFileIds.value = []
    mergeFilename.value = ''
    selectFirstNovel()
    backupDate.value = await window.novelTracker.getLibraryIndexBackupDate()
    success.value = 'Library index backup restored.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    restoringBackup.value = false
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
  latestMergedPath.value = ''
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
    const overlap = result.value.duplicateChapterCount
      ? ` Removed ${result.value.duplicateChapterCount.toLocaleString()} overlapping chapter(s); the earlier-range copy was kept.`
      : ''
    const conflicts = result.value.conflictingChapterCount
      ? ` ${result.value.conflictingChapterCount.toLocaleString()} overlap(s) had different text; the earlier-range copy was kept.`
      : ''
    success.value = `Created ${result.value.chapterCount.toLocaleString()} chapters at ${result.value.outputPath}.${overlap}${conflicts}`
    latestMergedPath.value = result.value.outputPath
    mergeFileIds.value = []
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    mergeProgress.value = {
      stage: 'failed',
      percentage: mergeProgress.value?.percentage ?? 0,
      message: 'Merge stopped before completion.'
    }
  } finally {
    merging.value = false
  }
}

async function convertEpubToAzw3(inputPath: string): Promise<void> {
  error.value = ''
  success.value = ''
  converting.value = true
  try {
    const result = await window.novelTracker.convertEpubToAzw3(inputPath)
    if (!result.ok) {
      if (!('cancelled' in result)) error.value = result.error
      return
    }
    success.value = `Created ${result.value.outputPath} (${(result.value.outputBytes / 1024 / 1024).toFixed(1)} MB). AZW3 conversion does not guarantee Send-to-Kindle acceptance.`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    converting.value = false
  }
}

async function convertAzw3ToEpub(fileId: string): Promise<void> {
  error.value = ''
  success.value = ''
  converting.value = true
  try {
    const result = await window.novelTracker.convertAzw3ToEpub(fileId)
    if (!result.ok) {
      if (!('cancelled' in result)) error.value = result.error
      return
    }
    success.value = `Created ${result.value.outputPath} (${(result.value.outputBytes / 1024 / 1024).toFixed(1)} MB). Review the EPUB in Kindle Previewer before sending.`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    converting.value = false
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    index.value = result.value
    const correctedGroup = result.value.novels.find((group) =>
      group.files.some((file) => file.id === correctedFileId)
    )
    if (correctedGroup) await selectNovel(correctedGroup.key)
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
        <div><strong>{{ novelSummaries.length.toLocaleString() }}</strong><span>visible novels</span></div>
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
        <div class="novel-list">
          <button
            v-for="novel in novelSummaries"
            :key="novel.key"
            class="novel-choice"
            :class="{ active: selectedNovel === novel.key }"
            @click="selectNovel(novel.key)"
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
        <div v-if="selectedGroup && loadingNovelFiles" class="help-text">Loading this novel's chapter and coverage details…</div>
        <div v-else-if="selectedGroup" class="library-file-list">
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

        <section v-if="selectedGroup" class="library-merge-panel">
          <strong>Combine existing EPUBs offline</strong>
          <p class="help-text">
            Select at least two EPUBs. They are ordered by chapter range; overlapping chapter numbers are included once, preferring the lower-range file. No network requests are made.
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
          <div v-if="latestMergedPath" class="merge-filename-row">
            <Button
              label="Convert merged EPUB to AZW3"
              icon="pi pi-file-export"
              :loading="converting"
              :disabled="busy"
              @click="convertEpubToAzw3(latestMergedPath)"
            />
          </div>
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
                label="Convert to AZW3"
                icon="pi pi-file-export"
                severity="secondary"
                text
                size="small"
                :loading="converting"
                :disabled="busy"
                @click="convertEpubToAzw3(selectedFile.path)"
              />
              <Button
                v-if="selectedFile.format === 'AZW3'"
                label="Convert to EPUB"
                icon="pi pi-file-export"
                severity="secondary"
                text
                size="small"
                :loading="converting"
                :disabled="busy"
                @click="convertAzw3ToEpub(selectedFile.id)"
              />
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
