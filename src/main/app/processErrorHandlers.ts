import { app, dialog } from 'electron'
import { toMessage } from '../../shared/errors'

let fatalProcessErrorHandled = false

function handleFatalProcessError(error: unknown): void {
  console.error('Fatal process error (uncaughtException):', error)
  if (fatalProcessErrorHandled) return
  fatalProcessErrorHandled = true
  dialog.showErrorBox(
    'NovelTracker encountered an unexpected error',
    `The application will close to protect your data.\n\n${toMessage(error)}`
  )
  app.quit()
}

export function registerProcessErrorHandlers(): void {
  process.on('uncaughtException', handleFatalProcessError)
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled background promise rejection:', reason)
  })
}
