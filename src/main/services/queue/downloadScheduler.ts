export class DownloadScheduler {
  private running = false
  private requested = false
  private currentTask: Promise<void> | null = null

  constructor(
    private readonly drain: () => Promise<void>,
    private readonly isShuttingDown: () => boolean
  ) {}

  request(): Promise<void> {
    if (this.isShuttingDown()) return Promise.resolve()
    if (this.running) {
      this.requested = true
      return this.currentTask ?? Promise.resolve()
    }
    this.running = true
    const task = this.runRequests()
    this.currentTask = task
    return task
  }

  isRunning(): boolean {
    return this.running
  }

  private async runRequests(): Promise<void> {
    try {
      do {
        this.requested = false
        await this.drain()
      } while (this.requested && !this.isShuttingDown())
    } finally {
      this.running = false
      this.currentTask = null
    }
  }
}
