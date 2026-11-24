import type { ChapterInlineNode } from '../../../shared/contracts'

/**
 * Some novel pages contain page markup that was escaped and pasted into the
 * chapter text (an advertisement block, the page footer, even the closing
 * </body></html>). Read as text it shows up as "</p><p> ... <script>..." inside
 * one huge paragraph. The functions here find that situation and turn the
 * escaped markup back into the paragraphs it was meant to be, dropping scripts,
 * advertisements and the page chrome.
 *
 * Angle brackets are also normal story text ("<Status Ailment: Burning>", "<A
 * Sub Scenario is being triggered…>"), so a "<" is only treated as a tag when
 * the whole tag is well formed HTML: a known tag name and attributes that are
 * written as name="value". Prose such as "<I saw you staring…>" does not match.
 */

const MAX_MARKUP_LENGTH = 2_000_000

const QUOTED_VALUE =
  String.raw`"[^"]*"|'[^']*'|[“”″„‟][^“”″„‟"]*[“”″„‟"]|[‘’′][^‘’′']*[‘’′']`
const ATTRIBUTE_VALUE = String.raw`(?:${QUOTED_VALUE}|[^\s"'“”″‘’′<>=` + '`' + String.raw`]+)`
const ATTRIBUTE_NAME = String.raw`[a-zA-Z_:][-\w:.]*`
const VALUELESS_ATTRIBUTE =
  'async|defer|disabled|selected|readonly|checked|hidden|crossorigin|itemscope|allowfullscreen|novalidate'
const ATTRIBUTE =
  String.raw`\s+(?:${ATTRIBUTE_NAME}\s*=\s*${ATTRIBUTE_VALUE}|(?:${VALUELESS_ATTRIBUTE})(?=[\s/>]))`
const TAG_NAMES =
  'p|br|hr|div|span|a|i|b|u|em|strong|small|center|font|section|article|nav|header|footer|main|aside|' +
  'h[1-6]|ul|ol|li|blockquote|img|figure|figcaption|table|thead|tbody|tr|td|th|button|select|option|' +
  'textarea|label|input|form|link|meta|body|html|head|title|sup|sub|ins'

function tagPattern(): RegExp {
  return new RegExp(
    String.raw`<(\/?)(${TAG_NAMES})((?:${ATTRIBUTE})*)\s*(\/?)>`,
    'gi'
  )
}

const RAW_TEXT_ELEMENTS = /<(script|style|noscript|iframe)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi
const UNCLOSED_RAW_TEXT_ELEMENT = /<(?:script|style|noscript|iframe)(?=[\s>/])[^>]*>/i
const COMMENT = /<!(?:--|–|—)[\s\S]*?(?:--|–|—)>/g

/** Text that only appears when page code leaked into a chapter. */
export const PAGE_CODE_PATTERN =
  /<\/?(?:script|style|iframe|noscript)(?=[\s>/])|<\/(?:body|html)>|<!(?:--|–|—)|document\.(?:getElementById|querySelector|onkeydown)|window\.(?:dataLayer|pubfuturetag|location)/i

/**
 * True when the plain text of a paragraph holds escaped page markup. Pass text
 * only (no real tags) so that ordinary italics are not counted.
 */
