import type { ChapterContentBlock, ChapterInlineNode } from './contracts'
import { z } from 'zod'

function isSafeHttpHref(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function createInlineNodeSchema(depth = 0): z.ZodType<ChapterInlineNode> {
  const children =
    depth >= 32
      ? z.array(z.never()).refine(() => false)
      : z.array(createInlineNodeSchema(depth + 1))

  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('break') }),
    z.object({ type: z.literal('emphasis'), children }),
    z.object({ type: z.literal('strong'), children }),
    z.object({
      type: z.literal('link'),
      href: z.string().refine(isSafeHttpHref),
      children
    })
  ])
}

export const chapterContentBlockSchema: z.ZodType<ChapterContentBlock> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('paragraph'),
      text: z.string(),
      inline: z.array(createInlineNodeSchema()).optional()
    }),
    z.object({
      type: z.literal('heading'),
      level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
      text: z.string(),
      inline: z.array(createInlineNodeSchema()).optional()
    }),
    z.object({
      type: z.literal('blockquote'),
      text: z.string(),
      inline: z.array(createInlineNodeSchema()).optional()
    }),
    z.object({
      type: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(
        z.object({
          text: z.string(),
          inline: z.array(createInlineNodeSchema()).optional()
        })
      )
    }),
    z.object({ type: z.literal('scene-break') }),
    z.object({
      type: z.literal('image'),
      imageIndex: z.number().int().min(0),
      alt: z.string().max(1000)
    })
  ])

export function chapterContentBlocksSchema(imageCount: number) {
  return z.array(chapterContentBlockSchema).superRefine((blocks, context) => {
    blocks.forEach((block, index) => {
      if (block.type === 'image' && block.imageIndex >= imageCount) {
        context.addIssue({
          code: 'custom',
          path: [index, 'imageIndex'],
          message: 'Chapter image references must point to a saved image.'
        })
      }
    })
  })
}
