export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  drain(): Promise<void> {
    return this.tail
  }
}
