<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import type {
  DiscoveryQueueItemSummary,
  DiscoveryQueueStatus,
  DiscoveryQueueUpdate,
  DownloadedNovelLookupResult
} from '../../../shared/contracts'
import {
  extractNovelNameFromUrl,
  normalizeNovelLookupName,
  normalizeNovelSourceUrl
} from '../../../shared/downloadedNovelLookup'
import { toMessage } from '../../../shared/errors'
import ConfirmDialog from './ConfirmDialog.vue'

type ResultFilter = 'all' | 'found' | 'not-found'
type ResultState = 'in-library' | 'in-queue' | 'not-found'

/** A saved lookup. It stays valid while the library index is unchanged. */
interface SavedMatch extends DownloadedNovelLookupResult {
  key: string
  checkedAt: string
  libraryScannedAt: string
}

interface JobMatch {
  job: DiscoveryQueueItemSummary
  matchType: 'url' | 'name'
}

interface ResultRow {
  key: string
  entry: SavedMatch
  jobMatches: JobMatch[]
  state: ResultState
}

interface StoredState {
  version: 2
  results: string[]
  cache: Record<string, SavedMatch>
}

interface ResultGroup {
  state: ResultState
  label: string
  rows: ResultRow[]
}

const storageKey = 'novel-tracker.downloaded-check.v2'
const legacyStorageKey = 'novel-tracker.downloaded-check.batch.v1'
const MAX_SAVED_MATCHES = 3000
const LOOKUP_BATCH_SIZE = 500
const SEND_BATCH_SIZE = 100
const ROWS_PER_PAGE = 50

const jobStatusLabels: Partial<Record<DiscoveryQueueStatus, string>> = {
  discovering: 'Discovering',
  'needs-review': 'Needs review',
  ready: 'Ready',
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Completed',
  'partially-completed': 'Partially completed',
  'packaging-failed': 'Packaging failed',
  failed: 'Failed'
}

const filterOptions: Array<{ value: ResultFilter; label: string }> = [
  { value: 'all', label: 'All results' },
  { value: 'found', label: 'Found (library or current jobs)' },
  { value: 'not-found', label: 'Not found' }
]

const groupDefinitions: Array<{ state: ResultState; label: string }> = [
  { state: 'not-found', label: 'Not found' },
  { state: 'in-queue', label: 'In current jobs only' },
  { state: 'in-library', label: 'In library' }
]

const inputText = ref('')
const results = ref<string[]>([])
const savedMatches = ref<Record<string, SavedMatch>>({})
const jobs = ref<DiscoveryQueueItemSummary[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const filter = ref<ResultFilter>('all')
const grouped = ref(false)
const rowLimits = ref<Record<string, number>>({})
const confirmForget = ref(false)
const filterElement = ref<HTMLDetailsElement | null>(null)

let persistTimer: ReturnType<typeof setTimeout> | undefined
let jobRefreshTimer: ReturnType<typeof setTimeout> | undefined
let removeQueueListener: (() => void) | undefined

// ---------------------------------------------------------------- saved data

function isSavedMatch(value: unknown): value is SavedMatch {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.key === 'string' &&
    typeof item.url === 'string' &&
    typeof item.extractedName === 'string' &&
    typeof item.checkedAt === 'string' &&
    typeof item.libraryScannedAt === 'string' &&
    Array.isArray(item.matches) &&
    (item.matchType === null || item.matchType === 'url' || item.matchType === 'name')
  )
}

function loadSavedState(): void {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' && parsed !== null &&
        (parsed as StoredState).version === 2 &&
        Array.isArray((parsed as StoredState).results) &&
        typeof (parsed as StoredState).cache === 'object'
      ) {
        const stored = parsed as StoredState
        const cache: Record<string, SavedMatch> = {}
        for (const [key, entry] of Object.entries(stored.cache ?? {})) {
          if (isSavedMatch(entry)) cache[key] = entry
        }
        savedMatches.value = cache
        results.value = stored.results.filter((key) => typeof key === 'string' && key in cache)
        return
      }
    }
    const legacyRaw = localStorage.getItem(legacyStorageKey)
    if (!legacyRaw) return
    // Older versions saved one list that mixed the results with their matches.
    const legacy: unknown = JSON.parse(legacyRaw)
    if (!Array.isArray(legacy)) return
    const cache: Record<string, SavedMatch> = {}
    const keys: string[] = []
    for (const item of legacy) {
      if (
        typeof item === 'object' && item !== null &&
        typeof item.key === 'string' && typeof item.url === 'string' &&
        typeof item.extractedName === 'string' && Array.isArray(item.matches) &&
        (item.matchType === null || item.matchType === 'url' || item.matchType === 'name')
      ) {
        cache[item.key] = {
          key: item.key,
          url: item.url,
          extractedName: item.extractedName,
          matchType: item.matchType,
          matches: item.matches,
          checkedAt: typeof item.checkedAt === 'string' ? item.checkedAt : '',
          libraryScannedAt: ''
        }
        keys.push(item.key)
      }
    }
    savedMatches.value = cache
    results.value = keys
    persistNow()
    localStorage.removeItem(legacyStorageKey)
  } catch {
    savedMatches.value = {}
    results.value = []
    error.value = 'The saved results could not be read, so the check was reset.'
  }
}

