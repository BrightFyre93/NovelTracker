<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import type { AppSettings } from '../../../shared/contracts'
import {
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

const scanOldFolderDraft = ref(props.settings.scanOldFolder)
const scanOldCompletedFolderDraft = ref(props.settings.scanOldCompletedFolder)
syncDraft(() => props.settings.scanOldFolder, scanOldFolderDraft)
syncDraft(() => props.settings.scanOldCompletedFolder, scanOldCompletedFolderDraft)

const dirty = computed(
  () =>
    scanOldFolderDraft.value !== props.settings.scanOldFolder ||
    scanOldCompletedFolderDraft.value !== props.settings.scanOldCompletedFolder
)

const saveScanOptions = (): Promise<unknown> =>
  save(
    'scan',
    {
      scanOldFolder: scanOldFolderDraft.value,
      scanOldCompletedFolder: scanOldCompletedFolderDraft.value
    },
    'Library scan options saved. Rescan the library to apply them.'
  )
</script>

<template>
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
    <div class="configuration-section-actions">
      <Button
        icon="pi pi-save"
        title="Save library scan preferences"
        aria-label="Save library scan preferences"
        size="small"
        :loading="saving === 'scan'"
        :disabled="saving !== null || !dirty"
        @click="saveScanOptions"
      />
    </div>
  </section>
</template>
