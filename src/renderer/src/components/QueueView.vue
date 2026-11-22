<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import { getDomainRequestDelayMs } from '../../../shared/domainRequestPreferences'
import {
  isSiteExtractionModeCompatible,
  normalizeSiteHostname
} from '../../../shared/siteExtractionPreferences'
import { useTrackerNovelSearch } from '../composables/useTrackerNovelSearch'
import type {
  DomainRequestDelayPreference,
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DiscoveryQueueStatus,
  DiscoveryQueueUpdate,
  DiscoveryQueueSnapshot,
  FailedQueueChapter,
  QueueEpubOverrides,
  TrackerNovel,
  SiteExtractionMode
} from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'

const emit = defineEmits<{
  openItem: [item: DiscoveryQueueItem]
}>()

const queueStatusFilterElement = ref<HTMLDetailsElement | null>(null)

interface QueueStatusOption {
  value: DiscoveryQueueStatus
  label: string
}

interface QueueStatusGroup {
  status: DiscoveryQueueStatus
  label: string
  items: DiscoveryQueueItemSummary[]
}

const queueStatusOptions: QueueStatusOption[] = [
  { value: 'discovering', label: 'Discovering' },
  { value: 'needs-review', label: 'Needs review' },
  { value: 'ready', label: 'Ready' },
  { value: 'queued', label: 'Queued' },
  { value: 'downloading', label: 'Downloading' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed / downloaded' },
  { value: 'partially-completed', label: 'Partially completed' },
  { value: 'packaging-failed', label: 'Packaging failed — retry packaging' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' }
]
const queueViewPreferencesKey = 'novel-tracker.queue-view-preferences'
const QUEUE_ITEMS_PER_PAGE = 30

const items = ref<DiscoveryQueueItemSummary[]>([])
const queuePageSizes = ref<Partial<Record<DiscoveryQueueStatus, number>>>({})
const selectedQueueStatuses = ref<DiscoveryQueueStatus[]>([])
const collapsedQueueStatuses = ref<DiscoveryQueueStatus[]>([])
const selectedQueueItemIds = ref<string[]>([])
const trackerNovels = ref<TrackerNovel[]>([])
const trackerVisible = ref(false)
const trackerLoading = ref(false)
const { trackerSearch, filteredTrackerNovels } = useTrackerNovelSearch(
  () => trackerNovels.value
)
const trackerSources = ref<Record<string, string>>({})
const selectedTrackerIds = ref<string[]>([])
const trackerCsvPath = ref('')
const manualUrls = ref('')
const allowSeparateJobs = ref(false)
const loading = ref(true)
const adding = ref(false)
const maxDownloads = ref(2)
const outputDirectory = ref('')
const domainRequestDelays = ref<DomainRequestDelayPreference[]>([])
const parserModeDrafts = ref<Record<string, SiteExtractionMode>>({})
const retryingId = ref('')
const retryingAllDiscoveries = ref(false)
const browserOpeningId = ref('')
const browserRetryingId = ref('')
const browserReadyId = ref('')
const cancelingDiscoveryId = ref('')
const refreshingId = ref('')
const removingId = ref('')
const downloadActionId = ref('')
const batchQueueing = ref(false)
const clearing = ref(false)
const clearingCompleted = ref(false)
const error = ref('')
const notice = ref('')
const expandedFailedChapterId = ref('')
const failedChapterDetails = ref<FailedQueueChapter[]>([])
const loadingFailedChapterId = ref('')
let removeQueueListener: (() => void) | undefined
let queueRevision = 0
let queueSnapshotLoaded = false
let queueSnapshotRequestActive = false
const pendingQueueUpdates: DiscoveryQueueUpdate[] = []
loadQueueViewPreferences()

const activeDownloadCount = computed(() => items.value.filter((item) => item.status === 'downloading').length)
const failedDiscoveryCount = computed(() =>
  items.value.filter((item) => item.status === 'failed' && !item.downloadOptions).length
)
const completedQueueCount = computed(() => items.value.filter((item) => item.status === 'completed').length)
const copyingSync = ref(false)
const syncFallbackText = ref('')
const syncMessage = ref('')
const syncError = ref('')
// Completed jobs that the current status filter shows (the export uses exactly these).
const visibleCompletedItems = computed(() =>
  filteredQueueItems.value.filter((item) => item.status === 'completed')
)
const queuedItems = computed(() =>
  items.value
    .filter((item) => item.status === 'queued' && item.downloadOptions)
    .sort(compareQueuedItems)
)
const batchQueueableItems = computed(() =>
  items.value.filter((item) => {
    if (item.status === 'ready') return item.chapterSummary.selected > 0
    return (
      item.status === 'needs-review' &&
      item.chapterSummary.recommended > 0 &&
      !item.chapterSummary.hasUncertainArchiveChapters
    )
  })
)
const batchAcceptableItems = computed(() =>
  items.value.filter(
    (item) =>
      item.status === 'needs-review' &&
      !item.chapterSummary.hasUncertainArchiveChapters
  )
)
const batchAccepting = ref(false)
const selectableQueueItems = computed(() =>
  items.value.filter((item) =>
    item.status === 'ready'
      ? item.chapterSummary.selected > 0
      : item.status === 'needs-review' &&
        hasQueueableChapters(item) &&
        !item.chapterSummary.hasUncertainArchiveChapters
  )
)
const filteredQueueItems = computed(() =>
  selectedQueueStatuses.value.length === 0
    ? items.value
    : items.value.filter((item) => selectedQueueStatuses.value.includes(item.status))
)
const queueStatusCounts = computed(() => {
  const counts = new Map<DiscoveryQueueStatus, number>()
  for (const { value } of queueStatusOptions) {
    counts.set(value, items.value.filter((item) => item.status === value).length)
  }
  return counts
})
const queueGroups = computed<QueueStatusGroup[]>(() => {
  return queueStatusOptions.flatMap(({ value, label }) => {
    const groupItems = filteredQueueItems.value
      .filter((item) => item.status === value)
      .sort(value === 'queued' ? compareQueuedItems : compareQueueItemsByTitle)
    return groupItems.length > 0 ? [{ status: value, label, items: groupItems }] : []
  })
})
const queueFilterSummary = computed(() =>
  selectedQueueStatuses.value.length === 0
    ? 'All statuses'
    : `${selectedQueueStatuses.value.length} selected`
)
const selectedQueueableItems = computed(() =>
  selectableQueueItems.value.filter((item) => selectedQueueItemIds.value.includes(item.id))
)
const allVisibleQueueSectionsCollapsed = computed(() =>
  queueGroups.value.length > 0 &&
  queueGroups.value.every((group) => isQueueSectionCollapsed(group.status))
)
const renderedQueueItemCount = computed(() =>
  queueGroups.value.reduce(
    (total, group) =>
      total + Math.min(group.items.length, queuePageSizes.value[group.status] ?? QUEUE_ITEMS_PER_PAGE),
    0
  )
)

function toggleQueueStatus(status: DiscoveryQueueStatus): void {
  selectedQueueStatuses.value = selectedQueueStatuses.value.includes(status)
    ? selectedQueueStatuses.value.filter((selected) => selected !== status)
    : [...selectedQueueStatuses.value, status]
}

function toggleQueueItemSelection(itemId: string): void {
  selectedQueueItemIds.value = selectedQueueItemIds.value.includes(itemId)
    ? selectedQueueItemIds.value.filter((id) => id !== itemId)
    : [...selectedQueueItemIds.value, itemId]
}

function selectVisibleQueueableItems(): void {
  const eligibleIds = filteredQueueItems.value
    .filter((item) => isQueueItemSelectable(item.id))
    .map((item) => item.id)
  selectedQueueItemIds.value = [...new Set([...selectedQueueItemIds.value, ...eligibleIds])]
}

function isQueueItemSelectable(itemId: string): boolean {
  return selectableQueueItems.value.some((item) => item.id === itemId)
}

function isQueueSectionCollapsed(status: DiscoveryQueueStatus): boolean {
  return collapsedQueueStatuses.value.includes(status)
}

function updateQueueSectionCollapse(status: DiscoveryQueueStatus, event: Event): void {
  if (!(event.currentTarget instanceof HTMLDetailsElement)) return
  const collapsed = !event.currentTarget.open
  collapsedQueueStatuses.value = collapsed
    ? [...new Set([...collapsedQueueStatuses.value, status])]
    : collapsedQueueStatuses.value.filter((candidate) => candidate !== status)
}

function toggleAllQueueSections(): void {
  const statuses = queueGroups.value.map((group) => group.status)
  if (allVisibleQueueSectionsCollapsed.value) {
    collapsedQueueStatuses.value = collapsedQueueStatuses.value.filter((status) => !statuses.includes(status))
  } else {
    collapsedQueueStatuses.value = [...new Set([...collapsedQueueStatuses.value, ...statuses])]
  }
}

function visibleQueueItems(group: QueueStatusGroup): DiscoveryQueueItemSummary[] {
  return group.items.slice(
    0,
    queuePageSizes.value[group.status] ?? QUEUE_ITEMS_PER_PAGE
  )
}

function showMoreQueueItems(status: DiscoveryQueueStatus, total: number): void {
  const current = queuePageSizes.value[status] ?? QUEUE_ITEMS_PER_PAGE
  queuePageSizes.value = {
    ...queuePageSizes.value,
    [status]: Math.min(current + QUEUE_ITEMS_PER_PAGE, total)
  }
}

function isQueueStatus(value: unknown): value is DiscoveryQueueStatus {
  return queueStatusOptions.some((option) => option.value === value)
}

function loadQueueViewPreferences(): void {
  try {
    const saved = localStorage.getItem(queueViewPreferencesKey)
    if (!saved) return
    const preferences = JSON.parse(saved) as {
      statuses?: unknown
      collapsedStatuses?: unknown
    }
    if (!Array.isArray(preferences.statuses)) {
      throw new Error('The saved Queue display settings have an invalid format.')
    }
    selectedQueueStatuses.value = [...new Set(preferences.statuses.filter(isQueueStatus))]
    collapsedQueueStatuses.value = Array.isArray(preferences.collapsedStatuses)
      ? [...new Set(preferences.collapsedStatuses.filter(isQueueStatus))]
      : []
  } catch (reason) {
    error.value = `Queue display settings could not be loaded: ${toMessage(reason)}`
  }
}

watch([selectedQueueStatuses, collapsedQueueStatuses], () => {
  try {
    localStorage.setItem(queueViewPreferencesKey, JSON.stringify({
      statuses: selectedQueueStatuses.value,
      collapsedStatuses: collapsedQueueStatuses.value
    }))
  } catch (reason) {
    error.value = `Queue display settings could not be saved: ${toMessage(reason)}`
  }
}, { deep: true, flush: 'sync' })

function compareQueuedItems(left: DiscoveryQueueItemSummary, right: DiscoveryQueueItemSummary): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id)
}

