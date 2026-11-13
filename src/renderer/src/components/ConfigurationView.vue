<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Message from 'primevue/message'
import type {
  AppSettings,
  SiteExtractionMode,
  SiteExtractionPreference
} from '../../../shared/contracts'
import {
  DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  DEFAULT_EPUB_CSS,
  DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  MAX_DISCOVERY_FRESHNESS_HOURS,
  MAX_EPUB_CSS_LENGTH,
  MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MAX_SIMULTANEOUS_DOWNLOADS,
  MIN_DISCOVERY_FRESHNESS_HOURS,
  MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  MIN_SIMULTANEOUS_DOWNLOADS
} from '../../../shared/constants'
import {
  normalizeSiteExtractionPreferences,
  normalizeSiteHostname
} from '../../../shared/siteExtractionPreferences'

const emit = defineEmits<{
  themeChanged: [theme: AppSettings['appTheme']]
}>()

const settings = ref<AppSettings>({
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: '',
  scanOldFolder: false,
  scanOldCompletedFolder: false,
  maxSimultaneousDownloads: DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  maxSimultaneousChaptersPerNovel: DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  discoveryFreshnessHours: DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  siteExtractionPreferences: [],
  epubCss: DEFAULT_EPUB_CSS,
  appTheme: 'light'
})
const freshnessHoursDraft = ref(DEFAULT_DISCOVERY_FRESHNESS_HOURS)
const concurrencyDraft = ref(DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS)
const chapterConcurrencyDraft = ref(DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL)
const siteExtractionPreferencesDraft = ref<SiteExtractionPreference[]>([])
const sitePreferenceHostnameDraft = ref('')
const sitePreferenceModeDraft = ref<SiteExtractionMode>('generic-html')
const themeDraft = ref<AppSettings['appTheme']>('light')
const epubCssDraft = ref(DEFAULT_EPUB_CSS)
const scanOldFolderDraft = ref(false)
const scanOldCompletedFolderDraft = ref(false)
const concurrencyOptions = Array.from(
  { length: MAX_SIMULTANEOUS_DOWNLOADS - MIN_SIMULTANEOUS_DOWNLOADS + 1 },
  (_, index) => MIN_SIMULTANEOUS_DOWNLOADS + index
)
const chapterConcurrencyOptions = Array.from(
  { length: MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL - MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL + 1 },
  (_, index) => MIN_SIMULTANEOUS_CHAPTERS_PER_NOVEL + index
)
const freshnessDirty = computed(() => freshnessHoursDraft.value !== settings.value.discoveryFreshnessHours)
const concurrencyDirty = computed(() => concurrencyDraft.value !== settings.value.maxSimultaneousDownloads)
const chapterConcurrencyDirty = computed(() =>
  chapterConcurrencyDraft.value !== settings.value.maxSimultaneousChaptersPerNovel
)
const siteExtractionPreferencesDirty = computed(() =>
  JSON.stringify(siteExtractionPreferencesDraft.value) !== JSON.stringify(settings.value.siteExtractionPreferences)
)
const themeDirty = computed(() => themeDraft.value !== settings.value.appTheme)
const epubCssDirty = computed(() => epubCssDraft.value !== settings.value.epubCss)
const libraryScanOptionsDirty = computed(() =>
  scanOldFolderDraft.value !== settings.value.scanOldFolder ||
  scanOldCompletedFolderDraft.value !== settings.value.scanOldCompletedFolder
)
const freshnessValid = computed(() =>
  Number.isInteger(freshnessHoursDraft.value) &&
  freshnessHoursDraft.value >= MIN_DISCOVERY_FRESHNESS_HOURS &&
  freshnessHoursDraft.value <= MAX_DISCOVERY_FRESHNESS_HOURS
)
const error = ref('')
const success = ref('')
const savingFreshness = ref(false)
const savingConcurrency = ref(false)
const savingChapterConcurrency = ref(false)
const savingSiteExtractionPreferences = ref(false)
const savingTheme = ref(false)
const savingEpubCss = ref(false)
const savingLibraryScanOptions = ref(false)

