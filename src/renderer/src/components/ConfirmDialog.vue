<script setup lang="ts">
import Button from 'primevue/button'

defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel?: string
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <div
    v-if="open"
    class="scan-overlay"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="confirm-dialog-title"
    aria-describedby="confirm-dialog-message"
    @keydown.esc="emit('cancel')"
  >
    <section class="scan-dialog">
      <h2 id="confirm-dialog-title">{{ title }}</h2>
      <p id="confirm-dialog-message" class="scan-message">{{ message }}</p>
      <div class="dialog-actions">
        <Button
          label="Cancel"
          severity="secondary"
          outlined
          autofocus
          @click="emit('cancel')"
        />
        <Button
          :label="confirmLabel ?? 'Confirm'"
          severity="danger"
          @click="emit('confirm')"
        />
      </div>
    </section>
  </div>
</template>