function pruneSavedMatches(): void {
  const entries = Object.values(savedMatches.value)
  if (entries.length <= MAX_SAVED_MATCHES) return
  const shown = new Set(results.value)
  const shownEntries = entries.filter((entry) => shown.has(entry.key))
  const otherEntries = entries
    .filter((entry) => !shown.has(entry.key))
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))
    .slice(0, Math.max(0, MAX_SAVED_MATCHES - shownEntries.length))
  savedMatches.value = Object.fromEntries(
    [...shownEntries, ...otherEntries].map((entry) => [entry.key, entry])
  )
}

function persistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  try {
    pruneSavedMatches()
    const state: StoredState = {
      version: 2,
      results: results.value,
      cache: savedMatches.value
    }
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    error.value = 'The results could not be saved on this computer. They will be lost when you close the app.'
  }
}

function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistNow, 400)
}

// -------------------------------------------------------------- current jobs

async function refreshJobs(): Promise<void> {
  try {
    jobs.value = (await window.novelTracker.getDiscoveryQueueSnapshot()).items
  } catch (reason) {
    error.value = `The current jobs could not be loaded: ${toMessage(reason)}`
  }
}

function handleQueueUpdate(update: DiscoveryQueueUpdate): void {
  const known = new Map(jobs.value.map((job) => [job.id, job.status]))
  const relevant =
    update.removedIds.length > 0 ||
    update.upserted.some((job) => known.get(job.id) !== job.status)
  if (!relevant) return
  if (jobRefreshTimer) clearTimeout(jobRefreshTimer)
  jobRefreshTimer = setTimeout(() => void refreshJobs(), 800)
}

function addToIndex(
  index: Map<string, DiscoveryQueueItemSummary[]>,
  keys: Array<string | null>,
  job: DiscoveryQueueItemSummary
): void {
  for (const key of new Set(keys)) {
    if (!key) continue
    const list = index.get(key) ?? []
    list.push(job)
    index.set(key, list)
  }
}

// Cancelled jobs are ignored: the novel is not being downloaded.
const activeJobs = computed(() => jobs.value.filter((job) => job.status !== 'cancelled'))

const jobsByUrlKey = computed(() => {
  const index = new Map<string, DiscoveryQueueItemSummary[]>()
  for (const job of activeJobs.value) {
    addToIndex(index, [
      normalizeNovelSourceUrl(job.sourceUrl),
      normalizeNovelSourceUrl(job.downloadOptions?.sourceUrl ?? '')
    ], job)
  }
  return index
})

const jobsByNameKey = computed(() => {
  const index = new Map<string, DiscoveryQueueItemSummary[]>()
  for (const job of activeJobs.value) {
    addToIndex(index, [
      normalizeNovelLookupName(job.title) || null,
      normalizeNovelLookupName(extractNovelNameFromUrl(job.sourceUrl)) || null
    ], job)
  }
  return index
})

// ------------------------------------------------------------------- results

const rows = computed<ResultRow[]>(() =>
  results.value.flatMap((key) => {
    const entry = savedMatches.value[key]
    if (!entry) return []
    const jobMatches: JobMatch[] = []
    const seen = new Set<string>()
    for (const job of jobsByUrlKey.value.get(key) ?? []) {
      seen.add(job.id)
      jobMatches.push({ job, matchType: 'url' })
    }
    const nameKey = normalizeNovelLookupName(entry.extractedName)
    for (const job of nameKey ? jobsByNameKey.value.get(nameKey) ?? [] : []) {
      if (!seen.has(job.id)) jobMatches.push({ job, matchType: 'name' })
    }
    const state: ResultState =
      entry.matchType !== null ? 'in-library' : jobMatches.length > 0 ? 'in-queue' : 'not-found'
    return [{ key, entry, jobMatches, state }]
  })
)

