import { posix } from 'node:path'
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
