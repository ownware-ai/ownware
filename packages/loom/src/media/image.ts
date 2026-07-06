/**
 * Image Processing
 *
 * Resize, compress, and detect image formats for API consumption.
 * Uses `sharp` when available, falls back to raw buffer passthrough.
 *
 * Design: Multi-strategy compression pipeline.
 * 1. If image fits constraints → passthrough (no processing)
 * 2. If too large but dimensions OK → compress (PNG palette, JPEG quality cascade)
 * 3. If dimensions too large → resize then compress
 * 4. Last resort → aggressive JPEG at 400px / quality 20
 *
 * Sharp is an optional dependency. When unavailable, images that already
 * fit the API limit pass through; oversized images throw with a clear message.
 */

import {
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  IMAGE_TARGET_RAW_SIZE,
  API_IMAGE_MAX_BASE64_SIZE,
  type ImageMediaType,
} from './constants.js'
import type { ImageProcessResult, ImageDimensions, CompressedImageResult } from './types.js'

// ---------------------------------------------------------------------------
// Sharp loader (lazy, optional)
// ---------------------------------------------------------------------------

type SharpFn = (input: Buffer) => SharpInstance
interface SharpInstance {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
  resize(w: number, h: number, opts?: { fit?: string; withoutEnlargement?: boolean }): SharpInstance
  jpeg(opts?: { quality?: number }): SharpInstance
  png(opts?: { compressionLevel?: number; palette?: boolean; colors?: number }): SharpInstance
  webp(opts?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

let _sharp: SharpFn | null | undefined // undefined = not yet attempted

async function getSharp(): Promise<SharpFn | null> {
  if (_sharp !== undefined) return _sharp
  try {
    const mod = await import('sharp')
    _sharp = (mod.default ?? mod) as unknown as SharpFn
    return _sharp
  } catch {
    _sharp = null
    return null
  }
}

// ---------------------------------------------------------------------------
// Format detection (magic bytes — no deps)
// ---------------------------------------------------------------------------

/**
 * Detect image format from buffer magic bytes.
 * Returns MIME type. Defaults to 'image/png' if unknown.
 */
export function detectImageFormat(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return 'image/png'

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 47 49 46 (GIF87a or GIF89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp'
  }

  return 'image/png'
}

/**
 * Detect image format from base64 data.
 */
export function detectImageFormatFromBase64(base64: string): ImageMediaType {
  try {
    return detectImageFormat(Buffer.from(base64, 'base64'))
  } catch {
    return 'image/png'
  }
}

// ---------------------------------------------------------------------------
// Resize + compress pipeline
// ---------------------------------------------------------------------------

export class ImageProcessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageProcessError'
  }
}

/**
 * Process an image buffer to meet API size and dimension constraints.
 *
 * Strategy:
 * 1. If fits constraints → passthrough
 * 2. If dimensions OK but too large → compress (PNG palette, JPEG quality cascade)
 * 3. If dimensions too large → resize + compress
 * 4. Last resort → aggressive resize + JPEG quality 20
 *
 * When sharp is unavailable, passes through if under API limit, throws otherwise.
 */
