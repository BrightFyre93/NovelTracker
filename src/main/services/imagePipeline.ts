import sharp from 'sharp'
import type { ChapterImage, EpubImageOutputFormat } from '../../shared/contracts'
import { MAX_IMAGE_BYTES } from '../../shared/constants'
import type { EpubOutputOptions } from '../../shared/contracts'
import { resizeSmallKindleCover } from './kindleCover'

export interface NormalizedEpubImage {
  mediaType: ChapterImage['mediaType']
  data: Buffer
}

export async function normalizeEpubImage(
  data: Buffer,
  mediaType: ChapterImage['mediaType'],
  options: Pick<
    EpubOutputOptions,
    | 'compressImages'
    | 'maxImageDimension'
    | 'imageFormat'
    | 'coverJpegOnly'
    | 'flattenAnimatedImages'
  >,
  isCover = false
): Promise<NormalizedEpubImage> {
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new Error('EPUB image data is empty or exceeds its size limit.')
  }

  try {
    if (isCover) {
      const resizedCover = await resizeSmallKindleCover(data)
      if (resizedCover) return { mediaType: 'image/jpeg', data: resizedCover }
    }

    const metadata = await sharp(data, {
      failOn: 'error',
      limitInputPixels: 40_000_000
    }).metadata()
    const animated = (metadata.pages ?? 1) > 1
    const mustConvertWebp = mediaType === 'image/webp'

    // Preserve animation by default. WebP still needs conversion for Kindle.
    if (animated && !options.flattenAnimatedImages && !mustConvertWebp && !isCover) {
      return { mediaType, data }
    }
    if (animated && !options.flattenAnimatedImages && mustConvertWebp && !isCover) {
      const animatedGif = await sharp(data, {
        failOn: 'error',
        limitInputPixels: 40_000_000,
        animated: true
      })
        .gif()
        .toBuffer()
      return { mediaType: 'image/gif', data: animatedGif }
    }

    const format = chooseFormat(
      options.imageFormat,
      mediaType,
      metadata.hasAlpha === true,
      isCover && options.coverJpegOnly
    )
    const needsResize =
      options.compressImages &&
      options.maxImageDimension > 0 &&
      Math.max(metadata.width ?? 0, metadata.height ?? 0) >
        options.maxImageDimension
    const needsFormatChange = mediaTypeForFormat(format) !== mediaType
    if (!needsResize && !needsFormatChange && !(isCover && options.coverJpegOnly)) {
      return { mediaType, data }
    }

    let image = sharp(data, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
      animated: options.flattenAnimatedImages ? false : undefined
    }).rotate()
    if (needsResize) {
      image = image.resize({
        width: options.maxImageDimension,
        height: options.maxImageDimension,
        fit: 'inside',
        withoutEnlargement: true
      })
    }
    if (format === 'jpeg') {
      image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 90 })
    } else if (format === 'png') {
      image = image.png()
    } else if (format === 'gif') {
      image = image.gif()
    }
    const normalized = await image.toBuffer()
    if (normalized.length === 0) throw new Error('The converted image is empty.')
    return { mediaType: mediaTypeForFormat(format), data: normalized }
  } catch (error) {
    throw new Error(
      `Image could not be normalized for EPUB output: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function chooseFormat(
  requested: EpubImageOutputFormat,
  original: ChapterImage['mediaType'],
  hasAlpha: boolean,
  coverJpegOnly: boolean
): 'jpeg' | 'png' | 'gif' {
  if (coverJpegOnly) return 'jpeg'
  if (requested === 'original') {
    if (original === 'image/webp') return hasAlpha ? 'png' : 'jpeg'
    return formatForMediaType(original)
  }
  if (requested === 'png') return 'png'
  return hasAlpha ? 'png' : 'jpeg'
}

function formatForMediaType(mediaType: ChapterImage['mediaType']): 'jpeg' | 'png' | 'gif' {
  if (mediaType === 'image/jpeg') return 'jpeg'
  if (mediaType === 'image/gif') return 'gif'
  return 'png'
}

function mediaTypeForFormat(format: 'jpeg' | 'png' | 'gif'): ChapterImage['mediaType'] {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'gif') return 'image/gif'
  return 'image/png'
}

export async function convertWebpToJpeg(data: Buffer): Promise<Buffer> {
  const result = await normalizeEpubImage(
    data,
    'image/webp',
    {
      compressImages: false,
      maxImageDimension: 0,
      imageFormat: 'jpeg',
      coverJpegOnly: true,
      flattenAnimatedImages: true
    },
    true
  )
  if (result.mediaType !== 'image/jpeg') {
    throw new Error('WebP repair conversion did not produce JPEG output.')
  }
  return result.data
}
