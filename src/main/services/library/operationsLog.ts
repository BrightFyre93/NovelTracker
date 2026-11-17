import { randomUUID } from 'node:crypto'
import type { LibraryOperation } from '../../../shared/contracts'
import { writeLibraryOperations } from '../localStore'
import { SerialQueue } from '../serialQueue'

export function createLibraryOperationsLog(
  dataDirectory: () => string,
  publish: (operations: LibraryOperation[]) => void
) {
  const writes = new SerialQueue()
  let operations: LibraryOperation[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function copy(): LibraryOperation[] {
    return operations.map((operation) => ({
      ...operation,
      inputFiles: [...operation.inputFiles]
    }))
  }

  function persist(): Promise<void> {
    const snapshot = copy()
    return writes.enqueue(() => writeLibraryOperations(dataDirectory(), snapshot))
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    publish(copy())
    try {
      await persist()
    } catch (error) {
      console.error('Library operation history could not be saved:', error)
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, 500)
  }

  async function start(
    input: Omit<LibraryOperation, 'id' | 'status' | 'startedAt' | 'updatedAt'>
  ): Promise<string> {
    const now = new Date().toISOString()
    const operation: LibraryOperation = {
      ...input,
      id: randomUUID(),
      status: 'running',
      startedAt: now,
      updatedAt: now,
      inputFiles: [...input.inputFiles]
    }
    operations.unshift(operation)
    while (operations.length > 30) {
      let removableIndex = -1
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        if (operations[index]?.status !== 'running') {
          removableIndex = index
          break
        }
      }
      if (removableIndex < 0) break
      operations.splice(removableIndex, 1)
    }
    await flush()
    return operation.id
  }

  async function update(
    id: string,
    update: Partial<
      Pick<
        LibraryOperation,
        'status' | 'outputPath' | 'progress' | 'message' | 'error'
      >
    >,
    flushImmediately = false
  ): Promise<void> {
    const index = operations.findIndex((operation) => operation.id === id)
    if (index < 0) return
    const operation = operations[index]
    if (!operation) return
    Object.assign(operation, update, { updatedAt: new Date().toISOString() })
    operations.splice(index, 1)
    operations.unshift(operation)
    if (flushImmediately) await flush()
    else scheduleFlush()
  }

  return {
    copy,
    drain: () => writes.drain(),
    flush,
    outputPaths: () =>
      operations
        .filter(
          (operation): operation is LibraryOperation & { outputPath: string } =>
            Boolean(operation.outputPath)
        )
        .map((operation) => operation.outputPath),
    set: (next: LibraryOperation[]) => {
      operations = next
    },
    start,
    update
  }
}