export function looksLikeEscapedMarkup(text: string): boolean {
  if (text.length < 8 || text.length > MAX_MARKUP_LENGTH) return false
  if (/<\/(?:body|html)>|<(?:script|style|iframe)(?=[\s>/])/i.test(text)) return true
  let count = 0
  for (const _match of text.matchAll(tagPattern())) {
    count += 1
    if (count >= 3) return true
  }
  return false
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Turns markup that was read as text back into a clean HTML fragment made only
 * of p, br, hr, em, strong, h2-h4, blockquote, ul, ol and li. Scripts, styles,
 * comments, advertisements and everything after the end of the chapter
 * container (an unmatched </div>, </body>, a footer, a form) are removed.
 * Anything that is not a well formed tag stays as text.
 */
export function expandEscapedMarkup(markup: string): string {
  let source = markup.length > MAX_MARKUP_LENGTH ? markup.slice(0, MAX_MARKUP_LENGTH) : markup
  source = source.replace(RAW_TEXT_ELEMENTS, '')
  // A script that never closes swallows the rest of the page: stop there.
  const unclosed = UNCLOSED_RAW_TEXT_ELEMENT.exec(source)
  if (unclosed) source = source.slice(0, unclosed.index)
  source = source.replace(COMMENT, '')

  const out: string[] = []
  let depth = 0
  let emphasisOpen = false
  let strongOpen = false
  let last = 0
  let stopped = false

  const closeInline = (): void => {
    if (emphasisOpen) out.push('</em>')
    if (strongOpen) out.push('</strong>')
    emphasisOpen = false
    strongOpen = false
  }
  const boundary = (opening: string, closing: string): void => {
    closeInline()
    out.push(closing, opening)
  }

  for (const match of source.matchAll(tagPattern())) {
    const index = match.index ?? 0
    out.push(escapeText(source.slice(last, index)))
    last = index + match[0].length
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()

    if (name === 'div') {
      if (closing) {
        if (depth === 0) {
          stopped = true
          break
        }
        depth -= 1
      } else {
        depth += 1
      }
      boundary('<p>', '</p>')
    } else if (name === 'body' || name === 'html') {
      if (closing) {
        stopped = true
        break
      }
    } else if (
      !closing &&
      ['footer', 'nav', 'form', 'textarea', 'select', 'button', 'input'].includes(name)
    ) {
      stopped = true
      break
    } else if (
      name === 'p' ||
      name === 'h1' ||
      name === 'h5' ||
      name === 'h6' ||
      name === 'li' ||
      name === 'ul' ||
      name === 'ol'
    ) {
      boundary('<p>', '</p>')
    } else if (name === 'h2' || name === 'h3' || name === 'h4') {
      closeInline()
      out.push(closing ? `</${name}>` : `<${name}>`)
    } else if (name === 'blockquote') {
      closeInline()
      out.push(closing ? `</${name}>` : `<${name}>`)
    } else if (name === 'br') {
      out.push('<br/>')
    } else if (name === 'hr') {
      closeInline()
      out.push('<hr/>')
    } else if (name === 'i' || name === 'em') {
      if (closing) {
        if (emphasisOpen) out.push('</em>')
        emphasisOpen = false
      } else if (!emphasisOpen) {
        emphasisOpen = true
        out.push('<em>')
      }
    } else if (name === 'b' || name === 'strong') {
      if (closing) {
        if (strongOpen) out.push('</strong>')
        strongOpen = false
      } else if (!strongOpen) {
        strongOpen = true
        out.push('<strong>')
      }
    }
    // Every other recognised tag (span, a, img, section, ...) is dropped and
    // its text is kept.
  }
  if (!stopped) out.push(escapeText(source.slice(last)))
  closeInline()
  return out.join('')
}

/** Plain markup for chapter inline nodes (the real tags of the paragraph are kept). */
export function inlineNodesToMarkup(nodes: ChapterInlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text
      if (node.type === 'break') return '<br>'
      const children = inlineNodesToMarkup(node.children)
      if (node.type === 'emphasis') return `<em>${children}</em>`
      if (node.type === 'strong') return `<strong>${children}</strong>`
      return children
    })
    .join('')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Plain text of the inner XHTML of one paragraph written by this app (used to
 * decide whether it holds escaped markup).
 */
export function textFromXhtmlInner(inner: string): string {
  return decodeXmlEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * Markup for the inner XHTML of one paragraph written by this app: em, strong
 * and br stay real tags, links are unwrapped and entities are decoded, so that
 * escaped markup becomes visible to expandEscapedMarkup.
 */
export function markupFromXhtmlInner(inner: string): string {
  const withoutLinks = inner.replace(/<a\b[^>]*>/g, '').replace(/<\/a>/g, '')
  const parts = withoutLinks.split(/(<\/?(?:em|strong)>|<br\s*\/?>)/g)
  return parts
    .map((part, index) =>
      index % 2 === 1 ? (/^<br/i.test(part) ? '<br>' : part) : decodeXmlEntities(part)
    )
    .join('')
}
