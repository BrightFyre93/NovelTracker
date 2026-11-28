<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import type { AppSettings } from '../../../shared/contracts'
import {
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_DOWNLOAD_RETRY_ATTEMPTS,
  MAX_HTTP_CONNECT_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DISCOVERIES,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_DOWNLOAD_RETRY_ATTEMPTS,
  MIN_HTTP_CONNECT_TIMEOUT_MS,
  MIN_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DISCOVERIES,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../../../shared/constants'
import {
  numberRange,
  syncDraft,
  useSettingsSave,
  type SettingsSectionEvents
} from '../composables/useSettingsSave'

const props = defineProps<{ settings: AppSettings }>()
const emit = defineEmits<SettingsSectionEvents>()
const { saving, save } = useSettingsSave(
  (settings, message) => emit('saved', settings, message),
  (message) => emit('failed', message)
)

const concurrencyOptions = numberRange(MIN_SIMULTANEOUS_DOWNLOADS, MAX_SIMULTANEOUS_DOWNLOADS)
const discoveryConcurrencyOptions = numberRange(MIN_SIMULTANEOUS_DISCOVERIES, MAX_SIMULTANEOUS_DISCOVERIES)
const chapterConcurrencyOptions = numberRange(
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL
)
const retryAttemptOptions = numberRange(MIN_DOWNLOAD_RETRY_ATTEMPTS, MAX_DOWNLOAD_RETRY_ATTEMPTS)

const concurrencyDraft = ref(props.settings.maxSimultaneousDownloads)
const discoveryConcurrencyDraft = ref(props.settings.maxSimultaneousDiscoveries)
const chapterConcurrencyDraft = ref(props.settings.maxSimultaneousChaptersPerNovel)
const retryAttemptsDraft = ref(props.settings.maxDownloadRetryAttempts)
const omitHttp404Draft = ref(props.settings.omitHttp404Chapters)
const connectTimeoutSecondsDraft = ref(props.settings.httpConnectTimeoutMs / 1000)
const responseTimeoutSecondsDraft = ref(props.settings.httpResponseReadTimeoutMs / 1000)
const freshnessHoursDraft = ref(props.settings.discoveryFreshnessHours)
const themeDraft = ref(props.settings.appTheme)

syncDraft(() => props.settings.maxSimultaneousDownloads, concurrencyDraft)
syncDraft(() => props.settings.maxSimultaneousDiscoveries, discoveryConcurrencyDraft)
syncDraft(() => props.settings.maxSimultaneousChaptersPerNovel, chapterConcurrencyDraft)
syncDraft(() => props.settings.maxDownloadRetryAttempts, retryAttemptsDraft)
syncDraft(() => props.settings.omitHttp404Chapters, omitHttp404Draft)
syncDraft(() => props.settings.httpConnectTimeoutMs / 1000, connectTimeoutSecondsDraft)
syncDraft(() => props.settings.httpResponseReadTimeoutMs / 1000, responseTimeoutSecondsDraft)
syncDraft(() => props.settings.discoveryFreshnessHours, freshnessHoursDraft)
syncDraft(() => props.settings.appTheme, themeDraft)

const concurrencyDirty = computed(() => concurrencyDraft.value !== props.settings.maxSimultaneousDownloads)
const discoveryConcurrencyDirty = computed(
  () => discoveryConcurrencyDraft.value !== props.settings.maxSimultaneousDiscoveries
)
const chapterConcurrencyDirty = computed(
  () => chapterConcurrencyDraft.value !== props.settings.maxSimultaneousChaptersPerNovel
)
const retryAttemptsDirty = computed(() => retryAttemptsDraft.value !== props.settings.maxDownloadRetryAttempts)
const omitHttp404Dirty = computed(() => omitHttp404Draft.value !== props.settings.omitHttp404Chapters)
const requestTimeoutsDirty = computed(
  () =>
    connectTimeoutSecondsDraft.value * 1000 !== props.settings.httpConnectTimeoutMs ||
    responseTimeoutSecondsDraft.value * 1000 !== props.settings.httpResponseReadTimeoutMs
)
const freshnessDirty = computed(() => freshnessHoursDraft.value !== props.settings.discoveryFreshnessHours)
const themeDirty = computed(() => themeDraft.value !== props.settings.appTheme)

const freshnessValid = computed(
  () =>
    Number.isInteger(freshnessHoursDraft.value) &&
    freshnessHoursDraft.value >= MIN_DISCOVERY_FRESHNESS_HOURS &&
    freshnessHoursDraft.value <= MAX_DISCOVERY_FRESHNESS_HOURS
)
const requestTimeoutsValid = computed(
  () =>
    Number.isInteger(connectTimeoutSecondsDraft.value) &&
    connectTimeoutSecondsDraft.value >= MIN_HTTP_CONNECT_TIMEOUT_MS / 1000 &&
    connectTimeoutSecondsDraft.value <= MAX_HTTP_CONNECT_TIMEOUT_MS / 1000 &&
    Number.isInteger(responseTimeoutSecondsDraft.value) &&
    responseTimeoutSecondsDraft.value >= MIN_HTTP_RESPONSE_READ_TIMEOUT_MS / 1000 &&
    responseTimeoutSecondsDraft.value <= MAX_HTTP_RESPONSE_READ_TIMEOUT_MS / 1000
)

const saveConcurrency = (): Promise<unknown> =>
  save('concurrency', { maxSimultaneousDownloads: concurrencyDraft.value }, 'Download concurrency saved.')
const saveDiscoveryConcurrency = (): Promise<unknown> =>
  save(
    'discoveryConcurrency',
    { maxSimultaneousDiscoveries: discoveryConcurrencyDraft.value },
    'Discovery concurrency saved.'
  )
const saveChapterConcurrency = (): Promise<unknown> =>
  save(
    'chapterConcurrency',
    { maxSimultaneousChaptersPerNovel: chapterConcurrencyDraft.value },
    'Per-novel chapter concurrency saved.'
  )
const saveRetryAttempts = (): Promise<unknown> =>
  save('retryAttempts', { maxDownloadRetryAttempts: retryAttemptsDraft.value }, 'Download retry attempts saved.')
const saveOmitHttp404 = (): Promise<unknown> =>
  save(
    'omitHttp404',
    { omitHttp404Chapters: omitHttp404Draft.value },
    'HTTP 404 chapter policy saved. It applies to newly queued EPUB jobs.'
  )
const saveRequestTimeouts = (): Promise<unknown> =>
  save(
    'timeouts',
    {
      httpConnectTimeoutMs: connectTimeoutSecondsDraft.value * 1000,
      httpResponseReadTimeoutMs: responseTimeoutSecondsDraft.value * 1000
    },
    'HTTP timeouts saved.'
  )
const saveFreshness = (): Promise<unknown> =>
  save('freshness', { discoveryFreshnessHours: freshnessHoursDraft.value }, 'Chapter-list refresh interval saved.')
const saveTheme = (): Promise<unknown> =>
  save('theme', { appTheme: themeDraft.value }, 'App theme saved.')
</script>

<template>
  <section class="card" aria-labelledby="configuration-queue-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">QUEUE BEHAVIOR</p>
        <h3 id="configuration-queue-heading">Download and discovery settings</h3>
      </div>
    </div>
    <div class="configuration-settings-grid">
      <div class="configuration-setting">
        <label class="field-label" for="download-concurrency">Maximum active novel downloads</label>
        <select id="download-concurrency" v-model.number="concurrencyDraft" class="configuration-select">
          <option v-for="limit in concurrencyOptions" :key="limit" :value="limit">{{ limit }} active novel{{ limit === 1 ? '' : 's' }}</option>
        </select>
        <Button
          icon="pi pi-save"
          title="Save concurrency settings"
          aria-label="Save concurrency settings"
          size="small"
          :loading="saving === 'concurrency'"
          :disabled="saving !== null || !concurrencyDirty"
          @click="saveConcurrency"
        />
      </div>
      <div class="configuration-setting">
        <label class="field-label" for="discovery-concurrency">Maximum simultaneous discoveries</label>
        <select id="discovery-concurrency" v-model.number="discoveryConcurrencyDraft" class="configuration-select">
          <option v-for="limit in discoveryConcurrencyOptions" :key="limit" :value="limit">{{ limit }} novel{{ limit === 1 ? '' : 's' }}</option>
        </select>
        <small class="help-text">Controls how many chapter lists are discovered at once. Same-site requests still share the site's rate limit.</small>
        <Button
          icon="pi pi-save"
          title="Save discovery concurrency settings"
          aria-label="Save discovery concurrency settings"
          size="small"
          :loading="saving === 'discoveryConcurrency'"
          :disabled="saving !== null || !discoveryConcurrencyDirty"
          @click="saveDiscoveryConcurrency"
        />
      </div>
      <div class="configuration-setting">
        <label class="field-label" for="chapter-concurrency">Maximum active chapter requests per novel</label>
        <select id="chapter-concurrency" v-model.number="chapterConcurrencyDraft" class="configuration-select">
          <option v-for="limit in chapterConcurrencyOptions" :key="limit" :value="limit">{{ limit }} chapter{{ limit === 1 ? '' : 's' }}</option>
        </select>
        <small class="help-text">Independent of novel downloads. Same-site requests still share the site's rate limit and a two-request host cap.</small>
        <Button
          icon="pi pi-save"
          title="Save chapter concurrency settings"
          aria-label="Save chapter concurrency settings"
          size="small"
          :loading="saving === 'chapterConcurrency'"
          :disabled="saving !== null || !chapterConcurrencyDirty"
          @click="saveChapterConcurrency"
        />
      </div>
      <div class="configuration-setting">
        <label class="field-label" for="download-retry-attempts">Maximum attempts per chapter or cover</label>
        <select id="download-retry-attempts" v-model.number="retryAttemptsDraft" class="configuration-select">
          <option v-for="attempts in retryAttemptOptions" :key="attempts" :value="attempts">
            {{ attempts }} attempt{{ attempts === 1 ? '' : 's' }}
          </option>
        </select>
        <small class="help-text">Includes the initial request. Transient failures are retried up to this total; permanent errors are not retried.</small>
        <Button
          icon="pi pi-save"
          title="Save retry settings"
          aria-label="Save retry settings"
          size="small"
          :loading="saving === 'retryAttempts'"
          :disabled="saving !== null || !retryAttemptsDirty"
          @click="saveRetryAttempts"
        />
      </div>
      <div class="configuration-setting configuration-setting--compact">
        <label class="configuration-toggle" for="omit-http-404-chapters">
          <input id="omit-http-404-chapters" v-model="omitHttp404Draft" type="checkbox" />
          <span>
            <strong>Allow HTTP 404 chapters to be omitted</strong>
            <small class="help-text">Off by default. When enabled, a 404 is recorded with its chapter URL and status, but no partial EPUB is created automatically. Use “Save available chapters” to explicitly package an incomplete EPUB. Applies to newly queued jobs only.</small>
          </span>
        </label>
        <Button
          icon="pi pi-save"
          title="Save HTTP 404 chapter policy"
          aria-label="Save HTTP 404 chapter policy"
          size="small"
          :loading="saving === 'omitHttp404'"
          :disabled="saving !== null || !omitHttp404Dirty"
          @click="saveOmitHttp404"
        />
      </div>
      <div class="configuration-setting">
        <span class="field-label">HTTP timeouts</span>
        <div class="configuration-inline-control">
          <label for="http-connect-timeout">Connect</label>
          <input
            id="http-connect-timeout"
            v-model.number="connectTimeoutSecondsDraft"
            class="configuration-number"
            type="number"
            :min="MIN_HTTP_CONNECT_TIMEOUT_MS / 1000"
            :max="MAX_HTTP_CONNECT_TIMEOUT_MS / 1000"
            step="1"
          />
          <span>seconds</span>
        </div>
        <div class="configuration-inline-control">
          <label for="http-response-timeout">Response/read</label>
          <input
            id="http-response-timeout"
            v-model.number="responseTimeoutSecondsDraft"
            class="configuration-number"
            type="number"
            :min="MIN_HTTP_RESPONSE_READ_TIMEOUT_MS / 1000"
            :max="MAX_HTTP_RESPONSE_READ_TIMEOUT_MS / 1000"
            step="1"
          />
          <span>seconds</span>
        </div>
        <small class="help-text">Response/read timeout resets whenever data arrives. Allowed range: 1–120 seconds for each timeout.</small>
        <Button
          icon="pi pi-save"
          title="Save HTTP timeout settings"
          aria-label="Save HTTP timeout settings"
          size="small"
          :loading="saving === 'timeouts'"
          :disabled="saving !== null || !requestTimeoutsDirty || !requestTimeoutsValid"
          @click="saveRequestTimeouts"
        />
      </div>
      <div class="configuration-setting">
        <label class="field-label" for="discovery-freshness-hours">Refresh chapter list after</label>
        <div class="configuration-inline-control">
          <input
            id="discovery-freshness-hours"
            v-model.number="freshnessHoursDraft"
            class="configuration-number"
            type="number"
            :min="MIN_DISCOVERY_FRESHNESS_HOURS"
            :max="MAX_DISCOVERY_FRESHNESS_HOURS"
            step="1"
            aria-describedby="discovery-freshness-help"
          />
          <span>hours</span>
        </div>
        <small id="discovery-freshness-help" class="help-text">
          Default is 24 hours. Queued EPUBs refresh before downloading when their chapter list is at least this old (1–720 hours).
        </small>
        <Button
          icon="pi pi-save"
          title="Save chapter-list refresh interval"
          aria-label="Save chapter-list refresh interval"
          size="small"
          :loading="saving === 'freshness'"
          :disabled="saving !== null || !freshnessDirty || !freshnessValid"
          @click="saveFreshness"
        />
      </div>
      <div class="configuration-setting">
        <label class="field-label" for="app-theme">App appearance</label>
        <select id="app-theme" v-model="themeDraft" class="configuration-select">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">Follow the system setting</option>
        </select>
        <Button
          icon="pi pi-save"
          title="Save appearance settings"
          aria-label="Save appearance settings"
          size="small"
          :loading="saving === 'theme'"
          :disabled="saving !== null || !themeDirty"
          @click="saveTheme"
        />
      </div>
    </div>
  </section>
</template>
