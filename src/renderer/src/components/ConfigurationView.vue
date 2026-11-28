<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Message from 'primevue/message'
import type { AppSettings } from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'
import {
  DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  DEFAULT_DOWNLOAD_RETRY_ATTEMPTS,
  DEFAULT_EPUB_CSS,
  DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS,
  DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS
} from '../../../shared/constants'
import { DEFAULT_EPUB_OUTPUT_PREFERENCES } from '../../../shared/epubOutputOptions'
import ConfigurationEpubDefaults from './ConfigurationEpubDefaults.vue'
import ConfigurationLibraryScan from './ConfigurationLibraryScan.vue'
import ConfigurationPaths from './ConfigurationPaths.vue'
import ConfigurationQueueSettings from './ConfigurationQueueSettings.vue'
import ConfigurationSiteRules from './ConfigurationSiteRules.vue'

const emit = defineEmits<{
  themeChanged: [theme: AppSettings['appTheme']]
}>()

const settings = ref<AppSettings>({
  libraryRoot: '',
  trackerCsvPath: '',
  outputDirectory: '',
  scanOldFolder: false,
  scanOldCompletedFolder: false,
  omitHttp404Chapters: false,
  maxSimultaneousDownloads: DEFAULT_MAX_SIMULTANEOUS_DOWNLOADS,
  maxDownloadRetryAttempts: DEFAULT_DOWNLOAD_RETRY_ATTEMPTS,
  httpConnectTimeoutMs: DEFAULT_HTTP_CONNECT_TIMEOUT_MS,
  httpResponseReadTimeoutMs: DEFAULT_HTTP_RESPONSE_READ_TIMEOUT_MS,
  maxSimultaneousDiscoveries: DEFAULT_MAX_SIMULTANEOUS_DISCOVERIES,
  maxSimultaneousChaptersPerNovel: DEFAULT_MAX_SIMULTANEOUS_CHAPTERS_PER_NOVEL,
  domainRequestDelays: [],
  discoveryFreshnessHours: DEFAULT_DISCOVERY_FRESHNESS_HOURS,
  siteExtractionPreferences: [],
  epubCss: DEFAULT_EPUB_CSS,
  epubOutputPreferences: { ...DEFAULT_EPUB_OUTPUT_PREFERENCES },
  appTheme: 'light'
})
const error = ref('')
const success = ref('')

onMounted(async () => {
  try {
    settings.value = await window.novelTracker.getSettings()
  } catch (reason) {
    error.value = toMessage(reason)
  }
})

// Every section reports a saved result or a failure through these two handlers.
function handleSaved(saved: AppSettings, message: string): void {
  const themeChanged = saved.appTheme !== settings.value.appTheme
  settings.value = saved
  error.value = ''
  success.value = message
  if (themeChanged) emit('themeChanged', saved.appTheme)
}

function handleFailed(message: string): void {
  success.value = ''
  error.value = message
}
</script>

<template>
  <section class="library-page configuration-page">
    <section class="intro">
      <p class="eyebrow">APP PREFERENCES</p>
      <h2>Configuration</h2>
      <p>Set local folders, queue behavior, appearance, and EPUB defaults.</p>
    </section>

    <Message v-if="error" :key="error" severity="error" closable class="feedback" @close="error = ''">{{ error }}</Message>
    <Message v-if="success" :key="success" severity="success" closable class="feedback" @close="success = ''">{{ success }}</Message>

    <ConfigurationPaths :settings="settings" @saved="handleSaved" @failed="handleFailed" />
    <ConfigurationQueueSettings :settings="settings" @saved="handleSaved" @failed="handleFailed" />
    <ConfigurationSiteRules :settings="settings" @saved="handleSaved" @failed="handleFailed" />
    <ConfigurationLibraryScan :settings="settings" @saved="handleSaved" @failed="handleFailed" />
    <ConfigurationEpubDefaults :settings="settings" @saved="handleSaved" @failed="handleFailed" />
  </section>
</template>