const notFoundRows = computed(() => rows.value.filter((row) => row.state === 'not-found'))
const libraryCount = computed(() => rows.value.filter((row) => row.state === 'in-library').length)
const queueOnlyCount = computed(() => rows.value.filter((row) => row.state === 'in-queue').length)
const foundCount = computed(() => libraryCount.value + queueOnlyCount.value)

const filteredRows = computed(() =>
  rows.value.filter((row) =>
    filter.value === 'all' ? true : filter.value === 'found' ? row.state !== 'not-found' : row.state === 'not-found'
  )
)

const groups = computed<ResultGroup[]>(() =>
  groupDefinitions.flatMap(({ state, label }) => {
    const groupRows = filteredRows.value.filter((row) => row.state === state)
    return groupRows.length > 0 ? [{ state, label, rows: groupRows }] : []
  })
)

const filterSummary = computed(
  () => filterOptions.find((option) => option.value === filter.value)?.label ?? 'All results'
)

const enteredUrlCount = computed(
  () => splitUrls(inputText.value).length
)

function countFor(value: ResultFilter): number {
  return value === 'all' ? rows.value.length : value === 'found' ? foundCount.value : notFoundRows.value.length
}

function visibleRows(key: string, list: ResultRow[]): ResultRow[] {
  return list.slice(0, rowLimits.value[key] ?? ROWS_PER_PAGE)
}

function showMore(key: string, total: number): void {
  const current = rowLimits.value[key] ?? ROWS_PER_PAGE
  rowLimits.value = { ...rowLimits.value, [key]: Math.min(current + ROWS_PER_PAGE, total) }
}

function selectFilter(value: ResultFilter): void {
  filter.value = value
  rowLimits.value = {}
  if (filterElement.value) filterElement.value.open = false
}

function closeFilterOnOutsideClick(event: PointerEvent): void {
  const element = filterElement.value
  if (element && event.target instanceof Node && !element.contains(event.target)) {
    element.open = false
  }
}

// ----------------------------------------------------------------- labelling

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function displayName(row: ResultRow): string {
  return row.entry.extractedName || 'Unrecognized novel name'
}

function statusLabel(row: ResultRow): string {
  if (row.state === 'in-library') return row.jobMatches.length > 0 ? 'In library and queue' : 'In library'
  return row.state === 'in-queue' ? 'In queue' : 'Not found'
}

function statusClass(row: ResultRow): string {
  if (row.state === 'in-library') return 'status-completed'
  return row.state === 'in-queue' ? 'status-queued' : 'status-paused'
}

function libraryExplanation(row: ResultRow): string {
  if (row.entry.matchType === 'url') return 'Matched by URL: your library has this exact source URL.'
  if (row.entry.matchType === 'name') {
    return 'Matched by name: your library has a novel with this name, but not this exact source URL.'
  }
  return 'Not in your library.'
}

function jobExplanation(match: JobMatch): string {
  const status = jobStatusLabels[match.job.status] ?? match.job.status.replace(/-/g, ' ')
  const how = match.matchType === 'url' ? 'matched by URL' : 'matched by name'
  return `${match.job.title} · ${status} · ${how}`
}

function pathSummary(paths: string[]): string {
  if (paths.length <= 2) return paths.join(' · ')
  return `${paths.slice(0, 2).join(' · ')} · and ${(paths.length - 2).toLocaleString()} more`
}

// ------------------------------------------------------------------- actions

function splitUrls(text: string): string[] {
  // Commas only separate URLs when another URL follows, because URLs may contain commas.
  return text
    .split(/[\r\n]+|,(?=\s*https?:\/\/)/i)
    .map((value) => value.trim())
    .filter(Boolean)
}

async function currentLibraryStamp(): Promise<string> {
  try {
    return (await window.novelTracker.getLibraryIndexSummary())?.scannedAt ?? ''
  } catch {
    return ''
  }
}

