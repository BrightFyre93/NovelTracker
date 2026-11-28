import { ref, watch, type Ref } from 'vue'
import type { AppSettings, SettingsUpdatePatch } from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'

/** Events every Configuration section emits to the page. */
export interface SettingsSectionEvents {
  saved: [settings: AppSettings, message: string]
  failed: [message: string]
}

/**
 * Saving for one Configuration section. `save` sends a settings patch, reports
 * the result to the page, and tracks which button is busy by key.
 */
export function useSettingsSave(
  onSaved: (settings: AppSettings, message: string) => void,
  onFailed: (message: string) => void
) {
  const saving = ref<string | null>(null)

  async function save(
    key: string,
    patch: SettingsUpdatePatch,
    message: string
  ): Promise<AppSettings | null> {
    saving.value = key
    try {
      const result = await window.novelTracker.updateSettings(patch)
      if (!result.ok) {
        onFailed(result.error)
        return null
      }
      onSaved(result.value, message)
      return result.value
    } catch (reason) {
      onFailed(toMessage(reason))
      return null
    } finally {
      saving.value = null
    }
  }

  return { saving, save }
}

/**
 * Keeps an editable draft in step with the saved value: when the saved value
 * changes (after a save) the draft is replaced, other drafts are left alone.
 */
export function syncDraft<T>(source: () => T, draft: Ref<T>): void {
  watch(
    source,
    (value) => {
      draft.value = value
    },
    { immediate: true }
  )
}

/** Same as syncDraft for lists of objects: compares by content and copies. */
export function syncListDraft<T extends object>(
  source: () => T[],
  draft: Ref<T[]>
): void {
  watch(
    () => JSON.stringify(source()),
    () => {
      draft.value = source().map((item) => ({ ...item }))
    },
    { immediate: true }
  )
}

export function numberRange(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index)
}