export async function processImage(
  imageBuffer: Buffer,
  ext?: string,
): Promise<ImageProcessResult> {
  if (imageBuffer.length === 0) {
    throw new ImageProcessError('Image file is empty (0 bytes)')
  }

  const sharp = await getSharp()

  if (!sharp) {
    // No sharp — check if raw image fits the API base64 limit
    const base64Size = Math.ceil((imageBuffer.length * 4) / 3)
    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE) {
      const detected = detectImageFormat(imageBuffer)
      return { buffer: imageBuffer, mediaType: detected }
    }
    throw new ImageProcessError(
      `Image exceeds the 5 MB API limit and sharp is not installed for compression. ` +
      `Install sharp (npm i sharp) or resize the image manually.`,
    )
  }

  try {
    const image = sharp(imageBuffer)
    const metadata = await image.metadata()
    const format = metadata.format ?? ext ?? 'png'
    const normalizedFormat = format === 'jpg' ? 'jpeg' : format

    // No dimensions available — try basic compress or passthrough
    if (!metadata.width || !metadata.height) {
      if (imageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
        const compressed = await sharp(imageBuffer).jpeg({ quality: 80 }).toBuffer()
        return { buffer: compressed, mediaType: 'image/jpeg' }
      }
      return { buffer: imageBuffer, mediaType: `image/${normalizedFormat}` as ImageMediaType }
    }

    const originalWidth = metadata.width
    const originalHeight = metadata.height
    let width = originalWidth
    let height = originalHeight

    // Already fits? Passthrough.
    if (
      imageBuffer.length <= IMAGE_TARGET_RAW_SIZE &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_MAX_HEIGHT
    ) {
      return {
        buffer: imageBuffer,
        mediaType: `image/${normalizedFormat}` as ImageMediaType,
        dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
      }
    }

    const needsDimensionResize = width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT
    const isPng = normalizedFormat === 'png'

    // Dimensions OK but too large — try compression first (preserve resolution)
    if (!needsDimensionResize && imageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      if (isPng) {
        const pngCompressed = await sharp(imageBuffer).png({ compressionLevel: 9, palette: true }).toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'image/png',
            dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
          }
        }
      }
      for (const quality of [80, 60, 40, 20]) {
        const jpegBuf = await sharp(imageBuffer).jpeg({ quality }).toBuffer()
        if (jpegBuf.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: jpegBuf,
            mediaType: 'image/jpeg',
            dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
          }
        }
      }
    }

    // Constrain dimensions
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width)
      width = IMAGE_MAX_WIDTH
    }
    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height)
      height = IMAGE_MAX_HEIGHT
    }

    // Resize
    const resized = await sharp(imageBuffer)
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      .toBuffer()

    if (resized.length <= IMAGE_TARGET_RAW_SIZE) {
      return {
        buffer: resized,
        mediaType: `image/${normalizedFormat}` as ImageMediaType,
        dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
      }
    }

    // Resized but still too large — compress
    if (isPng) {
      const pngResized = await sharp(imageBuffer)
        .resize(width, height, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true })
        .toBuffer()
      if (pngResized.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: pngResized,
          mediaType: 'image/png',
          dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
        }
      }
    }

    for (const quality of [80, 60, 40, 20]) {
      const jpegResized = await sharp(imageBuffer)
        .resize(width, height, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer()
      if (jpegResized.length <= IMAGE_TARGET_RAW_SIZE) {
        return {
          buffer: jpegResized,
          mediaType: 'image/jpeg',
          dimensions: { originalWidth, originalHeight, displayWidth: width, displayHeight: height },
        }
      }
    }

    // Last resort — aggressive downscale + compress
    const smallWidth = Math.min(width, 400)
    const smallHeight = Math.round((height * smallWidth) / Math.max(width, 1))
    const ultraCompressed = await sharp(imageBuffer)
      .resize(smallWidth, smallHeight, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer()

    return {
      buffer: ultraCompressed,
      mediaType: 'image/jpeg',
      dimensions: { originalWidth, originalHeight, displayWidth: smallWidth, displayHeight: smallHeight },
    }
  } catch (err) {
    // Sharp failed — fallback: if raw fits API limit, pass through
    const detected = detectImageFormat(imageBuffer)
    const base64Size = Math.ceil((imageBuffer.length * 4) / 3)

    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE) {
      return { buffer: imageBuffer, mediaType: detected }
    }

    throw new ImageProcessError(
      `Unable to process image (${formatBytes(imageBuffer.length)} raw, ${formatBytes(base64Size)} base64). ` +
      `Exceeds 5 MB API limit and compression failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Process an image and return base64 + metadata.
 */
export async function processImageToBase64(
  imageBuffer: Buffer,
  ext?: string,
): Promise<CompressedImageResult> {
  const result = await processImage(imageBuffer, ext)
  return {
    base64: result.buffer.toString('base64'),
    mediaType: result.mediaType,
    originalSize: imageBuffer.length,
    dimensions: result.dimensions,
  }
}

/**
 * Create image metadata text for coordinate mapping (used when images are resized).
 */
export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims
  if (!originalWidth || !originalHeight || !displayWidth || !displayHeight) {
    return sourcePath ? `[Image source: ${sourcePath}]` : null
  }

  const wasResized = originalWidth !== displayWidth || originalHeight !== displayHeight
  if (!wasResized && !sourcePath) return null

  const parts: string[] = []
  if (sourcePath) parts.push(`source: ${sourcePath}`)
  if (wasResized) {
    const scale = originalWidth / displayWidth
    parts.push(
      `original ${originalWidth}x${originalHeight}, displayed at ${displayWidth}x${displayHeight}. ` +
      `Multiply coordinates by ${scale.toFixed(2)} to map to original image.`,
    )
  }

  return `[Image: ${parts.join(', ')}]`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