async function lookup(urls: string[]): Promise<DownloadedNovelLookupResult[]> {
  const found: DownloadedNovelLookupResult[] = []
  for (let offset = 0; offset < urls.length; offset += LOOKUP_BATCH_SIZE) {
    const response = await window.novelTracker.lookupDownloadedNovels(
      urls.slice(offset, offset + LOOKUP_BATCH_SIZE)
    )
    if (!response.ok) throw new Error(response.error)
    found.push(...response.value)
  }
  return found
}

/** Looks the URLs up and returns the updated saved matches (never mutates objects in place). */
async function lookupAndSave(
  targets: Array<{ key: string; url: string }>,
  stamp: string
): Promise<{ saved: Record<string, SavedMatch>; missing: string[] }> {
  const fresh = await lookup(targets.map((target) => target.url))
  const byKey = new Map(fresh.map((result) => [normalizeNovelSourceUrl(result.url), result]))
  const saved = { ...savedMatches.value }
  const missing: string[] = []
  const checkedAt = new Date().toISOString()
  for (const { key, url } of targets) {
    const result = byKey.get(key)
    if (!result) {
      missing.push(url)
      continue
    }
    saved[key] = { ...result, key, url, checkedAt, libraryScannedAt: stamp }
  }
  return { saved, missing }
}

async function checkUrls(): Promise<void> {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  const submitted = splitUrls(inputText.value)
  if (submitted.length === 0) return

  const shown = new Set(results.value)
  const unique = new Map<string, string>()
  const invalid: string[] = []
  let duplicates = 0
  for (const url of submitted) {
    const key = normalizeNovelSourceUrl(url)
    if (!key) {
      invalid.push(url)
      continue
    }
    if (shown.has(key) || unique.has(key)) {
      duplicates += 1
      continue
    }
    unique.set(key, url)
  }
  const invalidMessage = invalid.length
    ? `${plural(invalid.length, 'entry', 'entries')} skipped. Enter complete http:// or https:// novel URLs.`
    : ''
  if (unique.size === 0) {
    if (invalid.length) error.value = invalidMessage
    else notice.value = 'Those URLs are already in the results.'
    return
  }

  busy.value = true
  try {
    await refreshJobs()
    const stamp = await currentLibraryStamp()
    const reusable: string[] = []
    const toLookUp: Array<{ key: string; url: string }> = []
    for (const [key, url] of unique) {
      const saved = savedMatches.value[key]
      if (saved && stamp !== '' && saved.libraryScannedAt === stamp) reusable.push(key)
      else toLookUp.push({ key, url })
    }
    let saved = savedMatches.value
    let missing: string[] = []
    if (toLookUp.length > 0) ({ saved, missing } = await lookupAndSave(toLookUp, stamp))
    savedMatches.value = saved
    const added = [...unique.keys()].filter((key) => key in saved)
    results.value = [...results.value, ...added]
    inputText.value = invalid.join('\n')
    const parts = [
      `Checked ${plural(added.length, 'URL')}`,
      reusable.length ? `${plural(reusable.length, 'saved match', 'saved matches')} reused` : '',
      toLookUp.length - missing.length > 0
        ? `${plural(toLookUp.length - missing.length, 'new lookup')} made`
        : ''
    ].filter(Boolean)
    notice.value = `${parts.join(' · ')}.${duplicates ? ` ${plural(duplicates, 'duplicate')} skipped.` : ''}`
    if (missing.length) error.value = `${plural(missing.length, 'URL')} could not be checked. Try again.`
    else if (invalid.length) error.value = invalidMessage
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    busy.value = false
    persistSoon()
  }
}

