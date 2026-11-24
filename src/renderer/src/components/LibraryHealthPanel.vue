<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type { LibraryHealthIssue, LibraryHealthStatus } from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'
import ConfirmDialog from './ConfirmDialog.vue'

const ROWS_PER_PAGE = 50
const POLL_INTERVAL_MS = 700

const status = ref<LibraryHealthStatus | null>(null)
const selected = ref<Set<string>>(new Set())
const hideRepaired = ref(false)
const rowLimit = ref(ROWS_PER_PAGE)
const error = ref('')
const starting = ref(false)
const confirmRepair = ref<string[] | null>(null)

let pollTimer: ReturnType<typeof setInterval> | undefined

const running = computed(() => (status.value?.phase ?? 'idle') !== 'idle')
const issues = computed<LibraryHealthIssue[]>(() => status.value?.issues ?? [])
const visibleIssues = computed(() =>
  hideRepaired.value ? issues.value.filter((issue) => !issue.repairedPath) : issues.value
)
const shownIssues = computed(() => visibleIssues.value.slice(0, rowLimit.value))
const repairableSelected = computed(() =>
  issues.value.filter((issue) => selected.value.has(issue.fileId))
)
const unrepairedCount = computed(() => issues.value.filter((issue) => !issue.repairedPath).length)
const totalBrokenChapters = computed(() =>
  issues.value.reduce((sum, issue) => sum + issue.affectedChapters, 0)
)
const percent = computed(() => {
  const current = status.value?.current ?? 0
  const total = status.value?.total ?? 0
  return total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0
})
const failedRepairs = computed(() => (status.value?.repairResults ?? []).filter((result) => !result.ok))
const succeededRepairs = computed(
  () => (status.value?.repairResults ?? []).filter((result) => result.ok).length
)

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`
}

async function refresh(): Promise<void> {
  try {
    const response = await window.novelTracker.getLibraryHealthStatus()
    if (!response.ok) throw new Error(response.error)
    status.value = response.value
    if (response.value.phase === 'idle') stopPolling()
    else startPolling()
  } catch (reason) {
    error.value = toMessage(reason)
    stopPolling()
  }
}

function startPolling(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

async function run(
  action: () => ReturnType<typeof window.novelTracker.startLibraryHealthScan>
): Promise<void> {
  error.value = ''
  starting.value = true
  try {
    const response = await action()
    if (!response.ok) throw new Error(response.error)
    status.value = response.value
    rowLimit.value = ROWS_PER_PAGE
    startPolling()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    starting.value = false
  }
}

function startScan(): void {
  selected.value = new Set()
  void run(() => window.novelTracker.startLibraryHealthScan())
}

function askRepair(ids: string[]): void {
  if (ids.length > 0) confirmRepair.value = [...ids]
}

function repairConfirmed(): void {
  // Copy into a plain array: a Vue reactive array cannot be sent to the main process.
  const ids = [...(confirmRepair.value ?? [])]
  confirmRepair.value = null
  void run(() => window.novelTracker.startLibraryHealthRepair(ids))
}

async function cancel(): Promise<void> {
  try {
    await window.novelTracker.cancelLibraryHealth()
  } catch (reason) {
    error.value = toMessage(reason)
  }
}

function toggle(fileId: string): void {
  const next = new Set(selected.value)
  if (next.has(fileId)) next.delete(fileId)
  else next.add(fileId)
  selected.value = next
}

function selectAllVisible(): void {
  selected.value = new Set(visibleIssues.value.filter((issue) => !issue.repairedPath).map((issue) => issue.fileId))
}

function clearSelection(): void {
  selected.value = new Set()
}

onMounted(() => void refresh())
onUnmounted(stopPolling)
</script>

<template>
  <section class="card discovery-queue" aria-labelledby="library-health-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">LIBRARY HEALTH</p>
        <h3 id="library-health-heading">Broken chapters</h3>
      </div>
      <div class="queue-header-actions">
        <Button
          icon="pi pi-search"
          title="Scan the library for broken chapters"
          aria-label="Scan the library for broken chapters"
          :loading="starting"
          :disabled="running || starting"
          @click="startScan"
        />
        <Button
          icon="pi pi-times"
          severity="secondary"
          text
          rounded
          size="small"
          title="Cancel the running scan or repair"
          aria-label="Cancel the running scan or repair"
          :disabled="!running"
          @click="cancel"
        />
      </div>
    </div>
    <p class="help-text">
      Some novel pages put the end of the page (advertisements, scripts and the footer) into the chapter text. The scan opens every EPUB
      in the library and counts the chapters that contain this page code. Repairing saves a cleaned copy next to the original named
      “&lt;name&gt;-repaired.epub”; the original file is never changed. Scan the library afterwards so the repaired copies are indexed.
    </p>

    <Message v-if="error" :key="error" severity="error" closable class="feedback" @close="error = ''">{{ error }}</Message>

    <div v-if="running" class="library-health-progress">
      <ProgressBar :value="percent" :show-value="false" />
      <p class="help-text">{{ status?.message }} · {{ percent }}%</p>
    </div>

    <template v-else-if="status && status.scannedAt">
      <p class="help-text">
        Last scan: {{ new Date(status.scannedAt).toLocaleString() }} · {{ plural(status.scannedFileCount, 'EPUB file') }} checked
        <template v-if="status.skippedFileCount > 0"> · {{ plural(status.skippedFileCount, 'file') }} skipped (not EPUB)</template>
        · {{ status.message }}
      </p>
      <details v-if="status.errors.length > 0" class="queue-status-section">
        <summary class="queue-status-group-heading">
          <span>Files that could not be checked</span>
          <small>{{ status.errors.length.toLocaleString() }}</small>
        </summary>
        <p v-for="(message, index) in status.errors.slice(0, 50)" :key="index" class="help-text">{{ message }}</p>
      </details>
    </template>
    <p v-else class="empty-state">The library has not been checked yet. Choose the scan button to start.</p>

    <template v-if="!running && issues.length > 0">
      <div class="queue-list-controls">
        <span class="queue-visible-count">
          {{ plural(unrepairedCount, 'file') }} to repair · {{ plural(totalBrokenChapters, 'broken chapter') }} in total
        </span>
        <label class="queue-separate-job">
          <input v-model="hideRepaired" type="checkbox" />
          <span>Hide repaired files</span>
        </label>
        <Button label="Select all" severity="secondary" text size="small" :disabled="visibleIssues.length === 0" @click="selectAllVisible" />
        <Button label="Clear selection" severity="secondary" text size="small" :disabled="selected.size === 0" @click="clearSelection" />
        <Button
          icon="pi pi-wrench"
          :label="`Repair selected (${repairableSelected.length.toLocaleString()})`"
          size="small"
          :disabled="repairableSelected.length === 0"
          @click="askRepair(repairableSelected.map((issue) => issue.fileId))"
        />
        <Button
          icon="pi pi-wrench"
          :label="`Repair all (${unrepairedCount.toLocaleString()})`"
          severity="secondary"
          size="small"
          :disabled="unrepairedCount === 0"
          @click="askRepair(issues.filter((issue) => !issue.repairedPath).map((issue) => issue.fileId))"
        />
      </div>

      <div v-for="issue in shownIssues" :key="issue.fileId" class="queue-item">
        <div class="queue-item-summary">
          <div class="queue-item-heading">
            <label class="queue-separate-job">
              <input type="checkbox" :checked="selected.has(issue.fileId)" :aria-label="`Select ${issue.filename}`" @change="toggle(issue.fileId)" />
              <strong :title="issue.filename">{{ issue.filename }}</strong>
            </label>
            <span>{{ issue.folderState }}</span>
          </div>
          <div class="queue-item-detail-grid">
            <div class="queue-item-detail-column">
              <span :title="issue.relativePath">{{ issue.relativePath }}</span>
              <span>{{ plural(issue.affectedChapters, 'chapter') }} with page code</span>
            </div>
            <div class="queue-item-detail-column">
              <span :title="issue.examples.join('\n')">Examples: {{ issue.examples.slice(0, 3).join(' · ') }}</span>
              <span v-if="issue.repairedPath" :title="issue.repairedPath">Repaired copy saved</span>
            </div>
          </div>
        </div>
        <span class="history-status" :class="issue.repairedPath ? 'status-completed' : 'status-failed'">
          {{ issue.repairedPath ? 'Repaired copy saved' : 'Needs repair' }}
        </span>
        <div class="queue-item-actions">
          <div class="queue-item-buttons">
            <Button
              icon="pi pi-wrench"
              severity="secondary"
              text
              size="small"
              :title="`Repair ${issue.filename}`"
              :aria-label="`Repair ${issue.filename}`"
              @click="askRepair([issue.fileId])"
            />
          </div>
        </div>
      </div>
      <Button
        v-if="shownIssues.length < visibleIssues.length"
        icon="pi pi-chevron-down"
        :title="`Show ${Math.min(ROWS_PER_PAGE, visibleIssues.length - shownIssues.length)} more files`"
        :aria-label="`Show ${Math.min(ROWS_PER_PAGE, visibleIssues.length - shownIssues.length)} more files`"
        severity="secondary"
        text
        size="small"
        class="queue-show-more"
        @click="rowLimit += ROWS_PER_PAGE"
      />
    </template>
    <p v-else-if="!running && status?.scannedAt && issues.length === 0" class="empty-state">
      No broken chapters were found in the EPUB files that were checked.
    </p>

    <template v-if="!running && (status?.repairResults.length ?? 0) > 0">
      <Message severity="success" :closable="false" class="feedback">
        Repaired {{ plural(succeededRepairs, 'file') }}. Scan the library to index the repaired copies.
      </Message>
      <Message v-for="result in failedRepairs" :key="result.fileId" severity="error" :closable="false" class="feedback">
        {{ result.filename }} could not be repaired: {{ result.error }}
      </Message>
    </template>

    <ConfirmDialog
      :open="confirmRepair !== null"
      :title="`Repair ${plural(confirmRepair?.length ?? 0, 'file')}?`"
      message="A cleaned copy named “<name>-repaired.epub” is saved next to each original. The originals are not changed. A repaired copy that already exists will be replaced."
      confirm-label="Repair"
      @confirm="repairConfirmed"
      @cancel="confirmRepair = null"
    />
  </section>
</template>
