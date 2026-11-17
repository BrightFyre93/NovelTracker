import type { IpcContext } from './context'
import { z } from 'zod'

type SettingsIpcContext = Pick<
  IpcContext,
  'handle' | 'settingsService' | 'settingsUpdatePatchSchema'
>

export function registerSettingsIpcHandlers(context: SettingsIpcContext): void {
  const { handle, settingsService, settingsUpdatePatchSchema } = context

  handle('typed', 'settings:get', z.tuple([]), async () =>
    settingsService.get()
  )

  handle(
    'result',
    'settings:update',
    z.tuple([settingsUpdatePatchSchema]),
    (_event, patch) => settingsService.update(patch)
  )
}