onMounted(async () => {
  try {
    settings.value = await window.novelTracker.getSettings()
    freshnessHoursDraft.value = settings.value.discoveryFreshnessHours
    concurrencyDraft.value = settings.value.maxSimultaneousDownloads
    chapterConcurrencyDraft.value = settings.value.maxSimultaneousChaptersPerNovel
    siteExtractionPreferencesDraft.value = settings.value.siteExtractionPreferences.map((preference) => ({ ...preference }))
    scanOldFolderDraft.value = settings.value.scanOldFolder
    scanOldCompletedFolderDraft.value = settings.value.scanOldCompletedFolder
    themeDraft.value = settings.value.appTheme
    epubCssDraft.value = settings.value.epubCss
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
})

async function chooseLibraryRoot(): Promise<void> {
  error.value = ''
  success.value = ''
  try {
    const directory = await window.novelTracker.chooseLibraryRoot()
    if (!directory) return
    settings.value = await window.novelTracker.getSettings()
    success.value = 'Historical library root saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function chooseTrackerCsv(): Promise<void> {
  error.value = ''
  success.value = ''
  try {
    const path = await window.novelTracker.chooseTrackerCsv()
    if (!path) return
    settings.value = await window.novelTracker.getSettings()
    success.value = 'Tracker CSV saved. It will only be read by the app.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function chooseOutputDirectory(): Promise<void> {
  error.value = ''
  success.value = ''
  try {
    const directory = await window.novelTracker.chooseOutputDirectory()
    if (!directory) return
    settings.value = await window.novelTracker.getSettings()
    success.value = 'EPUB output folder saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

async function saveFreshnessHours(): Promise<void> {
  error.value = ''
  success.value = ''
  savingFreshness.value = true
  try {
    const result = await window.novelTracker.updateDiscoveryFreshnessHours(freshnessHoursDraft.value)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    freshnessHoursDraft.value = result.value.discoveryFreshnessHours
    success.value = 'Chapter-list refresh interval saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingFreshness.value = false
  }
}

async function saveConcurrency(): Promise<void> {
  error.value = ''
  success.value = ''
  savingConcurrency.value = true
  try {
    const result = await window.novelTracker.updateDownloadConcurrency(concurrencyDraft.value)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    concurrencyDraft.value = result.value.maxSimultaneousDownloads
    success.value = 'Download concurrency saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingConcurrency.value = false
  }
}

async function saveChapterConcurrency(): Promise<void> {
  error.value = ''
  success.value = ''
  savingChapterConcurrency.value = true
  try {
    const result = await window.novelTracker.updateChapterConcurrency(chapterConcurrencyDraft.value)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    chapterConcurrencyDraft.value = result.value.maxSimultaneousChaptersPerNovel
    success.value = 'Per-novel chapter concurrency saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingChapterConcurrency.value = false
  }
}

function addSiteExtractionPreference(): void {
  error.value = ''
  try {
    const hostname = normalizeSiteHostname(sitePreferenceHostnameDraft.value)
    siteExtractionPreferencesDraft.value = normalizeSiteExtractionPreferences([
      ...siteExtractionPreferencesDraft.value.filter((preference) => preference.hostname !== hostname),
      { hostname, mode: sitePreferenceModeDraft.value }
    ])
    sitePreferenceHostnameDraft.value = ''
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

function removeSiteExtractionPreference(hostname: string): void {
  siteExtractionPreferencesDraft.value = siteExtractionPreferencesDraft.value.filter(
    (preference) => preference.hostname !== hostname
  )
}

async function saveSiteExtractionPreferences(): Promise<void> {
  error.value = ''
  success.value = ''
  savingSiteExtractionPreferences.value = true
  try {
    const result = await window.novelTracker.updateSiteExtractionPreferences(siteExtractionPreferencesDraft.value)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    siteExtractionPreferencesDraft.value = result.value.siteExtractionPreferences.map((preference) => ({ ...preference }))
    success.value = 'Site extraction preferences saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingSiteExtractionPreferences.value = false
  }
}

async function saveLibraryScanOptions(): Promise<void> {
  error.value = ''
  success.value = ''
  savingLibraryScanOptions.value = true
  try {
    const result = await window.novelTracker.updateLibraryScanOptions(
      scanOldFolderDraft.value,
      scanOldCompletedFolderDraft.value
    )
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    scanOldFolderDraft.value = result.value.scanOldFolder
    scanOldCompletedFolderDraft.value = result.value.scanOldCompletedFolder
    success.value = 'Library scan options saved. Rescan the library to apply them.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingLibraryScanOptions.value = false
  }
}

async function saveTheme(): Promise<void> {
  error.value = ''
  success.value = ''
  savingTheme.value = true
  try {
    const result = await window.novelTracker.updateAppTheme(themeDraft.value)
    if (!result.ok) {
      error.value = result.error
      return
    }
    settings.value = result.value
    themeDraft.value = result.value.appTheme
    emit('themeChanged', result.value.appTheme)
    success.value = 'App theme saved.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    savingTheme.value = false
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
</script>

<template>
  <section class="library-page configuration-page">
    <section class="intro">
      <p class="eyebrow">APP PREFERENCES</p>
      <h2>Configuration</h2>
      <p>Set local folders, queue behavior, appearance, and EPUB defaults.</p>
    </section>

    <Message v-if="error" severity="error" :closable="false" class="feedback">{{ error }}</Message>
    <Message v-if="success" severity="success" :closable="false" class="feedback">{{ success }}</Message>

    <section class="card library-settings" aria-labelledby="configuration-paths-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">LOCAL PATHS</p>
          <h3 id="configuration-paths-heading">Library and tracker paths</h3>
        </div>
      </div>
      <div class="library-path-grid">
        <div class="library-path">
          <span class="field-label">Historical library root</span>
          <span class="library-path-value">{{ settings.libraryRoot || 'Not configured' }}</span>
          <Button label="Choose library" severity="secondary" outlined size="small" @click="chooseLibraryRoot" />
        </div>
        <div class="library-path">
          <span class="field-label">Novel tracker CSV · read-only</span>
          <span class="library-path-value">{{ settings.trackerCsvPath || 'Not configured' }}</span>
          <Button label="Choose CSV" severity="secondary" outlined size="small" @click="chooseTrackerCsv" />
        </div>
        <div class="library-path">
          <span class="field-label">EPUB output folder</span>
          <span class="library-path-value">{{ settings.outputDirectory || 'Not configured' }}</span>
          <Button label="Choose output" severity="secondary" outlined size="small" @click="chooseOutputDirectory" />
        </div>
      </div>
    </section>

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
            label="Save concurrency"
            size="small"
            :loading="savingConcurrency"
            :disabled="savingConcurrency || !concurrencyDirty"
            @click="saveConcurrency"
          />
        </div>
        <div class="configuration-setting">
          <label class="field-label" for="chapter-concurrency">Maximum active chapter requests per novel</label>
          <select id="chapter-concurrency" v-model.number="chapterConcurrencyDraft" class="configuration-select">
            <option v-for="limit in chapterConcurrencyOptions" :key="limit" :value="limit">{{ limit }} chapter{{ limit === 1 ? '' : 's' }}</option>
          </select>
          <small class="help-text">Independent of novel downloads. Same-site requests still share the site's rate limit and a two-request host cap.</small>
          <Button
            label="Save chapter concurrency"
            size="small"
            :loading="savingChapterConcurrency"
            :disabled="savingChapterConcurrency || !chapterConcurrencyDirty"
            @click="saveChapterConcurrency"
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
            label="Save refresh interval"
            size="small"
            :loading="savingFreshness"
            :disabled="savingFreshness || !freshnessDirty || !freshnessValid"
            @click="saveFreshnessHours"
          />
        </div>
        <div class="configuration-setting">
          <label class="field-label" for="app-theme">App appearance</label>
          <select id="app-theme" v-model="themeDraft" class="configuration-select">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <Button
            label="Save theme"
            size="small"
            :loading="savingTheme"
            :disabled="savingTheme || !themeDirty"
            @click="saveTheme"
          />
        </div>
      </div>
      <div class="site-extraction-settings">
        <div>
          <strong>Per-site chapter-list parser</strong>
          <p class="help-text">Automatic uses the built-in site detector. Use Generic HTML only when automatic discovery does not fit a site's chapter-list page. These preferences are saved locally.</p>
        </div>
        <div class="site-extraction-preference-form">
          <input
            v-model="sitePreferenceHostnameDraft"
            class="site-extraction-hostname"
            type="text"
            placeholder="example.com"
            aria-label="Website hostname"
            :disabled="savingSiteExtractionPreferences"
          />
          <select v-model="sitePreferenceModeDraft" class="configuration-select" aria-label="Chapter-list parser">
            <option value="automatic">Automatic</option>
            <option value="generic-html">Generic HTML</option>
          </select>
          <Button label="Add / update site" size="small" :disabled="savingSiteExtractionPreferences" @click="addSiteExtractionPreference" />
        </div>
        <div v-if="siteExtractionPreferencesDraft.length" class="site-extraction-preference-list">
          <div v-for="preference in siteExtractionPreferencesDraft" :key="preference.hostname" class="site-extraction-preference-row">
            <strong>{{ preference.hostname }}</strong>
            <select v-model="preference.mode" class="configuration-select" aria-label="Saved chapter-list parser">
              <option value="automatic">Automatic</option>
              <option value="generic-html">Generic HTML</option>
            </select>
            <Button
              icon="pi pi-trash"
              severity="danger"
              text
              rounded
              size="small"
              :aria-label="`Remove extraction preference for ${preference.hostname}`"
              :disabled="savingSiteExtractionPreferences"
              @click="removeSiteExtractionPreference(preference.hostname)"
            />
          </div>
        </div>
        <Button
          label="Save site preferences"
          size="small"
          :loading="savingSiteExtractionPreferences"
          :disabled="savingSiteExtractionPreferences || !siteExtractionPreferencesDirty"
          @click="saveSiteExtractionPreferences"
        />
      </div>
    </section>

    <section class="card" aria-labelledby="configuration-library-scan-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">LIBRARY SCANNING</p>
          <h3 id="configuration-library-scan-heading">Optional scan source</h3>
        </div>
      </div>
      <div class="configuration-settings-grid">
        <label class="configuration-setting configuration-toggle" for="scan-old-folder">
          <input id="scan-old-folder" v-model="scanOldFolderDraft" type="checkbox" />
          <span>
            <strong>Scan the Old folder</strong>
            <small class="help-text">Include archived EPUB and AZW3 files in Old when scanning. AZW3 contents are not inspected. Off by default.</small>
          </span>
        </label>
        <label class="configuration-setting configuration-toggle" for="scan-old-completed-folder">
          <input id="scan-old-completed-folder" v-model="scanOldCompletedFolderDraft" type="checkbox" />
          <span>
            <strong>Scan the Old Completed folder</strong>
            <small class="help-text">Include EPUB and AZW3 files in the separate Old Completed folder when scanning. AZW3 contents are not inspected. Off by default.</small>
          </span>
        </label>
      </div>
      <Button
        label="Save scan preference"
        size="small"
        :loading="savingLibraryScanOptions"
        :disabled="savingLibraryScanOptions || !libraryScanOptionsDirty"
        @click="saveLibraryScanOptions"
      />
    </section>

    <section class="card library-settings" aria-labelledby="configuration-epub-heading">
      <div class="section-heading">
        <div>
          <p class="step-label">EPUB DEFAULTS</p>
          <h3 id="configuration-epub-heading">EPUB stylesheet</h3>
        </div>
      </div>
      <details class="epub-css-settings">
        <summary>Edit EPUB stylesheet</summary>
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
  </section>
</template>