async function recheckResults(): Promise<void> {
  const targets = rows.value.map((row) => ({ key: row.key, url: row.entry.url }))
  if (targets.length === 0 || busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await refreshJobs()
    const { saved, missing } = await lookupAndSave(targets, await currentLibraryStamp())
    savedMatches.value = saved
    notice.value = `Rechecked ${plural(targets.length - missing.length, 'URL')} against the library and current jobs.`
    if (missing.length) error.value = `${plural(missing.length, 'URL')} could not be rechecked.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    busy.value = false
    persistSoon()
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

async function copyNotFound(): Promise<void> {
  error.value = ''
  notice.value = ''
  if (await copyText(notFoundRows.value.map((row) => row.entry.url).join('\n'))) {
    notice.value = `Copied ${plural(notFoundRows.value.length, 'not-found URL')}.`
  } else {
    error.value = 'The URLs could not be copied. Select them in the list and copy them manually.'
  }
}

async function copyOne(url: string): Promise<void> {
  error.value = ''
  notice.value = ''
  if (await copyText(url)) notice.value = 'Copied the URL.'
  else error.value = 'The URL could not be copied.'
}

async function sendNotFoundToDiscovery(): Promise<void> {
  // Only novels that are in neither the library nor a current job are sent.
  const candidates = [...notFoundRows.value]
  if (candidates.length === 0 || busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    let added = 0
    for (let offset = 0; offset < candidates.length; offset += SEND_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + SEND_BATCH_SIZE)
      const response = await window.novelTracker.addDiscoveryQueueItems(
        batch.map((row) => ({
          title: row.entry.extractedName || hostOf(row.entry.url),
          author: '',
          sourceUrl: row.entry.url,
          origin: 'manual' as const
        }))
      )
      if (!response.ok) throw new Error(response.error)
      added += response.value.length
    }
    await refreshJobs()
    const skipped = candidates.length - added
    notice.value = `Sent ${plural(added, 'novel')} to discovery. They now appear under current jobs.${
      skipped > 0 ? ` ${plural(skipped, 'novel')} could not be added because the queue already has that source.` : ''
    }`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    busy.value = false
  }
}

function removeResult(key: string): void {
  results.value = results.value.filter((candidate) => candidate !== key)
  persistSoon()
}

function clearResults(): void {
  results.value = []
  rowLimits.value = {}
  error.value = ''
  notice.value = 'Results cleared. Saved matches were kept, so checking the same URLs again is instant until your library changes.'
  persistSoon()
}

function forgetSavedMatches(): void {
  confirmForget.value = false
  results.value = []
  savedMatches.value = {}
  rowLimits.value = {}
  error.value = ''
  notice.value = 'All saved matches were removed.'
  persistSoon()
}

onMounted(() => {
  loadSavedState()
  document.addEventListener('pointerdown', closeFilterOnOutsideClick)
  removeQueueListener = window.novelTracker.onDiscoveryQueueUpdate(handleQueueUpdate)
  void refreshJobs()
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', closeFilterOnOutsideClick)
  removeQueueListener?.()
  if (jobRefreshTimer) clearTimeout(jobRefreshTimer)
  persistNow()
})
</script>

<template>
  <section class="intro">
    <p class="eyebrow">LIBRARY AND QUEUE LOOKUP</p>
    <h2>Downloaded Novel Check</h2>
    <p>
      Paste novel URLs to find out whether you already have them. Each URL is checked against your library index
      (by source URL first, then by the novel name in the URL) and against your current queue jobs, except cancelled ones.
      The check does not contact the novel website or run chapter discovery.
    </p>
  </section>

  <section class="card queue-intake" aria-labelledby="downloaded-check-add-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">CHECK NOVELS</p>
        <h3 id="downloaded-check-add-heading">Add novel URLs</h3>
      </div>
      <span class="count-pill">{{ results.length.toLocaleString() }} in the results</span>
    </div>
    <label class="field-label" for="downloaded-check-urls">Novel URLs</label>
    <textarea
      id="downloaded-check-urls"
      v-model="inputText"
      class="queue-url-input"
      rows="4"
      placeholder="https://example.com/novel-one&#10;https://example.com/novel-two"
      :disabled="busy"
      @keydown.ctrl.enter="checkUrls"
    />
    <p class="help-text">
      Enter one URL per line. Press Ctrl+Enter to check. Results and matches are saved on this computer, so you can continue later.
    </p>
    <div class="queue-add-row">
      <span class="help-text">{{ plural(enteredUrlCount, 'URL') }} entered</span>
      <Button
        icon="pi pi-search"
        title="Check URLs"
        aria-label="Check URLs"
        :loading="busy"
        :disabled="busy || enteredUrlCount === 0"
        @click="checkUrls"
      />
    </div>
    <Message v-if="error" :key="error" severity="error" closable class="feedback" @close="error = ''">{{ error }}</Message>
    <Message v-if="notice" :key="notice" severity="success" closable class="feedback" @close="notice = ''">{{ notice }}</Message>
  </section>

  <section v-if="rows.length > 0" class="card discovery-queue" aria-labelledby="downloaded-check-results-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">RESULTS</p>
        <h3 id="downloaded-check-results-heading">
          {{ foundCount.toLocaleString() }} found · {{ notFoundRows.length.toLocaleString() }} not found
        </h3>
      </div>
      <div class="queue-header-actions">
        <Button
          icon="pi pi-copy"
          severity="secondary"
          text
          rounded
          size="small"
          title="Copy the not-found URLs"
          aria-label="Copy the not-found URLs"
          :disabled="busy || notFoundRows.length === 0"
          @click="copyNotFound"
        />
        <Button
          icon="pi pi-send"
          size="small"
          text
          rounded
          :title="`Send ${notFoundRows.length.toLocaleString()} not-found novels to discovery`"
          :aria-label="`Send ${notFoundRows.length.toLocaleString()} not-found novels to discovery`"
          :loading="busy"
          :disabled="busy || notFoundRows.length === 0"
          @click="sendNotFoundToDiscovery"
        />
        <Button
          icon="pi pi-refresh"
          severity="secondary"
          text
          rounded
          size="small"
          title="Recheck all results against the library and current jobs"
          aria-label="Recheck all results against the library and current jobs"
          :disabled="busy"
          @click="recheckResults"
        />
        <Button
          icon="pi pi-eraser"
          severity="secondary"
          text
          rounded
          size="small"
          title="Clear the results (saved matches are kept)"
          aria-label="Clear the results (saved matches are kept)"
          :disabled="busy"
          @click="clearResults"
        />
        <Button
          icon="pi pi-trash"
          severity="danger"
          text
          rounded
          size="small"
          title="Forget all saved matches"
          aria-label="Forget all saved matches"
          :disabled="busy"
          @click="confirmForget = true"
        />
      </div>
    </div>

    <div class="queue-list-controls">
      <details ref="filterElement" class="queue-status-filter">
        <summary>Show · {{ filterSummary }}</summary>
        <div class="queue-status-options" role="radiogroup" aria-label="Filter the results">
          <label v-for="option in filterOptions" :key="option.value" class="queue-status-option">
            <input
              type="radio"
              name="downloaded-check-filter"
              :checked="filter === option.value"
              @change="selectFilter(option.value)"
            />
            <span>{{ option.label }}</span>
            <small>{{ countFor(option.value).toLocaleString() }}</small>
          </label>
        </div>
      </details>
      <label class="queue-separate-job">
        <input v-model="grouped" type="checkbox" />
        <span>Group by status</span>
      </label>
      <span class="queue-visible-count">
        Showing {{ filteredRows.length.toLocaleString() }} of {{ rows.length.toLocaleString() }} results
      </span>
    </div>
    <p class="help-text">
      Found means the novel is in your library or in a current queue job. Not found means neither, and only those novels can be sent to discovery.
      Clearing the results keeps the saved matches, so checking the same URLs again is instant until your library changes. Use the bin button to forget the saved matches as well.
    </p>

    <p v-if="filteredRows.length === 0" class="empty-state">No results match this filter.</p>

    <template v-else-if="grouped">
      <details v-for="group in groups" :key="group.state" class="queue-status-section" open>
        <summary class="queue-status-group-heading">
          <span>{{ group.label }}</span>
          <small>{{ group.rows.length.toLocaleString() }}</small>
        </summary>
        <div v-for="row in visibleRows(group.state, group.rows)" :key="row.key" class="queue-item">
          <div class="queue-item-summary">
            <div class="queue-item-heading">
              <strong :title="displayName(row)">{{ displayName(row) }}</strong>
              <span>{{ hostOf(row.entry.url) }}</span>
              <span class="queue-item-source-group">
                <span class="queue-item-source-url" :title="row.entry.url">{{ row.entry.url }}</span>
                <Button icon="pi pi-copy" severity="secondary" text rounded size="small" :aria-label="`Copy the URL for ${displayName(row)}`" title="Copy the URL" @click="copyOne(row.entry.url)" />
              </span>
            </div>
            <div class="queue-item-detail-grid">
              <div class="queue-item-detail-column">
                <span>{{ libraryExplanation(row) }}</span>
                <template v-for="(match, matchIndex) in row.entry.matches" :key="`${row.key}-${matchIndex}`">
                  <span>{{ match.novelName }}<template v-if="match.sourceUrl"> · saved source: {{ match.sourceUrl }}</template></span>
                  <span v-if="match.localPaths.length" :title="match.localPaths.join('\n')">{{ pathSummary(match.localPaths) }}</span>
                </template>
                <span v-if="row.entry.checkedAt">Checked {{ new Date(row.entry.checkedAt).toLocaleString() }}</span>
              </div>
              <div class="queue-item-detail-column">
                <span v-if="row.jobMatches.length === 0">No current job uses this novel.</span>
                <span v-for="match in row.jobMatches" :key="match.job.id" :title="match.job.sourceUrl">{{ jobExplanation(match) }}</span>
              </div>
            </div>
          </div>
          <span class="history-status" :class="statusClass(row)">{{ statusLabel(row) }}</span>
          <div class="queue-item-actions">
            <div class="queue-item-buttons">
              <Button icon="pi pi-times" severity="danger" text size="small" :aria-label="`Remove ${displayName(row)} from the results`" title="Remove from the results" :disabled="busy" @click="removeResult(row.key)" />
            </div>
          </div>
        </div>
        <Button
          v-if="visibleRows(group.state, group.rows).length < group.rows.length"
          icon="pi pi-chevron-down"
          :title="`Show ${Math.min(ROWS_PER_PAGE, group.rows.length - visibleRows(group.state, group.rows).length)} more results`"
          :aria-label="`Show ${Math.min(ROWS_PER_PAGE, group.rows.length - visibleRows(group.state, group.rows).length)} more results`"
          severity="secondary"
          text
          size="small"
          class="queue-show-more"
          @click="showMore(group.state, group.rows.length)"
        />
      </details>
    </template>

    <template v-else>
      <div v-for="row in visibleRows('all', filteredRows)" :key="row.key" class="queue-item">
        <div class="queue-item-summary">
          <div class="queue-item-heading">
            <strong :title="displayName(row)">{{ displayName(row) }}</strong>
            <span>{{ hostOf(row.entry.url) }}</span>
            <span class="queue-item-source-group">
              <span class="queue-item-source-url" :title="row.entry.url">{{ row.entry.url }}</span>
              <Button icon="pi pi-copy" severity="secondary" text rounded size="small" :aria-label="`Copy the URL for ${displayName(row)}`" title="Copy the URL" @click="copyOne(row.entry.url)" />
            </span>
          </div>
          <div class="queue-item-detail-grid">
            <div class="queue-item-detail-column">
              <span>{{ libraryExplanation(row) }}</span>
              <template v-for="(match, matchIndex) in row.entry.matches" :key="`${row.key}-${matchIndex}`">
                <span>{{ match.novelName }}<template v-if="match.sourceUrl"> · saved source: {{ match.sourceUrl }}</template></span>
                <span v-if="match.localPaths.length" :title="match.localPaths.join('\n')">{{ pathSummary(match.localPaths) }}</span>
              </template>
              <span v-if="row.entry.checkedAt">Checked {{ new Date(row.entry.checkedAt).toLocaleString() }}</span>
            </div>
            <div class="queue-item-detail-column">
              <span v-if="row.jobMatches.length === 0">No current job uses this novel.</span>
              <span v-for="match in row.jobMatches" :key="match.job.id" :title="match.job.sourceUrl">{{ jobExplanation(match) }}</span>
            </div>
          </div>
        </div>
        <span class="history-status" :class="statusClass(row)">{{ statusLabel(row) }}</span>
        <div class="queue-item-actions">
          <div class="queue-item-buttons">
            <Button icon="pi pi-times" severity="danger" text size="small" :aria-label="`Remove ${displayName(row)} from the results`" title="Remove from the results" :disabled="busy" @click="removeResult(row.key)" />
          </div>
        </div>
      </div>
      <Button
        v-if="visibleRows('all', filteredRows).length < filteredRows.length"
        icon="pi pi-chevron-down"
        :title="`Show ${Math.min(ROWS_PER_PAGE, filteredRows.length - visibleRows('all', filteredRows).length)} more results`"
        :aria-label="`Show ${Math.min(ROWS_PER_PAGE, filteredRows.length - visibleRows('all', filteredRows).length)} more results`"
        severity="secondary"
        text
        size="small"
        class="queue-show-more"
        @click="showMore('all', filteredRows.length)"
      />
    </template>
  </section>

  <p v-else class="empty-state">No results yet. Paste some novel URLs above and choose Check URLs.</p>

  <ConfirmDialog
    :open="confirmForget"
    title="Forget all saved matches?"
    message="The results and all saved matches will be removed. Checking the same URLs again will look them up again. Your library and queue are not changed."
    confirm-label="Forget matches"
    @confirm="forgetSavedMatches"
    @cancel="confirmForget = false"
  />
</template>
