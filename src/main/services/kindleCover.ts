import sharp from 'sharp'

export const MIN_KINDLE_COVER_WIDTH = 625
export const MIN_KINDLE_COVER_HEIGHT = 1000
export const RESIZED_KINDLE_COVER_WIDTH = 1000
export const RESIZED_KINDLE_COVER_HEIGHT = 1600

export async function resizeSmallKindleCover(data: Buffer): Promise<Buffer | null> {
  const image = sharp(data, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate()
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('The cover image dimensions could not be read.')
  const rotated = metadata.orientation !== undefined && [5, 6, 7, 8].includes(metadata.orientation)
  const width = rotated ? metadata.height : metadata.width
  const height = rotated ? metadata.width : metadata.height
  if (width >= MIN_KINDLE_COVER_WIDTH && height >= MIN_KINDLE_COVER_HEIGHT) return null

  return image
    .resize(RESIZED_KINDLE_COVER_WIDTH, RESIZED_KINDLE_COVER_HEIGHT, {
      fit: 'contain',
      background: '#ffffff'
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer()
}
