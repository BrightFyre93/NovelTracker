import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { Result } from '../../shared/contracts'
import { errorCode, toMessage } from '../../shared/errors'
import type { IpcChannel, IpcMap } from '../../shared/ipc'
import type { z } from 'zod'

type ResultIpcChannel = {
  [Channel in IpcChannel]: IpcMap[Channel]['result'] extends Result<unknown>
    ? Channel
    : never
}[IpcChannel]

type ResultIpcValue<Channel extends ResultIpcChannel> =
  IpcMap[Channel]['result'] extends Result<infer Value> ? Value : never

type HandlerMode = 'result' | 'validated-result' | 'typed'

type HandlerValue<
  Mode extends HandlerMode,
  Channel extends IpcChannel
> = Mode extends 'result'
  ? Channel extends ResultIpcChannel
    ? ResultIpcValue<Channel>
    : never
  : IpcMap[Channel]['result']

export function createIpcHandlerFactory(
  getMainWindowWebContents: () => WebContents | null
) {
  const isTrustedIpcSender = (event: IpcMainInvokeEvent): boolean => {
    const mainWebContents = getMainWindowWebContents()
    if (!mainWebContents || event.sender !== mainWebContents) return false
    const frame = event.senderFrame
    if (!frame || frame.isDestroyed() || frame !== mainWebContents.mainFrame)
      return false
    try {
      const frameUrl = new URL(frame.url)
      const windowUrl = new URL(mainWebContents.getURL())
      return (
        frameUrl.protocol === windowUrl.protocol &&
        frameUrl.origin === windowUrl.origin
      )
    } catch {
      return false
    }
  }

  function handle<Mode extends HandlerMode, Channel extends IpcChannel>(
    mode: Mode,
    channel: Channel,
    schema: z.ZodType<IpcMap[Channel]['args']>,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: IpcMap[Channel]['args']
    ) => HandlerValue<Mode, Channel> | Promise<HandlerValue<Mode, Channel>>
  ): void {
    ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
      const trusted = isTrustedIpcSender(event)
      if (!trusted) {
        if (mode === 'typed')
          throw new Error('IPC request rejected from an untrusted renderer.')
        return {
          ok: false,
          error: 'IPC request rejected from an untrusted renderer.',
          code: 'operation-failed'
        }
      }

      const parsed = schema.safeParse(rawArgs)
      if (!parsed.success) {
        const message =
          parsed.error.issues[0]?.message ?? 'Invalid IPC arguments.'
        if (mode === 'typed') throw new Error(message)
        return { ok: false, error: message, code: 'invalid-arguments' }
      }

      if (mode === 'typed') return handler(event, ...parsed.data)

      try {
        const result = await handler(event, ...parsed.data)
        if (mode === 'result') return { ok: true, value: result }

        const response = result as {
          ok?: unknown
          error?: unknown
          code?: string
        }
        if (response.ok === true || !('error' in response)) return result
        return { ...response, code: response.code ?? 'operation-failed' }
      } catch (error) {
        console.error(`${channel} failed:`, error)
        return { ok: false, error: toMessage(error), code: errorCode(error) }
      }
    })
  }

  return { handle }
}
