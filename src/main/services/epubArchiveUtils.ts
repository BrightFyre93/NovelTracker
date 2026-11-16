import { posix } from 'node:path'
import type JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

export type XmlObject = Record<string, unknown>

export interface ArchivePathMessages {
  malformedPath: string
  unsafePath: string
  externalReference?: string
}

export function createXmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true
  })
}

export function object(value: unknown): XmlObject {
  return typeof value === 'object' && value !== null ? (value as XmlObject) : {}
}

export function entries(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

export function text(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim()
  }
  const nestedText = object(value)['#text']
  return nestedText === undefined ? '' : text(nestedText)
}

export function xmlObjects(value: unknown): XmlObject[] {
  return entries(value).map(object)
}

export function normalizeArchivePath(
  value: string,
  invalidPathMessage: string
): string {
  const path = posix.normalize(value.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!path || path === '.' || path.startsWith('../')) {
    throw new Error(invalidPathMessage)
  }
  return path
}

export function resolveArchivePath(
  documentPath: string,
  href: string,
  messages: ArchivePathMessages
): string | null {
  const pathPart = href.split(/[?#]/, 1)[0]
  if (
    !pathPart ||
    pathPart.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(pathPart)
  ) {
    if (messages.externalReference) {
      throw new Error(messages.externalReference)
    }
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathPart)
  } catch {
    throw new Error(messages.malformedPath)
  }

  const path = posix.normalize(
    posix.join(posix.dirname(documentPath), decodedPath.replace(/\\/g, '/'))
  )
  if (path === '..' || path.startsWith('../')) {
    throw new Error(messages.unsafePath)
  }
  return path
}

export async function readEntry(
  entry: JSZip.JSZipObject,
  limit: number,
  limitLabel = 'safety limit'
): Promise<Buffer> {
  const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & {
    destroy(error?: Error): void
  }
  return new Promise<Buffer>((resolveEntry, rejectEntry) => {
    const chunks: Buffer[] = []
    let length = 0
    stream.on('data', (value: Buffer | Uint8Array) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      length += chunk.byteLength
      if (length > limit) {
        stream.destroy(
          new Error(
            `An EPUB resource exceeds the ${limit.toLocaleString()} byte ${limitLabel}.`
          )
        )
        return
      }
      chunks.push(chunk)
    })
    stream.once('error', rejectEntry)
    stream.once('end', () => resolveEntry(Buffer.concat(chunks, length)))
  })
}
