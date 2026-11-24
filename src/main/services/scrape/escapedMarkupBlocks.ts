import { load } from 'cheerio'
import type {
  ChapterContentBlock,
  ChapterInlineNode
} from '../../../shared/contracts'
import { expandEscapedMarkup } from './escapedMarkup'

type Selection = ReturnType<ReturnType<typeof load>>
type Dom = ReturnType<typeof load>

function inlineFromSelection($: Dom, selection: Selection): ChapterInlineNode[] {
  const nodes: ChapterInlineNode[] = []
  selection.contents().each((_index, child) => {
    if (child.nodeType === 3) {
      const text = child.data.replace(/\s+/g, ' ')
      if (text) nodes.push({ type: 'text', text })
      return
    }
    if (child.nodeType !== 1 || !('tagName' in child)) return
    const tagName = child.tagName.toLowerCase()
    if (tagName === 'br') {
      nodes.push({ type: 'break' })
      return
    }
    const children = inlineFromSelection($, $(child))
    if (tagName === 'em') nodes.push({ type: 'emphasis', children })
    else if (tagName === 'strong') nodes.push({ type: 'strong', children })
    else nodes.push(...children)
  })
  return nodes
}

function textOfInline(nodes: ChapterInlineNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.text
      if (node.type === 'break') return '\n'
      return textOfInline(node.children)
    })
    .join('')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
}

function blockFrom(
  $: Dom,
  selection: Selection,
  kind: 'paragraph' | 'blockquote' | 'heading',
  level?: 2 | 3 | 4
): ChapterContentBlock | null {
  const inline = inlineFromSelection($, selection)
  const text = textOfInline(inline)
  if (!text) return null
  if (kind === 'heading') return { type: 'heading', level: level ?? 3, text, inline }
  return { type: kind, text, inline }
}

/**
 * Chapter blocks for markup that was read as text: scripts, advertisements,
 * comments and the page chrome are removed and the story paragraphs, italics,
 * bold text, headings, quotes and scene breaks are kept.
 */
export function blocksFromEscapedMarkup(markup: string): ChapterContentBlock[] {
  const $ = load(`<body>${expandEscapedMarkup(markup)}</body>`)
  const blocks: ChapterContentBlock[] = []
  const push = (block: ChapterContentBlock | null): void => {
    if (block) blocks.push(block)
  }
  $('body')
    .contents()
    .each((_index, node) => {
      if (node.nodeType === 3) {
        const text = node.data.replace(/\s+/g, ' ').trim()
        if (text) {
          blocks.push({ type: 'paragraph', text, inline: [{ type: 'text', text }] })
        }
        return
      }
      if (node.nodeType !== 1 || !('tagName' in node)) return
      const tagName = node.tagName.toLowerCase()
      const selection = $(node)
      if (tagName === 'p') push(blockFrom($, selection, 'paragraph'))
      else if (/^h[234]$/.test(tagName)) {
        push(blockFrom($, selection, 'heading', Number(tagName.slice(1)) as 2 | 3 | 4))
      } else if (tagName === 'blockquote') {
        const paragraphs = selection.children('p')
        if (paragraphs.length > 0) {
          paragraphs.each((_i, paragraph) => push(blockFrom($, $(paragraph), 'blockquote')))
        } else {
          push(blockFrom($, selection, 'blockquote'))
        }
      } else if (tagName === 'hr') blocks.push({ type: 'scene-break' })
    })
  return blocks
}
