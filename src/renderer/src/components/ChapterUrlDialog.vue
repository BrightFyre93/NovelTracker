<script setup lang="ts">
import { ref, watch } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'

const props = defineProps<{
  chapter: { id: string; title: string; url: string } | null
  saving: boolean
  error: string
}>()
const emit = defineEmits<{ save: [url: string]; cancel: [] }>()

const draft = ref('')
watch(
  () => props.chapter,
  (chapter) => {
    draft.value = chapter?.url ?? ''
  },
  { immediate: true }
)

function submit(): void {
  const value = draft.value.trim()
  if (!value || props.saving) return
  emit('save', value)
}
</script>

<template>
  <div
    v-if="chapter"
    class="scan-overlay"
    role="dialog"
    aria-modal="true"
    aria-labelledby="chapter-url-title"
    @keydown.esc="emit('cancel')"
  >
    <section class="scan-dialog">
      <h2 id="chapter-url-title">Edit chapter URL</h2>
      <p class="scan-message">{{ chapter.title }}</p>
      <div class="dialog-field">
        <label class="field-label" for="chapter-url-input">Chapter URL</label>
        <InputText
          id="chapter-url-input"
          v-model="draft"
          class="full-input"
          maxlength="2048"
          autofocus
          :disabled="saving"
          @keydown.enter="submit"
        />
        <small class="help-text">
          The edit applies only to this queued job. The original URL is remembered, and a refresh of the chapter list keeps your edit.
        </small>
      </div>
      <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <Button
          label="Cancel"
          severity="secondary"
          outlined
          :disabled="saving"
          @click="emit('cancel')"
        />
        <Button
          label="Save URL"
          :loading="saving"
          :disabled="saving || !draft.trim() || draft.trim() === chapter.url"
          @click="submit"
        />
      </div>
    </section>
  </div>
</template>
