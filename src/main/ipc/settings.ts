import type { IpcContext } from './context'

type SettingsIpcContext = Pick<
  IpcContext,
  | 'handleResultIpc'
  | 'handleTypedIpc'
  | 'settingsService'
  | 'settingsUpdatePatchSchema'
  | 'z'
>

export function registerSettingsIpcHandlers(context: SettingsIpcContext): void {
  const {
    handleResultIpc,
    handleTypedIpc,
    settingsService,
    settingsUpdatePatchSchema,
    z
  } = context

  handleTypedIpc('settings:get', z.tuple([]), async () => settingsService.get())

  handleResultIpc(
    'settings:update',
    z.tuple([settingsUpdatePatchSchema]),
    (_event, patch) => settingsService.update(patch)
  )
}
