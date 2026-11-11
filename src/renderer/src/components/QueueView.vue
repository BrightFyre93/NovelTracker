<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import type { DiscoveryQueueInput, DiscoveryQueueItem, TrackerNovel } from '../../../shared/contracts'

const emit = defineEmits<{
  openItem: [item: DiscoveryQueueItem]
}>()

const items = ref<DiscoveryQueueItem[]>([])
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
const retryingId = ref('')
const refreshingId = ref('')
const removingId = ref('')
const clearing = ref(false)
const error = ref('')
const notice = ref('')
let removeQueueListener: (() => void) | undefined

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
  removeQueueListener = window.novelTracker.onDiscoveryQueueUpdate((updatedItems) => {
    items.value = updatedItems
  })
  void refreshQueue()
})

onUnmounted(() => removeQueueListener?.())

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
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    adding.value = false
  }
}

async function retryItem(item: DiscoveryQueueItem): Promise<void> {
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

async function refreshItem(item: DiscoveryQueueItem): Promise<void> {
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

async function removeItem(item: DiscoveryQueueItem): Promise<void> {
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
  if (items.value.some((item) => item.status === 'discovering')) {
    error.value = 'Wait for all discoveries to finish before clearing the queue.'
    return
  }
  if (!window.confirm(`Remove all ${items.value.length} saved discovery items? This cannot be undone.`)) return
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
</script>

<template>
  <section class="intro">
    <p class="eyebrow">LIVE CHAPTER DISCOVERY</p>
    <h2>Build a persistent novel queue</h2>
    <p>Add tracker entries or paste multiple URLs. Discovery runs in the background and survives navigation or app restart.</p>
  </section>

  <section class="card queue-intake" aria-labelledby="queue-intake-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">ADD NOVELS</p>
        <h3 id="queue-intake-heading">Queue sources for discovery</h3>
      </div>
      <Button
        label="Add from Tracker"
        icon="pi pi-list"
        severity="secondary"
        outlined
        :loading="trackerLoading"
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

    <div v-if="trackerVisible" class="tracker-picker">
      <div class="tracker-picker-heading">
        <div>
          <h4>Select tracker novels</h4>
          <p>CSV access is read-only. Source requests begin only after adding selections to the queue.</p>
        </div>
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
          {{ trackerNovels.length ? 'No matching tracker rows.' : 'No tracker rows loaded. Configure a CSV in Library settings.' }}
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
        <h3 id="discovery-queue-heading">Discovery status</h3>
      </div>
      <div class="queue-header-actions">
        <Button label="Reload saved queue" icon="pi pi-refresh" severity="secondary" text :loading="loading" @click="refreshQueue" />
        <Button
          label="Clear queue"
          icon="pi pi-trash"
          severity="danger"
          text
          :loading="clearing"
          :disabled="items.length === 0 || clearing || items.some((item) => item.status === 'discovering')"
          @click="clearQueue"
        />
      </div>
    </div>
    <p v-if="loading && items.length === 0" class="help-text">Loading saved queue…</p>
    <p v-else-if="items.length === 0" class="empty-state">No novels queued. Add a tracker selection or one or more URLs above.</p>
    <div v-for="item in items" :key="item.id" class="queue-item">
      <div class="queue-item-summary">
        <strong>{{ item.title }}</strong>
        <span>{{ item.origin === 'tracker' ? 'Tracker' : 'Manual URL' }} · {{ sourceHost(item.sourceUrl) }}</span>
        <span v-if="item.chapters.length">
          {{ item.chapters.length.toLocaleString() }} chapters
          <template v-if="item.chapters[item.chapters.length - 1]"> · latest: {{ item.chapters[item.chapters.length - 1].title }}</template>
        </span>
        <span v-if="item.discoveredAt">Discovered {{ new Date(item.discoveredAt).toLocaleString() }}</span>
        <span v-if="item.discoveryChanges" class="queue-item-change">{{ item.discoveryChanges }}</span>
        <span v-if="item.error" class="queue-item-error">{{ item.error }}</span>
      </div>
      <span class="history-status" :class="`status-${item.status}`">{{ item.status.replace('-', ' ') }}</span>
      <div class="queue-item-actions">
        <div class="queue-item-buttons">
          <Button
            v-if="item.status === 'needs-review'"
            label="Review chapters"
            size="small"
            severity="secondary"
            outlined
            @click="emit('openItem', item)"
          />
          <Button
            v-if="item.status === 'needs-review'"
            label="Refresh chapters"
            icon="pi pi-refresh"
            size="small"
            severity="secondary"
            text
            :loading="refreshingId === item.id"
            :disabled="Boolean(refreshingId) || Boolean(retryingId) || Boolean(removingId) || clearing"
            @click="refreshItem(item)"
          />
          <Button
            v-else-if="item.status === 'failed'"
            label="Retry discovery"
            size="small"
            severity="secondary"
            outlined
            :loading="retryingId === item.id"
            :disabled="Boolean(retryingId) || Boolean(refreshingId) || Boolean(removingId) || clearing"
            @click="retryItem(item)"
          />
          <span v-else class="help-text">Discovering…</span>
          <Button
            label="Remove"
            icon="pi pi-times"
            size="small"
            severity="danger"
            text
            :loading="removingId === item.id"
            :disabled="item.status === 'discovering' || Boolean(removingId) || Boolean(refreshingId) || Boolean(retryingId) || clearing"
            @click="removeItem(item)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
