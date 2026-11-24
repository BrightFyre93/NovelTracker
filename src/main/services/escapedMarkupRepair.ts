import { renderChapterBlocksXhtml } from './epub'
import {
  looksLikeEscapedMarkup,
  markupFromXhtmlInner,
  textFromXhtmlInner
} from './scrape/escapedMarkup'
import { blocksFromEscapedMarkup } from './scrape/escapedMarkupBlocks'

const PARAGRAPH = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g

/**
 * Rewrites the paragraphs of a chapter page (XHTML) that hold escaped page
 * markup: the story paragraphs are rebuilt and scripts, advertisements and the
 * page footer are removed. Other paragraphs are left byte for byte as they are.
 */
export function repairEscapedMarkupInXhtml(xhtml: string): {
  contents: string
  paragraphCount: number
} {
  if (!xhtml.includes('&lt;')) return { contents: xhtml, paragraphCount: 0 }
  let paragraphCount = 0
  const contents = xhtml.replace(PARAGRAPH, (whole: string, inner: string) => {
    if (!inner.includes('&lt;')) return whole
    if (!looksLikeEscapedMarkup(textFromXhtmlInner(inner))) return whole
    paragraphCount += 1
    return renderChapterBlocksXhtml(blocksFromEscapedMarkup(markupFromXhtmlInner(inner)))
  })
  return { contents, paragraphCount }
}
