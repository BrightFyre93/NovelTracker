import { computed, ref } from 'vue'
import type { TrackerNovel } from '../../../shared/contracts'

export function useTrackerNovelSearch(getTrackerNovels: () => TrackerNovel[]) {
  const trackerSearch = ref('')
  const filteredTrackerNovels = computed(() => {
    const novels = getTrackerNovels()
    const query = trackerSearch.value.trim().toLocaleLowerCase()
    const matches = query
      ? novels.filter((novel) =>
          `${novel.title} ${novel.siteTitle} ${novel.author} ${novel.alternativeNames}`
            .toLocaleLowerCase()
            .includes(query)
        )
      : novels
    return matches.slice(0, 100)
  })

  return { trackerSearch, filteredTrackerNovels }
}
