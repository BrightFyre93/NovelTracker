import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const LOG_FILENAME = 'novel-tracker.log'
const MAX_LOG_BYTES = 5 * 1024 * 1024
const ROTATED_LOG_COUNT = 3
const SENSITIVE_KEY_PATTERN = /authorization|cookie|token|password|passwd|secret|api[-_]?key/i
const SENSITIVE_HEADER_PATTERN = /(^|\r?\n)([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)[ \t]*:[ \t]*)[^\r\n]*/gi
const SENSITIVE_FIELD_PATTERN =
  /((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|password|passwd|secret|x-api-key)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,\s;}]+)/gi

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface StructuredLogEntry {
  timestamp: string
  level: LogLevel
  processId: number
  appVersion: string
  message: unknown
  context: unknown[]
}

let initialized = false
let logPath = ''
let writeQueue = Promise.resolve()
let originalConsole: Pick<Console, 'debug' | 'error' | 'info' | 'log' | 'warn'> | null = null

export function redactLogString(value: string): string {
  return value
    .replace(SENSITIVE_HEADER_PATTERN, '$1$2[REDACTED]')
    .replace(SENSITIVE_FIELD_PATTERN, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
}

function safeValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactLogString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object' || value === null) return value
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength} bytes]`
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactLogString(value.message),
      stack: value.stack ? redactLogString(value.stack) : undefined
    }
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item, '', seen))

  const result: Record<string, unknown> = {}
  for (const [property, child] of Object.entries(value)) {
    result[property] = safeValue(child, property, seen)
  }
  return result
}

function rotateLogs(): Promise<void> {
  return (async () => {
    let currentSize = 0
    try {
      currentSize = (await stat(logPath)).size
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (currentSize < MAX_LOG_BYTES) return

    await rm(`${logPath}.${ROTATED_LOG_COUNT}`, { force: true })
    for (let index = ROTATED_LOG_COUNT - 1; index >= 1; index -= 1) {
      try {
        await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await rename(logPath, `${logPath}.1`)
  })()
}

function queueLogWrite(entry: StructuredLogEntry): void {
  const line = `${JSON.stringify(entry)}\n`
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(dirname(logPath), { recursive: true })
      await rotateLogs()
      await appendFile(logPath, line, 'utf8')
    })
    .catch((error: unknown) => {
      originalConsole?.error('Local log file could not be written:', error)
    })
}

export function initializeLocalLogger(dataDirectory: string, appVersion: string): void {
  if (initialized) return
  initialized = true
  logPath = join(dataDirectory, 'logs', LOG_FILENAME)
  originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console)
  }

  const write = (level: LogLevel, output: (...args: unknown[]) => void, args: unknown[]): void => {
    const values = args.map((value) => safeValue(value))
    output(...values)
    queueLogWrite({
      timestamp: new Date().toISOString(),
      level,
      processId: process.pid,
      appVersion,
      message: values[0] ?? '',
      context: values.slice(1)
    })
  }

  console.debug = (...args: unknown[]) => write('debug', originalConsole!.debug, args)
  console.info = (...args: unknown[]) => write('info', originalConsole!.info, args)
  console.log = (...args: unknown[]) => write('info', originalConsole!.log, args)
  console.warn = (...args: unknown[]) => write('warn', originalConsole!.warn, args)
  console.error = (...args: unknown[]) => write('error', originalConsole!.error, args)
}
