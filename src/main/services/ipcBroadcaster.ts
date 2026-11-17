import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { DiscoveryQueueItemSummary, DiscoveryQueueUpdate, DownloadHistoryEntry } from '../../shared/contracts'
import type { IpcEventChannel, IpcEventMap } from '../../shared/ipc'

export class IpcBroadcaster {
  private queueNotificationTimer: ReturnType<typeof setTimeout> | null = null
  private readonly queueBroadcastState = new Map<string, string>()
  private queueRevision = 0

  constructor(private readonly getWindows: () => BrowserWindow[]) {}

  get discoveryQueueRevision(): number {
    return this.queueRevision
  }

  sendToAll<Channel extends IpcEventChannel>(
    channel: Channel,
    value: IpcEventMap[Channel]
  ): void {
    for (const window of this.getWindows()) {
      const webContents = window.webContents
      if (webContents.isDestroyed() || webContents.isLoadingMainFrame()) continue
      const frame = webContents.mainFrame
      if (frame.isDestroyed()) continue
      this.send(frame, channel, value)
    }
  }

  sendToCurrentFrame = <Channel extends IpcEventChannel>(
    webContents: WebContents,
    frame: WebFrameMain | null,
    channel: Channel,
    value: IpcEventMap[Channel]
  ): void => {
    if (
      webContents.isDestroyed() ||
      webContents.isLoadingMainFrame() ||
      !frame ||
      frame.isDestroyed() ||
      webContents.mainFrame !== frame
    ) {
      return
    }
    this.send(frame, channel, value)
  }

  notifyDownloadHistoryChanged = (history: DownloadHistoryEntry[]): void => {
    this.sendToAll('download-history:update', history)
  }

  notifyDiscoveryQueueChanged(copyDiscoveryQueue: () => DiscoveryQueueItemSummary[]): void {
    if (this.queueNotificationTimer) return
    this.queueNotificationTimer = setTimeout(() => {
      this.queueNotificationTimer = null
      const items = copyDiscoveryQueue()
      const currentState = new Map(
        items.map((item) => [item.id, JSON.stringify(item)])
      )
      const upserted = items.filter(
        (item) => this.queueBroadcastState.get(item.id) !== currentState.get(item.id)
      )
      const removedIds = [...this.queueBroadcastState.keys()].filter(
        (id) => !currentState.has(id)
      )
      this.queueBroadcastState.clear()
      for (const [id, snapshot] of currentState)
        this.queueBroadcastState.set(id, snapshot)
      if (upserted.length === 0 && removedIds.length === 0) return
      const update: DiscoveryQueueUpdate = {
        revision: ++this.queueRevision,
        upserted,
        removedIds,
        order: items.map((item) => item.id)
      }
      this.sendToAll('discovery-queue:update', update)
    }, 1000)
  }

  clearDiscoveryQueueNotification(): void {
    if (!this.queueNotificationTimer) return
    clearTimeout(this.queueNotificationTimer)
    this.queueNotificationTimer = null
  }

  private send<Channel extends IpcEventChannel>(
    frame: WebFrameMain,
    channel: Channel,
    value: IpcEventMap[Channel]
  ): void {
    frame.send(channel, value)
  }
}
