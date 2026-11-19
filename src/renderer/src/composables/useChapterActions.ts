import { ref } from 'vue'
import type { DiscoveryQueueItem } from '../../../shared/contracts'
import { toMessage, unwrapResult } from '../../../shared/errors'
import { useDownloadStore, type SelectableChapter } from '../stores/download'

/**
 * Actions on the chapter list of the item that is being reviewed: reverse the
 * selection or the order, copy URLs, and edit one chapter's URL.
 */
export function useChapterActions(options: {
  /** Chapters that match the current filter. */
  visibleChapters: () => SelectableChapter[]
  /** Saves the pending selection so the main process sees the latest one. */
  flushSelection: () => Promise<boolean>
}) {
  const store = useDownloadStore()
  const reorderBusy = ref(false)
  const urlDialogChapter = ref<SelectableChapter | null>(null)
  const urlSaving = ref(false)
  const urlError = ref('')

  function applyItemChapters(item: DiscoveryQueueItem): void {
    store.chapters = item.chapters.map(({ selected: _selected, ...chapter }) => chapter)
    store.chapterSelection = new Set(
      item.chapters.filter((chapter) => chapter.selected).map((chapter) => chapter.id)
    )
  }

  /** Inverts the selection of the filtered chapters, or of all chapters. */
  function reverseSelection(scope: 'visible' | 'all'): void {
    const scoped = scope === 'visible' ? options.visibleChapters() : store.chapters
    const next = new Set(store.chapterSelection)
    for (const chapter of scoped) {
      if (next.has(chapter.id)) next.delete(chapter.id)
      else next.add(chapter.id)
    }
    store.chapterSelection = next
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to a temporary text area when the clipboard API is refused.
    }
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    if (!copied) throw new Error('The URLs could not be copied to the clipboard.')
  }

  async function copyUrls(which: 'selected' | 'all'): Promise<void> {
    const chapters =
      which === 'selected'
        ? store.chapters.filter((chapter) => store.chapterSelection.has(chapter.id))
        : store.chapters
    if (chapters.length === 0) {
      store.error = 'There are no chapters to copy.'
      return
    }
    try {
      await copyText(chapters.map((chapter) => chapter.url).join('\n'))
      store.error = ''
      store.success = `Copied ${chapters.length.toLocaleString()} chapter URL${chapters.length === 1 ? '' : 's'}.`
    } catch (error) {
      store.error = toMessage(error)
    }
  }

  async function reverseOrder(): Promise<void> {
    const id = store.queueItemId
    if (!id) {
      store.error = 'Open a saved discovery before changing its chapter order.'
      return
    }
    if (!(await options.flushSelection())) return
    reorderBusy.value = true
    store.error = ''
    try {
      unwrapResult(await window.novelTracker.reverseDiscoveryQueueChapters(id))
      applyItemChapters(
        unwrapResult(await window.novelTracker.getDiscoveryQueueItem(id))
      )
      store.success = 'Chapter order reversed.'
    } catch (error) {
      store.error = toMessage(error)
    } finally {
      reorderBusy.value = false
    }
  }

  function openUrlDialog(chapter: SelectableChapter): void {
    urlError.value = ''
    urlDialogChapter.value = chapter
  }

  function closeUrlDialog(): void {
    if (!urlSaving.value) urlDialogChapter.value = null
  }

  async function saveChapterUrl(url: string): Promise<void> {
    const chapter = urlDialogChapter.value
    const id = store.queueItemId
    if (!chapter || !id) return
    urlSaving.value = true
    urlError.value = ''
    try {
      if (!(await options.flushSelection())) {
        urlError.value = 'The chapter selection could not be saved first.'
        return
      }
      unwrapResult(
        await window.novelTracker.updateDiscoveryQueueChapterUrl(id, chapter.id, url)
      )
      applyItemChapters(
        unwrapResult(await window.novelTracker.getDiscoveryQueueItem(id))
      )
      urlDialogChapter.value = null
      store.error = ''
      store.success = 'Chapter URL updated.'
    } catch (error) {
      urlError.value = toMessage(error)
    } finally {
      urlSaving.value = false
    }
  }

  return {
    reorderBusy,
    urlDialogChapter,
    urlSaving,
    urlError,
    reverseSelection,
    copyUrls,
    reverseOrder,
    openUrlDialog,
    closeUrlDialog,
    saveChapterUrl
  }
}
