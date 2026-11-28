<script setup lang="ts">
import Button from 'primevue/button'
import type { AppSettings } from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'
import type { SettingsSectionEvents } from '../composables/useSettingsSave'

defineProps<{ settings: AppSettings }>()
const emit = defineEmits<SettingsSectionEvents>()

async function choose(
  action: () => Promise<string | null>,
  message: string
): Promise<void> {
  try {
    const chosen = await action()
    if (!chosen) return
    emit('saved', await window.novelTracker.getSettings(), message)
  } catch (reason) {
    emit('failed', toMessage(reason))
  }
}

const chooseLibraryRoot = (): Promise<void> =>
  choose(() => window.novelTracker.chooseLibraryRoot(), 'Historical library root saved.')
const chooseTrackerCsv = (): Promise<void> =>
  choose(
    () => window.novelTracker.chooseTrackerCsv(),
    'Tracker CSV saved. It will only be read by the app.'
  )
const chooseOutputDirectory = (): Promise<void> =>
  choose(() => window.novelTracker.chooseOutputDirectory(), 'EPUB output folder saved.')
</script>

<template>
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
        <Button
          icon="pi pi-folder-open"
          title="Choose library folder"
          aria-label="Choose library folder"
          severity="secondary"
          outlined
          size="small"
          @click="chooseLibraryRoot"
        />
      </div>
      <div class="library-path">
        <span class="field-label">Novel tracker CSV · read-only</span>
        <span class="library-path-value">{{ settings.trackerCsvPath || 'Not configured' }}</span>
        <Button
          icon="pi pi-file"
          title="Choose tracker CSV"
          aria-label="Choose tracker CSV"
          severity="secondary"
          outlined
          size="small"
          @click="chooseTrackerCsv"
        />
      </div>
      <div class="library-path">
        <span class="field-label">EPUB output folder</span>
        <span class="library-path-value">{{ settings.outputDirectory || 'Not configured' }}</span>
        <Button
          icon="pi pi-folder"
          title="Choose EPUB output folder"
          aria-label="Choose EPUB output folder"
          severity="secondary"
          outlined
          size="small"
          @click="chooseOutputDirectory"
        />
      </div>
    </div>
  </section>
</template>
