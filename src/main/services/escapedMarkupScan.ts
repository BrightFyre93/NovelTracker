import { looksLikeEscapedMarkup, textFromXhtmlInner } from './scrape/escapedMarkup'

const PARAGRAPH = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g

/**
 * Number of paragraphs of a chapter page (XHTML) whose text holds escaped page
 * markup. The check is cheap for normal chapters: pages without an escaped
 * "<" are skipped before any paragraph is looked at.
 */
export function countEscapedMarkupParagraphs(xhtml: string): number {
  if (!xhtml.includes('&lt;')) return 0
  let count = 0
  for (const match of xhtml.matchAll(PARAGRAPH)) {
    const inner = match[1] ?? ''
    if (!inner.includes('&lt;')) continue
    if (looksLikeEscapedMarkup(textFromXhtmlInner(inner))) count += 1
  }
  return count
}

/** Title of a chapter page, for showing which chapters are affected. */
export function readXhtmlTitle(xhtml: string): string {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(xhtml)?.[1] ?? ''
  return title
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}
