import type { ChapterContent } from '../../../shared/contracts'
import {
  chapterArtifactFileExists,
  chapterArtifactIsUsable,
  chapterArtifactReference,
  readCoverArtifact,
  removeChapterArtifacts,
  writeChapterArtifact,
  writeCoverArtifact
} from '../localStore'

export function createDownloadArtifactStore(dataDirectory: () => string) {
  return {
    hasChapterFile(itemId: string, url: string): Promise<boolean> {
      return chapterArtifactFileExists(dataDirectory(), itemId, url)
    },

    /** True when the saved chapter exists and its content and images are readable. */
    hasUsableChapter(itemId: string, url: string): Promise<boolean> {
      return chapterArtifactIsUsable(dataDirectory(), itemId, url)
    },

    writeChapter(itemId: string, content: ChapterContent): Promise<void> {
      return writeChapterArtifact(dataDirectory(), itemId, content)
    },

    chapterReference(itemId: string, url: string): string {
      return chapterArtifactReference(itemId, url)
    },

    readCover(itemId: string) {
      return readCoverArtifact(dataDirectory(), itemId)
    },

    writeCover(
      itemId: string,
      content: Parameters<typeof writeCoverArtifact>[2]
    ) {
      return writeCoverArtifact(dataDirectory(), itemId, content)
    },

    removeChapters(itemId: string): Promise<void> {
      return removeChapterArtifacts(dataDirectory(), itemId)
    }
  }
}
