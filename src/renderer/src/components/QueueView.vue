<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import ProgressBar from 'primevue/progressbar'
import type {
  DiscoveryQueueInput,
  DiscoveryQueueItem,
  DiscoveryQueueItemSummary,
  DiscoveryQueueStatus,
  GenerateEpubInput,
  TrackerNovel
} from '../../../shared/contracts'

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
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' }
]
const queueViewPreferencesKey = 'novel-tracker.queue-view-preferences'

const items = ref<DiscoveryQueueItemSummary[]>([])
const selectedQueueStatuses = ref<DiscoveryQueueStatus[]>([])
const collapsedQueueStatuses = ref<DiscoveryQueueStatus[]>([])
const selectedQueueItemIds = ref<string[]>([])
const trackerNovels = ref<TrackerNovel[]>([])
const trackerVisible = ref(false)
const trackerLoading = ref(false)
const trackerSearch = ref('')
const trackerSources = ref<Record<string, string>>({})
const selectedTrackerIds = ref<string[]>([])
const trackerCsvPath = ref('')
const manualUrls = ref('')
const loading = ref(true)
const adding = ref(false)
const maxDownloads = ref(2)
const outputDirectory = ref('')
const retryingId = ref('')
const browserOpeningId = ref('')
const browserRetryingId = ref('')
const browserReadyId = ref('')
const refreshingId = ref('')
const removingId = ref('')
const downloadActionId = ref('')
const batchQueueing = ref(false)
const clearing = ref(false)
const clearingCompleted = ref(false)
const error = ref('')
const notice = ref('')
let removeQueueListener: (() => void) | undefined
loadQueueViewPreferences()

const filteredTrackerNovels = computed(() => {
  const query = trackerSearch.value.trim().toLocaleLowerCase()
  const matches = query
    ? trackerNovels.value.filter((novel) =>
        `${novel.title} ${novel.siteTitle} ${novel.author} ${novel.alternativeNames}`
          .toLocaleLowerCase()
          .includes(query)
      )
    : trackerNovels.value
  return matches.slice(0, 100)
})
const activeDownloadCount = computed(() => items.value.filter((item) => item.status === 'downloading').length)
const completedQueueCount = computed(() => items.value.filter((item) => item.status === 'completed').length)
const queuedItems = computed(() =>
  items.value
    .filter((item) => item.status === 'queued' && item.downloadOptions)
    .sort(compareQueuedItems)
)
const batchQueueableItems = computed(() =>
  items.value.filter((item) =>
    (item.status === 'needs-review' || item.status === 'ready') &&
    (
      item.status === 'ready'
        ? item.chapterSummary.selected > 0
        : item.chapterSummary.recommended > 0 ||
          (item.includeOverlap && item.overlapAllowed && item.overlapCount > 0)
    ) &&
    !item.chapterSummary.hasUncertainArchiveChapters
  )
)
const batchAcceptableItems = computed(() =>
  items.value.filter(
    (item) =>
      item.status === 'needs-review' &&
      !item.chapterSummary.hasUncertainArchiveChapters
  )
)
const batchAccepting = ref(false)
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
  batchQueueableItems.value.filter((item) => selectedQueueItemIds.value.includes(item.id))
)
const allVisibleQueueSectionsCollapsed = computed(() =>
  queueGroups.value.length > 0 &&
  queueGroups.value.every((group) => isQueueSectionCollapsed(group.status))
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
  return batchQueueableItems.value.some((item) => item.id === itemId)
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
    error.value = `Queue display settings could not be loaded: ${reason instanceof Error ? reason.message : String(reason)}`
  }
}

watch([selectedQueueStatuses, collapsedQueueStatuses], () => {
  try {
    localStorage.setItem(queueViewPreferencesKey, JSON.stringify({
      statuses: selectedQueueStatuses.value,
      collapsedStatuses: collapsedQueueStatuses.value
    }))
  } catch (reason) {
    error.value = `Queue display settings could not be saved: ${reason instanceof Error ? reason.message : String(reason)}`
  }
}, { deep: true, flush: 'sync' })

