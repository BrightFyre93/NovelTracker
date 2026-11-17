import type { IpcContext } from './context'
import { z } from 'zod'

type BrowserIpcContext = Pick<
  IpcContext,
  | 'activeBrowserDiscoveries'
  | 'clearBrowserSession'
  | 'dataDirectory'
  | 'discoverChapters'
  | 'discoverChaptersUsingPageLoader'
  | 'handle'
  | 'openVerificationBrowser'
  | 'readBrowserPage'
  | 'shuttingDown'
>

export function registerBrowserIpcHandlers(context: BrowserIpcContext): void {
  const {
    activeBrowserDiscoveries,
    clearBrowserSession,
    dataDirectory,
    discoverChapters,
    discoverChaptersUsingPageLoader,
    handle,
    openVerificationBrowser,
    readBrowserPage
  } = context

  handle('result', 'chapter:discover', z.tuple([z.string()]), (_event, url) =>
    discoverChapters(url)
  )

  handle(
    'result',
    'browser:open-verification',
    z.tuple([z.string()]),
    (_event, url) => openVerificationBrowser(url, dataDirectory())
  )

  handle(
    'result',
    'browser:discover',
    z.tuple([z.string()]),
    async (event, url) => {
      if (context.shuttingDown) throw new Error('NovelTracker is closing.')
      const controller = new AbortController()
      const operationId = `renderer:${event.sender.id}`
      if (activeBrowserDiscoveries.has(operationId)) {
        throw new Error('Browser-assisted discovery is already running.')
      }
      activeBrowserDiscoveries.set(operationId, controller)
      try {
        return await discoverChaptersUsingPageLoader(
          url,
          readBrowserPage,
          undefined,
          controller.signal
        )
      } finally {
        activeBrowserDiscoveries.delete(operationId)
      }
    }
  )

  handle(
    'typed',
    'browser:cancel-discovery',
    z.tuple([z.string().optional()]),
    (event, queueItemId) => {
      const operationId =
        queueItemId !== undefined
          ? `queue:${queueItemId}`
          : `renderer:${event.sender.id}`
      activeBrowserDiscoveries.get(operationId)?.abort()
    }
  )

  handle('validated-result', 'browser:clear-session', z.tuple([]), async () => {
    await clearBrowserSession(dataDirectory())
    return { ok: true, value: undefined }
  })
}