function compareQueueItemsByTitle(left: DiscoveryQueueItemSummary, right: DiscoveryQueueItemSummary): number {
  return left.title.localeCompare(right.title, 'en', { numeric: true, sensitivity: 'base' }) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
}

function hasQueueableChapters(item: DiscoveryQueueItemSummary): boolean {
  if (item.status === 'ready') return item.chapterSummary.selected > 0
  return item.chapterSummary.recommended > 0
}

function chaptersRemaining(item: DiscoveryQueueItemSummary): number | null {
  if (!item.progress || item.progress.total <= 0) return null
  return Math.max(0, item.progress.total - item.progress.current)
}

function estimatedTimeRemaining(item: DiscoveryQueueItemSummary): string | null {
  const remaining = chaptersRemaining(item)
  if (remaining === null) return null

  let hostname: string
  try {
    hostname = normalizeSiteHostname(new URL(item.sourceUrl).hostname)
  } catch {
    return null
  }

  const requestDelayMs = getDomainRequestDelayMs(hostname, domainRequestDelays.value)
  const totalSeconds = Math.ceil((remaining * (requestDelayMs + 1000)) / 1000)
  if (totalSeconds < 60) return `~${totalSeconds} sec`

  const totalMinutes = Math.ceil(totalSeconds / 60)
  if (totalMinutes < 60) return `~${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `~${hours} hr ${minutes} min` : `~${hours} hr`
}

async function copyCompletedForAndroid(): Promise<void> {
  const ids = visibleCompletedItems.value.map((item) => item.id)
  if (ids.length === 0 || copyingSync.value) return
  syncMessage.value = ''
  syncError.value = ''
  syncFallbackText.value = ''
  copyingSync.value = true
  try {
    const response = await window.novelTracker.copyQueueDownloadSyncText(ids)
    if (!response.ok) throw new Error(response.error)
    const sync = response.value
    const skipped = sync.skippedCount
      ? ` ${sync.skippedCount.toLocaleString()} job${sync.skippedCount === 1 ? ' was' : 's were'} left out because no downloaded chapter number is known.`
      : ''
    if (sync.copied) {
      syncMessage.value = `Copied the download counts of ${sync.novelCount.toLocaleString()} novels from the ${ids.length.toLocaleString()} completed jobs shown. In the Android app open the ⋮ menu, choose "Update downloads from text…", paste, check the preview, and apply it.${skipped}`
    } else {
      syncFallbackText.value = sync.text
      syncError.value = `The clipboard could not be written. Copy the ${sync.novelCount.toLocaleString()} lines below by hand.${skipped}`
    }
  } catch (reason) {
    syncError.value = toMessage(reason)
  } finally {
    copyingSync.value = false
  }
}

function selectSyncText(event: Event): void {
  if (event.target instanceof HTMLTextAreaElement) event.target.select()
}

async function refreshQueue(): Promise<void> {
  if (queueSnapshotRequestActive) return
  queueSnapshotRequestActive = true
  loading.value = true
  try {
    applyQueueSnapshot(await window.novelTracker.getDiscoveryQueueSnapshot())
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    loading.value = false
    queueSnapshotRequestActive = false
    if (
      queueSnapshotLoaded &&
      pendingQueueUpdates.some((update) => update.revision > queueRevision + 1)
    ) {
      void refreshQueue()
    }
  }
}

function updateCancelingDiscovery(items: DiscoveryQueueItemSummary[]): void {
  if (
    cancelingDiscoveryId.value &&
    !items.some((item) => item.id === cancelingDiscoveryId.value && item.status === 'discovering')
  ) {
    cancelingDiscoveryId.value = ''
  }
}

function applyQueueSnapshot(snapshot: DiscoveryQueueSnapshot): void {
  if (snapshot.revision < queueRevision) return
  items.value = snapshot.items
  queueRevision = snapshot.revision
  queueSnapshotLoaded = true
  updateCancelingDiscovery(snapshot.items)
  const pending = pendingQueueUpdates
    .filter((update) => update.revision > queueRevision)
    .sort((left, right) => left.revision - right.revision)
  pendingQueueUpdates.length = 0
  for (const update of pending) {
    if (update.revision !== queueRevision + 1) {
      pendingQueueUpdates.push(update)
      void refreshQueue()
      return
    }
    applyQueueUpdateNow(update)
  }
}

function applyQueueUpdate(update: DiscoveryQueueUpdate): void {
  if (!queueSnapshotLoaded || update.revision > queueRevision + 1) {
    if (!pendingQueueUpdates.some((pending) => pending.revision === update.revision))
      pendingQueueUpdates.push(update)
    if (queueSnapshotLoaded) void refreshQueue()
    return
  }
  if (update.revision <= queueRevision) return
  applyQueueUpdateNow(update)
}

function applyQueueUpdateNow(update: DiscoveryQueueUpdate): void {
  const byId = new Map(items.value.map((item) => [item.id, item]))
  for (const id of update.removedIds) byId.delete(id)
  for (const item of update.upserted) byId.set(item.id, item)
  const orderedItems = update.order
    .map((id) => byId.get(id))
    .filter((item): item is DiscoveryQueueItemSummary => item !== undefined)
  if (orderedItems.length !== update.order.length) {
    pendingQueueUpdates.push(update)
    void refreshQueue()
    return
  }
  items.value = orderedItems
  queueRevision = update.revision
  updateCancelingDiscovery(orderedItems)
}

onMounted(() => {
  document.addEventListener('pointerdown', closeQueueStatusFilterOnOutsideClick)
  removeQueueListener = window.novelTracker.onDiscoveryQueueUpdate(applyQueueUpdate)
  void refreshQueue()
  void window.novelTracker.getSettings().then((settings) => {
    maxDownloads.value = settings.maxSimultaneousDownloads
    outputDirectory.value = settings.outputDirectory
    domainRequestDelays.value = settings.domainRequestDelays
  }).catch((reason: unknown) => {
    error.value = toMessage(reason)
  })
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', closeQueueStatusFilterOnOutsideClick)
  removeQueueListener?.()
})

function closeQueueStatusFilterOnOutsideClick(event: PointerEvent): void {
  const filter = queueStatusFilterElement.value
  if (filter && event.target instanceof Node && !filter.contains(event.target)) {
    filter.open = false
  }
}

async function toggleTrackerPicker(): Promise<void> {
  trackerVisible.value = !trackerVisible.value
  if (!trackerVisible.value || trackerNovels.value.length > 0) return

  trackerLoading.value = true
  error.value = ''
  try {
    const settings = await window.novelTracker.getSettings()
    trackerCsvPath.value = settings.trackerCsvPath
    const result = await window.novelTracker.getTrackerNovels()
    if (!result.ok) {
      error.value = result.error
      return
    }
    trackerNovels.value = result.value
    trackerSources.value = Object.fromEntries(
      result.value.map((novel) => [
        novel.stableId,
        novel.sources.find((source) => source.valid)?.url ?? novel.sources[0]?.url ?? ''
      ])
    )
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    trackerLoading.value = false
  }
}

function closeTrackerPicker(): void {
  trackerVisible.value = false
}

function isTrackerSelected(stableId: string): boolean {
  return selectedTrackerIds.value.includes(stableId)
}

function toggleTrackerSelection(stableId: string): void {
  selectedTrackerIds.value = isTrackerSelected(stableId)
    ? selectedTrackerIds.value.filter((id) => id !== stableId)
    : [...selectedTrackerIds.value, stableId]
}

function sourceHost(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname
  } catch {
    return sourceUrl
  }
}

function sourceUrlForItem(item: DiscoveryQueueItemSummary): string {
  return item.downloadOptions?.sourceUrl || item.sourceUrl
}

function parserModeForItem(item: DiscoveryQueueItemSummary): SiteExtractionMode {
  return parserModeDrafts.value[item.id] ?? item.siteExtractionMode ?? 'automatic'
}

function isParserModeDirty(item: DiscoveryQueueItemSummary): boolean {
  return parserModeForItem(item) !== (item.siteExtractionMode ?? 'automatic')
}

function updateParserModeDraft(item: DiscoveryQueueItemSummary, event: Event): void {
  if (!(event.currentTarget instanceof HTMLSelectElement)) return
  const value = event.currentTarget.value
  if (value !== 'automatic' && value !== 'generic-html' && value !== 'novelfull') return
  parserModeDrafts.value = { ...parserModeDrafts.value, [item.id]: value }
}

function effectiveRequestDelay(item: DiscoveryQueueItemSummary): string {
  try {
    const hostname = normalizeSiteHostname(new URL(sourceUrlForItem(item)).hostname)
    return `${getDomainRequestDelayMs(hostname, domainRequestDelays.value).toLocaleString()} ms`
  } catch {
    return 'unknown'
  }
}

async function copySourceUrl(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  try {
    await navigator.clipboard.writeText(sourceUrlForItem(item))
    notice.value = `Copied the source URL for ${item.title}.`
  } catch (reason) {
    error.value = `Could not copy the source URL: ${toMessage(reason)}`
  }
}

async function toggleFailedChapterDetails(
  item: DiscoveryQueueItemSummary
): Promise<void> {
  if (expandedFailedChapterId.value === item.id) {
    expandedFailedChapterId.value = ''
    return
  }

  error.value = ''
  expandedFailedChapterId.value = item.id
  failedChapterDetails.value = []
  loadingFailedChapterId.value = item.id
  try {
    const result = await window.novelTracker.getFailedQueueChapters(item.id)
    if (expandedFailedChapterId.value !== item.id) return
    if (!result.ok) {
      error.value = result.error
      expandedFailedChapterId.value = ''
      return
    }
    failedChapterDetails.value = result.value
  } catch (reason) {
    if (expandedFailedChapterId.value === item.id) {
      error.value = toMessage(reason)
      expandedFailedChapterId.value = ''
    }
  } finally {
    if (loadingFailedChapterId.value === item.id) {
      loadingFailedChapterId.value = ''
    }
  }
}

async function addToQueue(): Promise<void> {
  error.value = ''
  notice.value = ''
  adding.value = true
  const inputs: DiscoveryQueueInput[] = []
  const rejectedRows: string[] = []
  const manualLines = manualUrls.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const invalidManualLines: string[] = []

  for (const line of manualLines) {
    try {
      const sourceUrl = new URL(line)
      if ((sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:') || sourceUrl.username || sourceUrl.password) {
        throw new Error('Unsupported URL')
      }
      inputs.push({
        title: sourceUrl.hostname,
        author: '',
        sourceUrl: sourceUrl.href,
        origin: 'manual',
        separateJob: allowSeparateJobs.value
      })
    } catch {
      invalidManualLines.push(line)
    }
  }

  for (const stableId of selectedTrackerIds.value) {
    const novel = trackerNovels.value.find((candidate) => candidate.stableId === stableId)
    if (!novel) continue
    const sourceUrl = trackerSources.value[stableId] ?? ''
    const source = novel.sources.find((candidate) => candidate.url === sourceUrl)
    if (!source || !source.valid) {
      rejectedRows.push(novel.title)
      continue
    }
    inputs.push({
      title: novel.siteTitle || novel.title,
      author: novel.author,
      sourceUrl: source.url,
      origin: 'tracker',
      separateJob: allowSeparateJobs.value,
      trackerRow: {
        stableId: novel.stableId,
        rowNumber: novel.rowNumber,
        title: novel.title,
        alternativeNames: novel.alternativeNames,
        csvPath: trackerCsvPath.value
      }
    })
  }

  if (inputs.length === 0) {
    error.value = rejectedRows.length
      ? `No usable source URL is selected for: ${rejectedRows.join(', ')}.`
      : 'Enter one or more valid URLs or select tracker novels with a valid source.'
    adding.value = false
    return
  }

  try {
    const result = await window.novelTracker.addDiscoveryQueueItems(inputs)
    if (!result.ok) {
      error.value = result.error
      return
    }
    await refreshQueue()
    const duplicateCount = inputs.length - result.value.length
    const separateJobCount = result.value.filter((item) => item.separateJob).length
    const summary = result.value.length
      ? `Added ${result.value.length} item${result.value.length === 1 ? '' : 's'} for live discovery.`
      : 'All selected sources are already in the queue.'
    const duplicateSummary =
      duplicateCount > 0
        ? `${duplicateCount} duplicate source${duplicateCount === 1 ? '' : 's'} skipped.`
        : ''
    const separateSummary =
      separateJobCount > 0
        ? `${separateJobCount} added as separate job${separateJobCount === 1 ? '' : 's'}.`
        : ''
    notice.value = [summary, duplicateSummary, separateSummary].filter(Boolean).join(' ')
    if (rejectedRows.length > 0) {
      notice.value += ` No valid source selected for: ${rejectedRows.join(', ')}.`
    }
    manualUrls.value = invalidManualLines.join('\n')
    selectedTrackerIds.value = []
    trackerVisible.value = false
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    adding.value = false
  }
}

async function retryItem(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  retryingId.value = item.id
  try {
    const result = await window.novelTracker.retryDiscoveryQueueItem(item.id)
    if (!result.ok) error.value = result.error
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    retryingId.value = ''
  }
}

async function retryAllFailedScans(): Promise<void> {
  error.value = ''
  notice.value = ''
  retryingAllDiscoveries.value = true
  try {
    const result = await window.novelTracker.retryAllFailedDiscoveries()
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = result.value
      ? `Queued ${result.value.toLocaleString()} failed scan${result.value === 1 ? '' : 's'} for retry.`
      : 'There are no failed scans to retry.'
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    retryingAllDiscoveries.value = false
  }
}

async function forceRetryItem(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  retryingId.value = item.id
  try {
    const result = await window.novelTracker.forceRetryDiscoveryQueueItem(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Restarted chapter discovery for ${item.title}.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    retryingId.value = ''
  }
}

async function openItemInBrowser(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  browserOpeningId.value = item.id
  browserReadyId.value = ''
  try {
    const failedChapter = item.downloadOptions ? item.failedChapters[0] : undefined
    const verificationUrl = failedChapter?.url ?? item.sourceUrl
    const result = await window.novelTracker.openVerificationBrowser(verificationUrl)
    if (!result.ok) {
      error.value = result.error
      return
    }
    browserReadyId.value = item.id
    const nextAction = item.status === 'paused' ? 'resume' : 'retry'
    notice.value = failedChapter
      ? `Opened failed chapter "${failedChapter.title}" in Chromium. Complete any verification there, then ${nextAction} the EPUB job.`
      : `Opened ${item.title} in Chromium. Complete any sign-in or verification manually, then ${nextAction} the EPUB job.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    browserOpeningId.value = ''
  }
}

