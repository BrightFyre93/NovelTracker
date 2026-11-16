interface DiscoverySchedulerDependencies {
  concurrency: () => number
  run: (id: string) => Promise<unknown>
  trackBackgroundTask: (task: Promise<void>, label: string) => void
  isShuttingDown: () => boolean
}

export class DiscoveryScheduler {
  private readonly pending: string[] = []
  private readonly pendingIds = new Set<string>()
  private active = 0

  constructor(private readonly dependencies: DiscoverySchedulerDependencies) {}

  enqueue(id: string): void {
    if (this.pendingIds.has(id)) return
    this.pending.push(id)
    this.pendingIds.add(id)
    this.schedule()
  }

  enqueueMany(ids: string[]): void {
    for (const id of ids) {
      if (this.pendingIds.has(id)) continue
      this.pending.push(id)
      this.pendingIds.add(id)
    }
    this.schedule()
  }

  hasPending(id: string): boolean {
    return this.pendingIds.has(id)
  }

  remove(id: string): boolean {
    if (!this.pendingIds.delete(id)) return false
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index] === id) this.pending.splice(index, 1)
    }
    return true
  }

  clear(): void {
    this.pending.length = 0
    this.pendingIds.clear()
  }

  schedule(): void {
    while (
      !this.dependencies.isShuttingDown() &&
      this.active < this.dependencies.concurrency() &&
      this.pending.length > 0
    ) {
      const id = this.pending.shift()
      if (!id) continue
      this.pendingIds.delete(id)
      this.active += 1
      const task = this.dependencies
        .run(id)
        .then(() => undefined)
        .finally(() => {
          this.active -= 1
          if (!this.dependencies.isShuttingDown()) this.schedule()
        })
      this.dependencies.trackBackgroundTask(task, `Discovery task ${id}`)
    }
  }
}
