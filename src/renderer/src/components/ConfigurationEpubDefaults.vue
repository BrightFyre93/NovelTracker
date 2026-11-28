<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Button from 'primevue/button'
import type { AppSettings, EpubOutputPreferences } from '../../../shared/contracts'
import { DEFAULT_EPUB_CSS, MAX_EPUB_CSS_LENGTH } from '../../../shared/constants'
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

const preferencesDraft = ref<EpubOutputPreferences>({ ...props.settings.epubOutputPreferences })
const cssDraft = ref(props.settings.epubCss)

// Replace the draft when the saved preferences change (compared by content).
watch(
  () => JSON.stringify(props.settings.epubOutputPreferences),
  () => {
    preferencesDraft.value = { ...props.settings.epubOutputPreferences }
  }
)
syncDraft(() => props.settings.epubCss, cssDraft)

const preferencesDirty = computed(
  () =>
    JSON.stringify(preferencesDraft.value) !==
    JSON.stringify(props.settings.epubOutputPreferences)
)
const cssDirty = computed(() => cssDraft.value !== props.settings.epubCss)

const savePreferences = async (): Promise<void> => {
  const saved = await save(
    'preferences',
    { epubOutputPreferences: { ...preferencesDraft.value } },
    'EPUB defaults saved. Existing queued jobs keep their captured options.'
  )
  if (saved) preferencesDraft.value = { ...saved.epubOutputPreferences }
}

const saveCss = async (css = cssDraft.value): Promise<void> => {
  await save(
    'css',
    { epubCss: css },
    'EPUB stylesheet saved. Existing queued jobs keep their saved stylesheet.'
  )
}

const resetCss = async (): Promise<void> => {
  cssDraft.value = DEFAULT_EPUB_CSS
  await saveCss(DEFAULT_EPUB_CSS)
}
</script>

<template>
  <section class="card library-settings" aria-labelledby="configuration-epub-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">EPUB DEFAULTS</p>
        <h3 id="configuration-epub-heading">EPUB defaults</h3>
      </div>
    </div>
    <p class="help-text">These defaults apply to newly queued EPUB jobs. Existing queued jobs keep their captured options.</p>
    <div class="configuration-settings-grid epub-output-preferences-grid">
      <div class="configuration-setting epub-output-template-setting">
        <label class="field-label" for="epub-filename-template">Filename template</label>
        <input id="epub-filename-template" v-model="preferencesDraft.filenameTemplate" class="full-input" maxlength="1000" placeholder="%Title% %FirstChapter%-%LastChapter%" :disabled="saving !== null" />
        <small class="help-text">Tokens: %Filename%, %Title%, %Author%, %FirstChapter%, %LastChapter%.</small>
      </div>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.includeChapterListPage" type="checkbox" />
        <span><strong>Include Chapter List page</strong></span>
      </label>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.skipImages" type="checkbox" />
        <span><strong>Skip images</strong></span>
      </label>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.compressImages" type="checkbox" />
        <span><strong>Compress images</strong></span>
      </label>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.coverJpegOnly" type="checkbox" />
        <span><strong>Restrict cover to JPEG</strong></span>
      </label>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.flattenAnimatedImages" type="checkbox" />
        <span><strong>Flatten animated images (lossy)</strong></span>
      </label>
      <label class="configuration-setting configuration-toggle">
        <input v-model="preferencesDraft.includeImageAttribution" type="checkbox" />
        <span><strong>Link images to their source</strong></span>
      </label>
      <label class="configuration-setting">
        <span class="field-label">Maximum image dimension</span>
        <span class="configuration-inline-control">
          <input v-model.number="preferencesDraft.maxImageDimension" class="configuration-number" type="number" min="64" max="8192" step="1" :disabled="saving !== null || !preferencesDraft.compressImages" /> px
        </span>
      </label>
      <label class="configuration-setting">
        <span class="field-label">Image format</span>
        <select v-model="preferencesDraft.imageFormat" class="configuration-select" :disabled="saving !== null">
          <option value="jpeg">JPEG for opaque images</option>
          <option value="png">PNG</option>
          <option value="original">Preserve supported formats</option>
        </select>
      </label>
      <label class="configuration-setting">
        <span class="field-label">Maximum chapters per EPUB</span>
        <input v-model.number="preferencesDraft.maxChaptersPerEpub" class="configuration-number" type="number" min="1" max="20000" step="1" :disabled="saving !== null" />
      </label>
    </div>
    <div class="configuration-section-actions">
      <Button
        icon="pi pi-save"
        title="Save EPUB defaults"
        aria-label="Save EPUB defaults"
        size="small"
        :loading="saving === 'preferences'"
        :disabled="saving !== null || !preferencesDirty"
        @click="savePreferences"
      />
    </div>
    <details class="epub-css-settings">
      <summary>Edit EPUB stylesheet</summary>
      <p class="help-text">Applies to new EPUB jobs. Existing queued jobs keep their saved stylesheet.</p>
      <textarea
        v-model="cssDraft"
        class="epub-css-editor"
        aria-label="EPUB stylesheet CSS"
        spellcheck="false"
        :maxlength="MAX_EPUB_CSS_LENGTH"
        :disabled="saving !== null"
      />
      <div class="epub-css-actions">
        <span>{{ cssDraft.length.toLocaleString() }} / {{ MAX_EPUB_CSS_LENGTH.toLocaleString() }} characters</span>
        <div>
          <Button
            icon="pi pi-refresh"
            title="Reset stylesheet to default"
            aria-label="Reset stylesheet to default"
            severity="secondary"
            outlined
            size="small"
            :disabled="saving !== null || (cssDraft === DEFAULT_EPUB_CSS && settings.epubCss === DEFAULT_EPUB_CSS)"
            @click="resetCss"
          />
          <Button
            icon="pi pi-save"
            title="Save EPUB stylesheet"
            aria-label="Save EPUB stylesheet"
            size="small"
            :loading="saving === 'css'"
            :disabled="saving !== null || !cssDirty"
            @click="saveCss()"
          />
        </div>
      </div>
    </details>
  </section>
</template>