function compareQueuedItems(left: DiscoveryQueueItemSummary, right: DiscoveryQueueItemSummary): number {
  return left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id)
}

function compareQueueItemsByTitle(left: DiscoveryQueueItemSummary, right: DiscoveryQueueItemSummary): number {
  return left.title.localeCompare(right.title, 'en', { numeric: true, sensitivity: 'base' }) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
}

function hasQueueableChapters(item: DiscoveryQueueItemSummary): boolean {
  if (item.status === 'ready') return item.chapterSummary.selected > 0
  return (
    item.chapterSummary.recommended > 0 ||
    (item.includeOverlap && item.overlapAllowed && item.overlapCount > 0)
  )
}

function chaptersRemaining(item: DiscoveryQueueItemSummary): number | null {
  if (!item.progress || item.progress.total <= 0) return null
  return Math.max(0, item.progress.total - item.progress.current)
}

async function refreshQueue(): Promise<void> {
  loading.value = true
  try {
    items.value = await window.novelTracker.getDiscoveryQueue()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', closeQueueStatusFilterOnOutsideClick)
  removeQueueListener = window.novelTracker.onDiscoveryQueueUpdate((updatedItems) => {
    items.value = updatedItems
  })
  void refreshQueue()
  void window.novelTracker.getSettings().then((settings) => {
    maxDownloads.value = settings.maxSimultaneousDownloads
    outputDirectory.value = settings.outputDirectory
  }).catch((reason: unknown) => {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
        origin: 'manual'
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
    const summary = result.value.length
      ? `Added ${result.value.length} item${result.value.length === 1 ? '' : 's'} for live discovery.`
      : 'All selected sources are already in the queue.'
    notice.value = duplicateCount > 0 ? `${summary} ${duplicateCount} duplicate source${duplicateCount === 1 ? '' : 's'} skipped.` : summary
    if (rejectedRows.length > 0) {
      notice.value += ` No valid source selected for: ${rejectedRows.join(', ')}.`
    }
    manualUrls.value = invalidManualLines.join('\n')
    selectedTrackerIds.value = []
    trackerVisible.value = false
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    retryingId.value = ''
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    const result = await window.novelTracker.openVerificationBrowser(item.sourceUrl)
    if (!result.ok) {
      error.value = result.error
      return
    }
    browserReadyId.value = item.id
    notice.value = `Opened ${item.title} in Chromium. Complete any sign-in or verification manually, then retry using the browser.`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    browserRetryingId.value = ''
  }
}

async function cancelBrowserDiscovery(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  try {
    await window.novelTracker.cancelBrowserDiscovery(item.id)
    notice.value = `Cancelled browser-assisted discovery for ${item.title}.`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    downloadActionId.value = ''
  }
}

function selectedChapters(item: DiscoveryQueueItem) {
  return item.chapters
    .filter((chapter) => chapter.selected)
    .map(({ id, title, url }) => ({ id, title, url }))
}

async function queueRecommendedEpub(item: DiscoveryQueueItemSummary): Promise<string | null> {
  if (item.status === 'needs-review') {
    const accepted = await window.novelTracker.acceptQueueRecommendations(
      item.id,
      item.includeOverlap,
      item.overlapCount
    )
    if (!accepted.ok) return `${item.title}: ${accepted.error}`
  }

  const detail = await window.novelTracker.getDiscoveryQueueItem(item.id)
  if (!detail.ok) return `${item.title}: ${detail.error}`
  const currentItem = detail.value
  const chapters = selectedChapters(currentItem)
  if (chapters.length === 0) return `${item.title}: select at least one chapter before queueing.`

  const input: GenerateEpubInput = {
    title: currentItem.title,
    author: currentItem.author,
    description: currentItem.description,
    coverUrl: currentItem.coverUrl,
    alternativeNames: [...currentItem.alternativeNames],
    genres: [...currentItem.genres],
    source: currentItem.source,
    novelStatus: currentItem.novelStatus,
    language: 'en',
    sourceUrl: currentItem.sourceUrl,
    outputDirectory: outputDirectory.value,
    chapters,
    trackerRow: currentItem.trackerRow ? { ...currentItem.trackerRow } : undefined
  }
  const result = await window.novelTracker.enqueueEpub(input, currentItem.id)
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
    notice.value = `Queued suggested chapters for ${item.title}.`
    await refreshQueue()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
        failures.push(`${item.title}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    notice.value = `Queued ${queued} suggested EPUB job${queued === 1 ? '' : 's'}.`
    if (failures.length) error.value = failures.join(' ')
    await refreshQueue()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
        failures.push(`${item.title}: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    }
    selectedQueueItemIds.value = []
    notice.value = `Queued ${queued} selected EPUB job${queued === 1 ? '' : 's'}.`
    if (failures.length) error.value = failures.join(' ')
    await refreshQueue()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    downloadActionId.value = ''
  }
}

async function acceptRecommendations(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  try {
    const result = await window.novelTracker.acceptQueueRecommendations(
      item.id,
      item.includeOverlap,
      item.overlapCount
    )
    if (!result.ok) {
      error.value = result.error
      return
    }
    notice.value = `Applied archive-aware suggestions for ${item.title}. Review the selected chapters before queueing the EPUB.`
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function acceptSafeSuggestions(): Promise<void> {
  error.value = ''
  notice.value = ''
  batchAccepting.value = true
  let applied = 0
  try {
    for (const item of batchAcceptableItems.value) {
      const result = await window.novelTracker.acceptQueueRecommendations(
        item.id,
        item.includeOverlap,
        item.overlapCount
      )
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
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    batchAccepting.value = false
  }
}

async function refreshItem(item: DiscoveryQueueItemSummary): Promise<void> {
  error.value = ''
  notice.value = ''
  refreshingId.value = item.id
  try {
    const result = await window.novelTracker.refreshDiscoveryQueueItem(item.id)
    if (!result.ok) error.value = result.error
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
    error.value = reason instanceof Error ? reason.message : String(reason)
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
        :label="trackerVisible ? 'Hide Tracker' : 'Add from Tracker'"
        :icon="trackerVisible ? 'pi pi-chevron-up' : 'pi pi-list'"
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
    <p class="help-text">Paste one HTTP or HTTPS URL per line. Duplicate source URLs are skipped.</p>

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
        label="Add selected to queue"
        icon="pi pi-plus"
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
          :label="String(batchQueueableItems.length)"
          icon="pi pi-bolt"
          size="small"
          text
          rounded
          aria-label="Queue all safe suggestions"
          title="Queue all safe suggestions"
          :loading="batchQueueing"
          :disabled="!outputDirectory || batchQueueableItems.length === 0 || batchQueueing || batchAccepting || Boolean(downloadActionId)"
          @click="queueAllRecommendedEpubs"
        />
        <Button
          :label="String(batchAcceptableItems.length)"
          icon="pi pi-check"
          severity="secondary"
          text
          rounded
          aria-label="Accept all safe suggestions"
          title="Accept all safe suggestions"
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
          label="Clear completed"
          icon="pi pi-check-circle"
          severity="secondary"
          text
          size="small"
          :loading="clearingCompleted"
          :disabled="completedQueueCount === 0 || clearing || clearingCompleted || batchQueueing"
          @click="clearCompletedQueueItems"
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
            label="Clear filters"
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
        :label="allVisibleQueueSectionsCollapsed ? 'Expand all' : 'Collapse all'"
        :icon="allVisibleQueueSectionsCollapsed ? 'pi pi-window-maximize' : 'pi pi-window-minimize'"
        severity="secondary"
        text
        size="small"
        @click="toggleAllQueueSections"
      />
      <Button
        label="Select eligible"
        icon="pi pi-check-square"
        severity="secondary"
        text
        size="small"
        :disabled="filteredQueueItems.every((item) => !isQueueItemSelectable(item.id))"
        @click="selectVisibleQueueableItems"
      />
      <Button
        :label="`Queue selected (${selectedQueueableItems.length})`"
        icon="pi pi-bolt"
        size="small"
        :disabled="!outputDirectory || !selectedQueueableItems.length || batchQueueing || batchAccepting || Boolean(downloadActionId)"
        @click="queueSelectedEpubs"
      />
      <Button
        v-if="selectedQueueItemIds.length"
        label="Clear selection"
        severity="secondary"
        text
        size="small"
        @click="selectedQueueItemIds = []"
      />
      <span class="queue-visible-count">Showing {{ filteredQueueItems.length }} of {{ items.length }}</span>
    </div>
    <p v-if="!outputDirectory" class="help-text">Choose an EPUB output folder in Configuration to queue downloads.</p>
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
        <div v-for="item in group.items" :key="item.id" class="queue-item">
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
              <span>{{ item.origin === 'tracker' ? 'Tracker' : 'Manual URL' }} · {{ sourceHost(item.sourceUrl) }}</span>
            </div>
            <span v-if="item.chapterSummary.total">
              {{ item.chapterSummary.selected.toLocaleString() }} selected ·
              {{ (item.chapterSummary.recommended + (item.includeOverlap ? item.chapterSummary.deliberateOverlap : 0)).toLocaleString() }} suggested of {{ item.chapterSummary.total.toLocaleString() }}
              <template v-if="item.chapterSummary.latestTitle"> · latest: {{ item.chapterSummary.latestTitle }}</template>
            </span>
            <span v-if="item.downloadOptions && ['queued', 'downloading', 'paused'].includes(item.status) && chaptersRemaining(item) !== null" class="queue-remaining-chapters">
              {{ chaptersRemaining(item)?.toLocaleString() }} chapters left ·
              {{ item.progress?.current.toLocaleString() }} of {{ item.progress?.total.toLocaleString() }} complete
            </span>
            <span v-if="item.recommendationSummary" class="queue-item-recommendation">{{ item.recommendationSummary }}</span>
            <span
              v-if="item.repackageOnly && ['queued', 'downloading'].includes(item.status)"
              class="queue-item-rechecking"
            >
              <i class="pi pi-box" aria-hidden="true"></i>
              Offline repackaging from saved content — no network requests
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
            <span v-else-if="item.progress">{{ item.progress.current }} / {{ item.progress.total }} chapters · {{ item.progress.message }}</span>
            <span v-if="item.discoveredAt">Discovered {{ new Date(item.discoveredAt).toLocaleString() }}</span>
            <span v-if="item.discoveryChanges" class="queue-item-change">{{ item.discoveryChanges }}</span>
            <span v-if="item.outputPath" class="queue-item-output">{{ item.outputPath }}</span>
            <span v-if="item.failedChapterCount" class="queue-item-error">
              {{ item.failedChapterCount.toLocaleString() }} chapter{{ item.failedChapterCount === 1 ? '' : 's' }} failed
            </span>
            <span v-else-if="item.error" class="queue-item-error">{{ item.error }}</span>
          </div>
      <span class="history-status" :class="`status-${item.status}`">
        <i v-if="item.status === 'discovering' && item.downloadOptions" class="pi pi-spin pi-spinner" aria-hidden="true"></i>
        {{ item.status === 'discovering' && item.downloadOptions ? 'rechecking chapters' : item.status.replace('-', ' ') }}
      </span>
      <div class="queue-item-actions">
        <div class="queue-item-buttons">
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            label="Queue EPUB"
            icon="pi pi-bolt"
            size="small"
            :loading="downloadActionId === item.id"
            :disabled="!outputDirectory || Boolean(downloadActionId) || batchQueueing || batchAccepting || !hasQueueableChapters(item)"
            @click="queueOneRecommendedEpub(item)"
          />
          <label v-if="item.status === 'needs-review' || item.status === 'ready'" class="overlap-control">
            <input v-model="item.includeOverlap" type="checkbox" :disabled="!item.overlapAllowed" />
            <span>Include overlap</span>
            <input
              v-model.number="item.overlapCount"
              type="number"
              min="0"
              max="1000"
              aria-label="Overlap chapter count"
              :disabled="!item.includeOverlap || !item.overlapAllowed"
            />
          </label>
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            label="Suggest"
            icon="pi pi-check"
            size="small"
            severity="secondary"
            outlined
            :disabled="Boolean(downloadActionId) || batchQueueing"
            @click="acceptRecommendations(item)"
          />
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            label="Review"
            size="small"
            severity="secondary"
            outlined
            :disabled="Boolean(downloadActionId) || batchQueueing"
            @click="openQueueItem(item)"
          />
          <Button
            v-if="item.status === 'needs-review' || item.status === 'ready'"
            label="Refresh"
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            text
            :loading="refreshingId === item.id"
            :disabled="Boolean(refreshingId) || Boolean(retryingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="refreshItem(item)"
          />
          <Button
            v-else-if="item.status === 'failed' && !item.downloadOptions"
            label="Retry scan"
            size="small"
            severity="secondary"
            outlined
            :loading="retryingId === item.id"
            :disabled="Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="retryItem(item)"
          />
          <Button
            v-if="item.status === 'discovering' && !item.downloadOptions"
            label="Force retry"
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            outlined
            :loading="retryingId === item.id"
            :disabled="Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || clearing || batchQueueing || Boolean(downloadActionId)"
            @click="forceRetryItem(item)"
          />
          <template v-if="item.status === 'failed' && !item.downloadOptions">
            <Button
              label="Open verification browser"
              icon="pi pi-external-link"
              size="small"
              severity="secondary"
              text
              :loading="browserOpeningId === item.id"
              :disabled="Boolean(browserOpeningId) || Boolean(browserRetryingId) || Boolean(retryingId) || Boolean(downloadActionId)"
              @click="openItemInBrowser(item)"
            />
            <Button
              label="Retry in browser"
              icon="pi pi-globe"
              size="small"
              severity="secondary"
              outlined
              :loading="browserRetryingId === item.id"
              :disabled="browserReadyId !== item.id || Boolean(browserRetryingId) || Boolean(browserOpeningId) || Boolean(retryingId) || Boolean(downloadActionId)"
              @click="retryItemWithBrowser(item)"
            />
          </template>
          <Button
            v-if="item.status === 'discovering' && browserReadyId === item.id"
            label="Cancel browser discovery"
            icon="pi pi-times"
            size="small"
            severity="danger"
            text
            @click="cancelBrowserDiscovery(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed', 'cancelled'].includes(item.status)"
            label="Retry"
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'retry')"
          />
          <Button
            v-if="item.status === 'failed' && /history entry is missing/i.test(item.error)"
            label="Restore & retry"
            icon="pi pi-refresh"
            size="small"
            severity="warning"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="recoverQueueItem(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed', 'cancelled'].includes(item.status)"
            label="Repackage offline"
            icon="pi pi-box"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="repackageOffline(item)"
          />
          <Button
            v-if="item.downloadOptions && ['failed', 'partially-completed'].includes(item.status)"
            label="Open verification browser"
            icon="pi pi-external-link"
            size="small"
            severity="secondary"
            text
            :loading="browserOpeningId === item.id"
            :disabled="Boolean(browserOpeningId) || Boolean(browserRetryingId) || Boolean(downloadActionId)"
            @click="openItemInBrowser(item)"
          />
          <Button
            v-if="item.status === 'queued' || item.status === 'downloading'"
            label="Pause"
            icon="pi pi-pause"
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
            label="Resume"
            icon="pi pi-play"
            size="small"
            severity="secondary"
            outlined
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'resume')"
          />
          <Button
            v-if="item.status === 'queued' || item.status === 'downloading' || item.status === 'paused'"
            label="Cancel"
            icon="pi pi-times"
            size="small"
            severity="danger"
            text
            :loading="downloadActionId === item.id"
            :disabled="Boolean(downloadActionId)"
            @click="runDownloadAction(item, 'cancel')"
          />
          <Button
            label="Remove"
            icon="pi pi-times"
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
      </details>
    </template>
  </section>
</template>