async function retryItemWithBrowser(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  browserRetryingId.value = item.id
  try {
    const result = await window.novelTracker.retryDiscoveryQueueItemWithBrowser(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Retried discovery for ${item.title} using the browser session.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    browserRetryingId.value = ''
  }
}

async function cancelQueueDiscovery(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  cancelingDiscoveryId.value = item.id
  let cancellationRequested = false
  try {
    const result = await window.novelTracker.cancelDiscoveryQueueItem(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    cancellationRequested = true
    notice.value = `Stopping discovery for ${item.title}.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    if (!cancellationRequested) cancelingDiscoveryId.value = ''
  }
}

async function runDownloadAction(
  item: DiscoveryQueueItemSummary,
  action: 'retry' | 'pause' | 'resume' | 'cancel'
): Promise<void> {
  error.value = ''
  notice.value = ''
  downloadActionId.value = item.id
  let shouldRefresh = false
  try {
    const result = action === 'retry'
      ? await window.novelTracker.retryEpub(item.id)
      : action === 'pause'
        ? await window.novelTracker.pauseEpub(item.id)
        : action === 'resume'
          ? await window.novelTracker.resumeEpub(item.id)
          : await window.novelTracker.cancelEpub(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    if (action === 'cancel') notice.value = `Cancelled the EPUB job for ${item.title}.`
    else if (action === 'pause') notice.value = `Paused the EPUB job for ${item.title}.`
    else if (action === 'resume') notice.value = `Resumed the EPUB job for ${item.title}.`
    else notice.value = `Queued ${item.title} for retry.`
    shouldRefresh = true
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
  if (shouldRefresh) void refreshQueue()
}

async function recoverQueueItem(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  downloadActionId.value = item.id
  try {
    const result = await window.novelTracker.recoverEpubQueueItem(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = item.downloadOptions
      ? `Restored saved job history and queued ${item.title} without rediscovering chapters.`
      : `Restarted chapter discovery for ${item.title} using its saved source URL.`
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function repackageOffline(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  downloadActionId.value = item.id
  try {
    const result = await window.novelTracker.repackageEpub(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Queued ${item.title} for offline repackaging from saved content.`
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function saveAvailableChapters(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  downloadActionId.value = item.id
  try {
    const result = await window.novelTracker.saveAvailableChaptersEpub(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Queued ${item.title} to package its available saved chapters.`
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function queueRecommendedEpub(item: DiscoveryQueueItemSummary): Promise<string | null> {
  if (item.status === 'needs-review') {
    const accepted = await window.novelTracker.acceptQueueRecommendations(item.id)
    if (!accepted.ok) return `${item.title}: ${accepted.error}`
  }

  const overrides: QueueEpubOverrides = {
    title: item.title,
    author: item.author,
    description: item.description,
    coverUrl: item.coverUrl,
    alternativeNames: [...item.alternativeNames],
    genres: [...item.genres],
    source: item.source,
    novelStatus: item.novelStatus,
    language: 'en',
    outputDirectory: outputDirectory.value
  }
  const result = await window.novelTracker.enqueueEpubFromSnapshot(
    item.id,
    overrides
  )
  return result.ok ? null : `${item.title}: ${result.error}`
}

async function queueOneRecommendedEpub(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  downloadActionId.value = item.id
  try {
    const failure = await queueRecommendedEpub(item)
    if (failure) {
      error.value = failure
      return
    }
    notice.value = `Queued EPUB for ${item.title}.`
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function openQueueItem(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  const result = await window.novelTracker.getDiscoveryQueueItem(item.id)
  if (!result.ok) {
    error.value = result.error
    return
  }
  emit('openItem', result.value)
}

async function queueAllRecommendedEpubs(): Promise<void> {
  error.value = ''
  notice.value = ''
  batchQueueing.value = true
  const failures: string[] = []
  let queued = 0
  try {
    for (const item of batchQueueableItems.value) {
      try {
        const failure = await queueRecommendedEpub(item)
        if (failure) failures.push(failure)
        else queued += 1
      } catch (reason) {
        failures.push(`${item.title}: ${toMessage(reason)}`)
      }
    }
    notice.value = `Queued ${queued} safe EPUB job${queued === 1 ? '' : 's'}.`
    if (failures.length) error.value = failures.join(' ')
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    batchQueueing.value = false
  }
}

async function queueSelectedEpubs(): Promise<void> {
  const selectedItems = [...selectedQueueableItems.value]
  if (selectedItems.length === 0) return
  error.value = ''
  notice.value = ''
  batchQueueing.value = true
  const failures: string[] = []
  let queued = 0
  try {
    for (const item of selectedItems) {
      try {
        const failure = await queueRecommendedEpub(item)
        if (failure) failures.push(failure)
        else queued += 1
      } catch (reason) {
        failures.push(`${item.title}: ${toMessage(reason)}`)
      }
    }
    selectedQueueItemIds.value = []
    notice.value = `Queued ${queued} selected EPUB job${queued === 1 ? '' : 's'}.`
    if (failures.length) error.value = failures.join(' ')
    await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    batchQueueing.value = false
  }
}

async function moveQueuedJob(item: DiscoveryQueueItemSummary, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<void> {
  error.value = ''
  downloadActionId.value = item.id
  try {
    const result = await window.novelTracker.moveQueuedEpub(item.id, direction)
    if (!result.ok) error.value = result.error
    else await refreshQueue()
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function acceptRecommendations(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  try {
    const result = await window.novelTracker.acceptQueueRecommendations(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Applied archive-aware suggestions for ${item.title}. Review the selected chapters before queueing the EPUB.`
  } catch (reason) {
    error.value = toMessage(reason)
  }
}

async function acceptSafeSuggestions(): Promise<void> {
  error.value = ''
  notice.value = ''
  batchAccepting.value = true
  let applied = 0
  try {
    for (const item of batchAcceptableItems.value) {
      const result = await window.novelTracker.acceptQueueRecommendations(item.id)
      if (!result.ok) {
        error.value = `${applied} item(s) accepted before "${item.title}" failed: ${result.error}`
        return
      }
      applied += 1
    }
    notice.value = applied
      ? `Applied suggestions to ${applied} item${applied === 1 ? '' : 's'}. Review chapters and manual selections before queueing EPUBs.`
      : 'No items currently meet the confidence requirement for batch acceptance.'
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    batchAccepting.value = false
  }
}

async function refreshItem(
  item: DiscoveryQueueItemSummary,
  parserMode?: SiteExtractionMode
): Promise<void> {
  error.value = ''
  notice.value = ''
  refreshingId.value = item.id
  try {
    const result = await window.novelTracker.refreshDiscoveryQueueItem(item.id, parserMode)
    if (!result.ok) {
      error.value = result.error
    } else if (parserMode !== undefined) {
      const remainingDrafts = { ...parserModeDrafts.value }
      delete remainingDrafts[item.id]
      parserModeDrafts.value = remainingDrafts
    }
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    refreshingId.value = ''
  }
}

async function removeItem(item: DiscoveryQueueItemSummary): Promise<void> {
  if (!window.confirm(`Remove "${item.title}" from the discovery queue?`)) return
  error.value = ''
  notice.value = ''
  removingId.value = item.id
  try {
    const result = await window.novelTracker.removeDiscoveryQueueItem(item.id)
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Removed ${item.title} from the queue.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    removingId.value = ''
  }
}

async function clearQueue(): Promise<void> {
  if (items.value.some((item) => ['discovering', 'queued', 'downloading', 'paused'].includes(item.status))) {
    error.value = 'Finish, cancel, or remove active EPUB jobs before clearing the queue.'
    return
  }
  if (!window.confirm(`Remove all ${items.value.length} saved queue items? Job history will remain. This cannot be undone.`)) return
  error.value = ''
  notice.value = ''
  clearing.value = true
  try {
    const result = await window.novelTracker.clearDiscoveryQueue()
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = 'Cleared the discovery queue.'
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    clearing.value = false
  }
}

async function clearCompletedQueueItems(): Promise<void> {
  const completedCount = completedQueueCount.value
  if (completedCount === 0) return
  if (!window.confirm(`Remove ${completedCount} completed queue entries? EPUB files and job history will remain.`)) return
  error.value = ''
  notice.value = ''
  clearingCompleted.value = true
  try {
    const result = await window.novelTracker.clearCompletedDiscoveryQueueItems()
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Removed ${completedCount} completed queue entries. EPUB files and job history were kept.`
  } catch (reason) {
    error.value = toMessage(reason)
  } finally {
    clearingCompleted.value = false
  }
}
</script>

<template>
  <section class="intro">
    <p class="eyebrow">LIVE CHAPTER DISCOVERY</p>
    <h2>Build a persistent novel queue</h2>
    <p>Add tracker entries or paste multiple URLs, review suggested chapters, then add EPUB jobs. Jobs survive navigation or app restart.</p>
  </section>

  <section class="card queue-intake" aria-labelledby="queue-intake-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">ADD NOVELS</p>
        <h3 id="queue-intake-heading">Queue sources for discovery</h3>
      </div>
      <Button
        :icon="trackerVisible ? 'pi pi-chevron-up' : 'pi pi-list'"
        :title="trackerVisible ? 'Hide tracker selection' : 'Add from tracker'"
        :aria-label="trackerVisible ? 'Hide tracker selection' : 'Add from tracker'"
        severity="secondary"
        outlined
        :loading="trackerLoading"
        :aria-expanded="trackerVisible"
        aria-controls="tracker-picker"
        @click="toggleTrackerPicker"
      />
    </div>

    <label class="field-label" for="queue-urls">Add by URL</label>
    <textarea
      id="queue-urls"
      v-model="manualUrls"
      class="queue-url-input"
      rows="4"
      placeholder="https://example.com/novel-one&#10;https://example.com/novel-two"
      :disabled="adding"
    />
    <p class="help-text">Paste one HTTP or HTTPS URL per line. Duplicate source URLs are skipped by default.</p>
    <label class="queue-separate-job">
      <input v-model="allowSeparateJobs" type="checkbox" :disabled="adding" />
      <span>Allow duplicate sources as separate jobs</span>
    </label>

    <div v-show="trackerVisible" id="tracker-picker" class="tracker-picker">
      <div class="tracker-picker-heading">
        <div>
          <h4>Select tracker novels</h4>
          <p>CSV access is read-only. Source requests begin only after adding selections to the queue.</p>
        </div>
        <Button
          icon="pi pi-times"
          severity="secondary"
          text
          rounded
          size="small"
          aria-label="Close tracker selection"
          title="Close tracker selection"
          @click="closeTrackerPicker"
        />
      </div>
      <InputText v-model="trackerSearch" class="full-input" placeholder="Search title, author, or alternate name" />
      <div v-if="trackerLoading" class="help-text">Reading the configured CSV…</div>
      <div v-else class="tracker-results">
        <div v-for="novel in filteredTrackerNovels" :key="novel.stableId" class="tracker-row">
          <label class="tracker-select">
            <input
              type="checkbox"
              :checked="isTrackerSelected(novel.stableId)"
              :disabled="!novel.sources.some((source) => source.valid)"
              @change="toggleTrackerSelection(novel.stableId)"
            />
            <span class="tracker-title">
              <strong>{{ novel.title }}</strong>
              <span>{{ novel.author || 'Author unknown' }}<template v-if="novel.siteTitle && novel.siteTitle !== novel.title"> · {{ novel.siteTitle }}</template></span>
            </span>
          </label>
          <div class="tracker-source">
            <select
              v-if="novel.sources.length"
              v-model="trackerSources[novel.stableId]"
              :aria-label="`Select source for ${novel.title}`"
            >
              <option v-for="source in novel.sources" :key="source.label" :value="source.url" :disabled="!source.valid">
                {{ source.label }}{{ source.valid ? '' : ' (invalid URL)' }}
              </option>
            </select>
            <span v-else class="help-text">No source URL</span>
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

    <div class="queue-add-row">
      <span class="help-text">{{ selectedTrackerIds.length }} tracker novels selected</span>
      <Button
        icon="pi pi-plus"
        title="Add selected novels and URLs to queue"
        aria-label="Add selected novels and URLs to queue"
        :loading="adding"
        :disabled="adding || (selectedTrackerIds.length === 0 && !manualUrls.trim())"
        @click="addToQueue"
      />
    </div>
    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="notice" severity="success" :closable="false" class="feedback">{{ notice }}</Message>
  </section>

  <section class="card discovery-queue" aria-labelledby="discovery-queue-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">LOCAL QUEUE</p>
        <h3 id="discovery-queue-heading">Discovery and EPUB jobs</h3>
      </div>
      <div class="queue-header-actions">
        <span class="queue-concurrency-summary" :title="`${activeDownloadCount} of ${maxDownloads} novels active`">
          <i class="pi pi-bolt" aria-hidden="true"></i>
          {{ activeDownloadCount }}/{{ maxDownloads }}
        </span>
        <Button
          icon="pi pi-bolt"
          size="small"
          text
          rounded
          :aria-label="`Queue all ${batchQueueableItems.length} ready items and safe suggestions`"
          :title="`Queue ${batchQueueableItems.length} ready items and review suggestions with certain archive coverage`"
          :loading="batchQueueing"
          :disabled="!outputDirectory || batchQueueableItems.length === 0 || batchQueueing || batchAccepting || Boolean(downloadActionId)"
          @click="queueAllRecommendedEpubs"
        />
        <Button
          icon="pi pi-check"
          severity="secondary"
          text
          rounded
          :aria-label="`Accept all ${batchAcceptableItems.length} safe suggestions`"
          :title="`Accept ${batchAcceptableItems.length} safe suggestions`"
          size="small"
          :loading="batchAccepting"
          :disabled="batchAcceptableItems.length === 0 || batchAccepting || batchQueueing || Boolean(downloadActionId)"
          @click="acceptSafeSuggestions"
        />
        <Button
          icon="pi pi-refresh"
          severity="secondary"
          text
          rounded
          size="small"
          aria-label="Reload saved queue"
          title="Reload saved queue"
          :loading="loading"
          @click="refreshQueue"
        />
        <Button
          icon="pi pi-check-circle"
          title="Clear completed queue items"
          aria-label="Clear completed queue items"
          severity="secondary"
          text
          size="small"
          :loading="clearingCompleted"
          :disabled="completedQueueCount === 0 || clearing || clearingCompleted || batchQueueing"
          @click="clearCompletedQueueItems"
        />
        <Button
          icon="pi pi-clipboard"
          title="Copy the completed jobs shown (see the status filter) to the clipboard for the Android app: name, downloaded chapter count and site page name"
          aria-label="Copy the completed jobs shown for the Android app"
          severity="secondary"
          text
          size="small"
          :loading="copyingSync"
          :disabled="visibleCompletedItems.length === 0 || copyingSync"
          @click="copyCompletedForAndroid"
        />
        <Button
          icon="pi pi-trash"
          severity="danger"
          text
          rounded
          size="small"
          aria-label="Clear queue"
          title="Clear queue"
          :loading="clearing"
          :disabled="items.length === 0 || clearing || clearingCompleted || batchQueueing || items.some((item) => ['discovering', 'queued', 'downloading', 'paused'].includes(item.status))"
          @click="clearQueue"
        />
      </div>
    </div>
    <div class="queue-list-controls">
      <details ref="queueStatusFilterElement" class="queue-status-filter">
        <summary>Filter status · {{ queueFilterSummary }}</summary>
        <div class="queue-status-options" role="group" aria-label="Filter queue by status">
          <label v-for="status in queueStatusOptions" :key="status.value" class="queue-status-option">
            <input
              type="checkbox"
              :checked="selectedQueueStatuses.includes(status.value)"
              @change="toggleQueueStatus(status.value)"
            />
            <span>{{ status.label }}</span>
            <small>{{ queueStatusCounts.get(status.value) ?? 0 }}</small>
          </label>
          <Button
            v-if="selectedQueueStatuses.length"
            icon="pi pi-times"
            title="Clear status filters"
            aria-label="Clear status filters"
            severity="secondary"
            text
            size="small"
            class="queue-status-clear"
            @click="selectedQueueStatuses = []"
          />
        </div>
      </details>
      <Button
        v-if="queueGroups.length"
        :icon="allVisibleQueueSectionsCollapsed ? 'pi pi-window-maximize' : 'pi pi-window-minimize'"
        :title="allVisibleQueueSectionsCollapsed ? 'Expand all queue sections' : 'Collapse all queue sections'"
        :aria-label="allVisibleQueueSectionsCollapsed ? 'Expand all queue sections' : 'Collapse all queue sections'"
        severity="secondary"
        text
        size="small"
        @click="toggleAllQueueSections"
      />
      <Button
        icon="pi pi-check-square"
        title="Select all eligible queue items"
        aria-label="Select all eligible queue items"
        severity="secondary"
        text
        size="small"
        :disabled="filteredQueueItems.every((item) => !isQueueItemSelectable(item.id))"
        @click="selectVisibleQueueableItems"
      />
      <Button
        icon="pi pi-bolt"
        :title="`Queue ${selectedQueueableItems.length} selected items`"
        :aria-label="`Queue ${selectedQueueableItems.length} selected items`"
        size="small"
        :disabled="!outputDirectory || !selectedQueueableItems.length || batchQueueing || batchAccepting || Boolean(downloadActionId)"
        @click="queueSelectedEpubs"
      />
      <Button
        v-if="failedDiscoveryCount > 0"
        icon="pi pi-refresh"
        severity="secondary"
        outlined
        size="small"
        title="Retry every failed chapter discovery; the discovery scheduler still limits simultaneous requests."
        :aria-label="`Retry all ${failedDiscoveryCount.toLocaleString()} failed scans`"
        :loading="retryingAllDiscoveries"
        :disabled="retryingAllDiscoveries || Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || clearing || batchQueueing || batchAccepting || Boolean(downloadActionId)"
        @click="retryAllFailedScans"
      />
      <Button
        v-if="selectedQueueItemIds.length"
        icon="pi pi-times"
        title="Clear queue selection"
        aria-label="Clear queue selection"
        severity="secondary"
        text
        size="small"
        @click="selectedQueueItemIds = []"
      />
      <span class="queue-visible-count">
        Showing {{ renderedQueueItemCount }} of {{ filteredQueueItems.length }} filtered · {{ items.length }} total
      </span>
    </div>
    <p v-if="!outputDirectory" class="help-text">Choose an EPUB output folder in Configuration to queue downloads.</p>
    <Message v-if="syncMessage" :key="syncMessage" severity="success" closable class="feedback" @close="syncMessage = ''">{{ syncMessage }}</Message>
    <Message v-if="syncError" :key="syncError" severity="error" closable class="feedback" @close="syncError = ''">{{ syncError }}</Message>
    <div v-if="syncFallbackText" class="library-note">
      <label class="field-label" for="queue-download-sync-text">Download counts for the Android app</label>
      <textarea
        id="queue-download-sync-text"
        class="queue-url-input"
        rows="8"
        readonly
        :value="syncFallbackText"
        @focus="selectSyncText"
      />
      <p class="help-text">Select all, copy, then paste it in the Android app: ⋮ menu, then "Update downloads from text…".</p>
    </div>
    <p v-if="loading && items.length === 0" class="help-text">Loading saved queue…</p>
    <p v-else-if="items.length === 0" class="empty-state">No novels queued. Add a tracker selection or one or more URLs above.</p>
    <p v-else-if="filteredQueueItems.length === 0" class="empty-state">No jobs match the selected statuses.</p>
    <template v-else v-for="group in queueGroups" :key="group.status">
      <details
        class="queue-status-section"
        :open="!isQueueSectionCollapsed(group.status)"
        @toggle="updateQueueSectionCollapse(group.status, $event)"
      >
        <summary class="queue-status-group-heading">
          <span>{{ group.label }}</span>
          <small>{{ group.items.length }}</small>
        </summary>
        <div v-for="item in visibleQueueItems(group)" :key="item.id" class="queue-item">
          <div class="queue-item-summary">
            <div class="queue-item-heading">
              <label v-if="isQueueItemSelectable(item.id)" class="queue-item-select">
                <input
                  type="checkbox"
                  :checked="selectedQueueItemIds.includes(item.id)"
                  :aria-label="`Select ${item.title} for batch queueing`"
                  @change="toggleQueueItemSelection(item.id)"
                />
              </label>
              <strong>{{ item.title }}</strong>
              <span>
                {{ item.origin === 'tracker' ? 'Tracker' : 'Manual URL' }} · {{ sourceHost(sourceUrlForItem(item)) }}
                <template v-if="item.separateJob"> · Separate job</template>
              </span>
              <span class="queue-item-source-group">
                <span
                  class="queue-item-source-url"
                  :title="sourceUrlForItem(item)"
                >
                  {{ sourceUrlForItem(item) }}
                </span>
                <Button
                  icon="pi pi-copy"
                  severity="secondary"
                  text
                  rounded
                  size="small"
                  :aria-label="`Copy source URL for ${item.title}`"
                  title="Copy full source URL"
                  @click="copySourceUrl(item)"
                />
              </span>
            </div>
            <div class="queue-item-detail-grid">
              <div class="queue-item-detail-column">
                <span v-if="item.chapterSummary.total">
                  {{ item.chapterSummary.selected.toLocaleString() }} selected ·
                  {{ item.chapterSummary.recommended.toLocaleString() }} suggested of {{ item.chapterSummary.total.toLocaleString() }}
                  <template v-if="item.chapterSummary.latestTitle"> · latest: {{ item.chapterSummary.latestTitle }}</template>
                </span>
                <span
                  v-if="item.recommendationSummary"
                  class="queue-item-recommendation"
                  :title="item.recommendationSummary"
                >
                  {{ item.recommendationSummary }}
                </span>
                <span v-if="item.discoveredAt">Discovered {{ new Date(item.discoveredAt).toLocaleString() }}</span>
                <span v-if="item.parserName">Discovery parser: {{ item.parserName }} · Host request interval: {{ effectiveRequestDelay(item) }}</span>
                <div
                  v-if="item.status === 'needs-review' || item.status === 'ready' || (
                    ['failed', 'cancelled'].includes(item.status) && !item.downloadOptions
                  )"
                  class="queue-item-parser-controls"
                >
                  <label :for="`parser-mode-${item.id}`">Discovery parser</label>
                  <select
                    :id="`parser-mode-${item.id}`"
                    class="configuration-select"
                    :value="parserModeForItem(item)"
                    :aria-label="`Discovery parser for ${item.title}`"
                    :disabled="Boolean(refreshingId) || Boolean(downloadActionId)"
                    @change="updateParserModeDraft(item, $event)"
                  >
                    <option value="automatic">Automatic</option>
                    <option value="generic-html">Generic HTML</option>
                    <option
                      v-if="isSiteExtractionModeCompatible(sourceUrlForItem(item), 'novelfull')"
                      value="novelfull"
                    >
                      NovelFull
                    </option>
                  </select>
                  <Button
                    icon="pi pi-check"
                    severity="secondary"
                    text
                    rounded
                    size="small"
                    :aria-label="`Apply discovery parser for ${item.title}`"
                    title="Apply parser and rediscover"
                    :loading="refreshingId === item.id"
                    :disabled="!isParserModeDirty(item) || Boolean(refreshingId) || Boolean(retryingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
                    @click="refreshItem(item, parserModeForItem(item))"
                  />
                </div>
              </div>
              <div class="queue-item-detail-column">
                <span v-if="item.downloadOptions && ['queued', 'downloading', 'paused'].includes(item.status) && chaptersRemaining(item) !== null" class="queue-remaining-chapters">
                  {{ chaptersRemaining(item)?.toLocaleString() }} chapters left ·
                  {{ item.progress?.current.toLocaleString() }} of {{ item.progress?.total.toLocaleString() }} complete
                </span>
                <span
                  v-if="item.downloadOptions && !item.repackageOnly && ['queued', 'downloading', 'paused'].includes(item.status) && estimatedTimeRemaining(item) !== null"
                  class="queue-estimated-time"
                  title="Rough estimate using this domain's request delay plus a 1-second per-chapter buffer. Server waits, retries, and image sizes can change it."
                >
                  Estimated time left: {{ estimatedTimeRemaining(item) }}
                </span>
                <span
                  v-if="item.repackageOnly && ['queued', 'downloading'].includes(item.status)"
                  class="queue-item-rechecking"
                >
                  <i class="pi pi-box" aria-hidden="true"></i>
                  {{ item.saveAvailableChaptersOnly
                    ? 'Saving available chapters offline — missing chapters remain available for retry'
                    : 'Offline repackaging from saved content — no network requests' }}
                </span>
                <div v-else-if="item.status === 'discovering' && !item.downloadOptions" class="queue-item-rechecking">
                  <span><i class="pi pi-spin pi-spinner" aria-hidden="true"></i> {{ item.progress?.message ?? 'Discovering chapters…' }}</span>
                  <ProgressBar
                    v-if="item.progress && item.progress.total > 0"
                    :value="Math.round((item.progress.current / item.progress.total) * 100)"
                    :show-value="false"
                    class="queue-item-progress"
                    :aria-label="`${item.title} chapter discovery progress`"
                  />
                </div>
                <span v-else-if="item.progress && item.status !== 'completed'">
                  <template
                    v-if="item.downloadOptions && (
                      ['queued', 'downloading', 'paused'].includes(item.status) ||
                      (item.status === 'partially-completed' && Boolean(item.outputPath))
                    )"
                  >
                    {{ item.progress.message }}
                  </template>
                  <template v-else>
                    {{ item.progress.current }} / {{ item.progress.total }} chapters · {{ item.progress.message }}
                  </template>
                </span>
              </div>
            </div>
            <span v-if="item.discoveryChanges" class="queue-item-change">{{ item.discoveryChanges }}</span>
            <span
              v-if="item.outputPath"
              class="queue-item-output"
              :title="item.outputPath"
            >
              <template v-if="(item.outputPaths?.length ?? 0) > 1">
                {{ item.outputPaths?.length }} EPUB volumes: {{ item.outputPaths?.map((output) => output.path).join(', ') }}
              </template>
              <template v-else>{{ item.outputPath }}</template>
            </span>
            <Button
              v-if="item.failedChapterCount"
              icon="pi pi-exclamation-triangle"
              severity="warning"
              text
              size="small"
              class="queue-item-failures-button"
              :title="`${expandedFailedChapterId === item.id ? 'Hide' : 'Show'} failed or omitted chapter details`"
              :aria-label="`${expandedFailedChapterId === item.id ? 'Hide' : 'Show'} ${item.failedChapterCount.toLocaleString()} failed or omitted chapter details for ${item.title}`"
              :aria-expanded="expandedFailedChapterId === item.id"
              :aria-controls="`failed-chapters-${item.id}`"
              @click="toggleFailedChapterDetails(item)"
            />
            <span v-if="item.error" class="queue-item-error">{{ item.error }}</span>
            <div
              v-if="expandedFailedChapterId === item.id"
              :id="`failed-chapters-${item.id}`"
              class="queue-item-failure-details"
            >
              <span v-if="loadingFailedChapterId === item.id">Loading failed chapter details…</span>
              <span v-else-if="failedChapterDetails.length === 0">No failed or omitted chapters remain.</span>
              <div v-for="(chapter, index) in failedChapterDetails" :key="`${chapter.url}-${index}`">
                <strong>{{ chapter.title || `Chapter ${index + 1}` }}</strong>
                <span class="queue-item-failure-url">{{ chapter.url }}</span>
                <span v-if="chapter.omitted" class="queue-item-failure-status">
                  Omitted under job policy · HTTP {{ chapter.httpStatus ?? 'unknown' }}
                </span>
                <span v-else-if="chapter.httpStatus" class="queue-item-failure-status">
                  HTTP {{ chapter.httpStatus }}
                </span>
                <span class="queue-item-failure-error">{{ chapter.error }}</span>
              </div>
            </div>
          </div>
      <span class="history-status" :class="`status-${item.status}`">
        <i v-if="item.status === 'discovering' && item.downloadOptions" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
        {{ item.status === 'discovering' && item.downloadOptions ? 'rechecking chapters' : item.status.replace('-', ' ') }}
      </span>
      <div class="queue-item-actions">
        <div class="queue-item-buttons">
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            icon="pi pi-bolt"
            title="Queue EPUB"
            :aria-label="`Queue EPUB for ${item.title}`"
            size="small"
            :loading="downloadActionId === item.id"
            :disabled="!outputDirectory || Boolean(downloadActionId) || batchQueueing || batchAccepting || !hasQueueableChapters(item)"
            @click="queueOneRecommendedEpub(item)"
          />
          <Button
            v-if="item.status === 'needs-review'"
            icon="pi pi-check"
            title="Accept suggestions"
            :aria-label="`Accept chapter suggestions for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :disabled="Boolean(downloadActionId) || batchQueueing"
            @click="acceptRecommendations(item)"
          />
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            icon="pi pi-eye"
            title="Review chapters"
            :aria-label="`Review chapters for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :disabled="Boolean(downloadActionId) || batchQueueing"
            @click="openQueueItem(item)"
          />
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            icon="pi pi-refresh"
            title="Refresh discovery"
            :aria-label="`Refresh discovery for ${item.title}`"
            size="small"
            severity="secondary"
            text
            :loading="refreshingId === item.id"
            :disabled="Boolean(refreshingId) || Boolean(retryingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="refreshItem(item)"
          />
          <Button
            v-else-if="['failed', 'cancelled'].includes(item.status) && !item.downloadOptions"
            icon="pi pi-refresh"
            title="Retry scan"
            :aria-label="`Retry chapter scan for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :loading="retryingId === item.id"
            :disabled="Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || Boolean(cancelingDiscoveryId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="retryItem(item)"
          />
          <Button
            v-if="item.status === 'discovering' && !item.downloadOptions"
            icon="pi pi-refresh"
            title="Force retry discovery"
            :aria-label="`Force retry discovery for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :loading="retryingId === item.id"
            :disabled="Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || Boolean(cancelingDiscoveryId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="forceRetryItem(item)"
          />
          <template v-if="['failed', 'cancelled'].includes(item.status) && !item.downloadOptions">
            <Button
              icon="pi pi-external-link"
              size="small"
              severity="secondary"
              text
              class="queue-item-browser-action"
              title="Open verification browser"
              :aria-label="`Open verification browser for ${item.title}`"
              :loading="browserOpeningId === item.id"
              :disabled="Boolean(browserOpeningId) || Boolean(browserRetryingId) || Boolean(retryingId) || Boolean(downloadActionId)"
              @click="openItemInBrowser(item)"
            />
            <Button
              icon="pi pi-globe"
              title="Retry using browser"
              :aria-label="`Retry ${item.title} using browser`"
              size="small"
              severity="secondary"
              outlined
              :loading="browserRetryingId === item.id"
              :disabled="browserReadyId !== item.id || Boolean(browserRetryingId) || Boolean(browserOpeningId) || Boolean(retryingId) || Boolean(downloadActionId)"
              @click="retryItemWithBrowser(item)"
            />
          </template>
          <Button
            v-if="item.status === 'discovering'"
            icon="pi pi-times"
            title="Cancel discovery"
            :aria-label="`Cancel discovery for ${item.title}`"
            size="small"
            severity="danger"
            text
            :loading="cancelingDiscoveryId === item.id"
            :disabled="Boolean(cancelingDiscoveryId) || Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="cancelQueueDiscovery(item)"
          />
          <Button
            v-if="item.status === 'packaging-failed'"
            icon="pi pi-box"
            title="Retry packaging"
            :aria-label="`Retry packaging for ${item.title}`"
            size="small"
            severity="warning"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="repackageOffline(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed', 'cancelled'].includes(item.status)"
            icon="pi pi-refresh"
            title="Retry download"
            :aria-label="`Retry download for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'retry')"
          />
          <Button
            v-if="item.status === 'failed' && item.recoveryReason === 'missing-history'"
            icon="pi pi-refresh"
            title="Restore saved job and retry"
            :aria-label="`Restore saved job and retry ${item.title}`"
            size="small"
            severity="warning"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="recoverQueueItem(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed', 'cancelled'].includes(item.status)"
            icon="pi pi-save"
            title="Save available chapters"
            :aria-label="`Save available chapters for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="saveAvailableChapters(item)"
          />
          <Button
            v-if="item.downloadOptions && item.failedChapterCount === 0 && ['failed', 'partially-completed', 'cancelled'].includes(item.status)"
            icon="pi pi-box"
            title="Repackage offline"
            :aria-label="`Repackage ${item.title} offline`"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="repackageOffline(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed', 'paused', 'cancelled'].includes(item.status)"
            icon="pi pi-external-link"
            size="small"
            severity="secondary"
            text
            class="queue-item-browser-action"
            title="Open verification browser"
            :aria-label="`Open verification browser for ${item.title}`"
            :loading="browserOpeningId === item.id"
            :disabled="Boolean(browserOpeningId) || Boolean(browserRetryingId) || Boolean(downloadActionId)"
            @click="openItemInBrowser(item)"
          />
          <Button
            v-if="item.status === 'queued' || item.status === 'downloading'"
            icon="pi pi-pause"
            title="Pause download"
            :aria-label="`Pause download for ${item.title}`"
            size="small"
            severity="secondary"
            text
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'pause')"
          />
          <template v-if="item.status === 'queued'">
            <Button
              icon="pi pi-angle-double-up"
              severity="secondary"
              text
              rounded
              size="small"
              aria-label="Move to top of queue"
              title="Move to top of queue"
              :disabled="queuedItems.findIndex((queued) => queued.id === item.id) === 0 || Boolean(downloadActionId)"
              @click="moveQueuedJob(item, 'top')"
            />
            <Button
              icon="pi pi-arrow-up"
              severity="secondary"
              text
              rounded
              size="small"
              aria-label="Move up in queue"
              title="Move up"
              :disabled="queuedItems.findIndex((queued) => queued.id === item.id) === 0 || Boolean(downloadActionId)"
              @click="moveQueuedJob(item, 'up')"
            />
            <Button
              icon="pi pi-arrow-down"
              severity="secondary"
              text
              rounded
              size="small"
              aria-label="Move down in queue"
              title="Move down"
              :disabled="queuedItems.findIndex((queued) => queued.id === item.id) === queuedItems.length - 1 || Boolean(downloadActionId)"
              @click="moveQueuedJob(item, 'down')"
            />
            <Button
              icon="pi pi-angle-double-down"
              severity="secondary"
              text
              rounded
              size="small"
              aria-label="Move to bottom of queue"
              title="Move to bottom of queue"
              :disabled="queuedItems.findIndex((queued) => queued.id === item.id) === queuedItems.length - 1 || Boolean(downloadActionId)"
              @click="moveQueuedJob(item, 'bottom')"
            />
          </template>
          <Button
            v-if="item.status === 'paused'"
            icon="pi pi-play"
            title="Resume download"
            :aria-label="`Resume download for ${item.title}`"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'resume')"
          />
          <Button
            v-if="item.status === 'queued' || item.status === 'downloading' || item.status === 'paused'"
            icon="pi pi-times"
            title="Cancel download"
            :aria-label="`Cancel download for ${item.title}`"
            size="small"
            severity="danger"
            text
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'cancel')"
          />
          <Button
            icon="pi pi-times"
            title="Remove from queue"
            :aria-label="`Remove ${item.title} from queue`"
            size="small"
            severity="danger"
            text
            :loading="removingId === item.id"
            :disabled="['discovering', 'queued', 'downloading', 'paused'].includes(item.status) || Boolean(removingId) || Boolean(refreshingId) || Boolean(retryingId) || Boolean(downloadActionId) || clearing || batchQueueing"
            @click="removeItem(item)"
          />
        </div>
      </div>
      <ProgressBar
        v-if="item.downloadOptions && item.progress && item.progress.total > 0 && ['queued', 'downloading', 'paused', 'partially-completed'].includes(item.status)"
        :value="Math.round((item.progress.current / item.progress.total) * 100)"
        :show-value="false"
        class="queue-item-progress"
        :aria-label="`${item.title} download progress`"
      />
    </div>
    <Button
      v-if="visibleQueueItems(group).length < group.items.length"
      icon="pi pi-chevron-down"
      :title="`Show ${Math.min(QUEUE_ITEMS_PER_PAGE, group.items.length - visibleQueueItems(group).length)} more queue items`"
      :aria-label="`Show ${Math.min(QUEUE_ITEMS_PER_PAGE, group.items.length - visibleQueueItems(group).length)} more queue items`"
      severity="secondary"
      text
      size="small"
      class="queue-show-more"
      @click="showMoreQueueItems(group.status, group.items.length)"
    />
      </details>
    </template>
  </section>
</template>
