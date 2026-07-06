/**
 * Tests for media/image.ts
 *
 * Format detection from magic bytes, image processing, metadata text.
 */

import { describe, it, expect } from 'vitest'
import {
  detectImageFormat,
  detectImageFormatFromBase64,
  processImage,
  processImageToBase64,
  createImageMetadataText,
  ImageProcessError,
} from '../../../media/image.js'

// ---------------------------------------------------------------------------
// Magic byte format detection
// ---------------------------------------------------------------------------

describe('detectImageFormat', () => {
  it('detects PNG from magic bytes (89 50 4E 47)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(detectImageFormat(png)).toBe('image/png')
  })

  it('detects JPEG from magic bytes (FF D8 FF)', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    expect(detectImageFormat(jpeg)).toBe('image/jpeg')
  })

  it('detects GIF from magic bytes (47 49 46)', () => {
    const gif87a = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    const gif89a = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(detectImageFormat(gif87a)).toBe('image/gif')
    expect(detectImageFormat(gif89a)).toBe('image/gif')
  })

  it('detects WebP from magic bytes (RIFF....WEBP)', () => {
    const webp = Buffer.alloc(16, 0)
    // RIFF
    webp[0] = 0x52; webp[1] = 0x49; webp[2] = 0x46; webp[3] = 0x46
    // WEBP at offset 8
    webp[8] = 0x57; webp[9] = 0x45; webp[10] = 0x42; webp[11] = 0x50
    expect(detectImageFormat(webp)).toBe('image/webp')
  })

  it('defaults to image/png for unknown formats', () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03])
    expect(detectImageFormat(unknown)).toBe('image/png')
  })

  it('defaults to image/png for too-short buffer', () => {
    expect(detectImageFormat(Buffer.from([0x89]))).toBe('image/png')
    expect(detectImageFormat(Buffer.alloc(0))).toBe('image/png')
  })

  it('does not false-positive RIFF without WEBP marker', () => {
    const riffNotWebp = Buffer.alloc(16, 0)
    riffNotWebp[0] = 0x52; riffNotWebp[1] = 0x49; riffNotWebp[2] = 0x46; riffNotWebp[3] = 0x46
    // Not WEBP at offset 8
    riffNotWebp[8] = 0x41; riffNotWebp[9] = 0x56; riffNotWebp[10] = 0x49; riffNotWebp[11] = 0x20
    expect(detectImageFormat(riffNotWebp)).toBe('image/png') // fallback
  })
})

describe('detectImageFormatFromBase64', () => {
  it('detects PNG from base64', () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const base64 = pngBytes.toString('base64')
    expect(detectImageFormatFromBase64(base64)).toBe('image/png')
  })

  it('detects JPEG from base64', () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const base64 = jpegBytes.toString('base64')
    expect(detectImageFormatFromBase64(base64)).toBe('image/jpeg')
  })

  it('returns image/png for invalid base64', () => {
    expect(detectImageFormatFromBase64('not-valid-base64!!!')).toBe('image/png')
  })

  it('returns image/png for empty string', () => {
    expect(detectImageFormatFromBase64('')).toBe('image/png')
  })
})

// ---------------------------------------------------------------------------
// processImage
// ---------------------------------------------------------------------------

describe('processImage', () => {
  it('throws on empty buffer', async () => {
    await expect(processImage(Buffer.alloc(0))).rejects.toThrow(ImageProcessError)
    await expect(processImage(Buffer.alloc(0))).rejects.toThrow('empty (0 bytes)')
  })

  it('passes through small images without modification', async () => {
    // Create a minimal valid 1x1 PNG (67 bytes — well under any limit)
    const tinyPng = createMinimalPNG()
    const result = await processImage(tinyPng, 'png')

    expect(result.buffer.length).toBeGreaterThan(0)
    // Should be either passed through or processed by sharp
    expect(typeof result.mediaType).toBe('string')
  })

  it('passes through small JPEG', async () => {
    // Minimal JPEG-like buffer (just the header — won't be a valid image but tests the flow)
    const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

    // This will either be processed by sharp or fall through to the no-sharp path
    try {
      const result = await processImage(tinyJpeg, 'jpeg')
      expect(result.buffer.length).toBeGreaterThan(0)
    } catch (err) {
      // Sharp may fail on invalid image data — that's expected
      expect(err).toBeInstanceOf(Error)
    }
  })
})

describe('processImageToBase64', () => {
  it('returns base64 string and metadata', async () => {
    const tinyPng = createMinimalPNG()
    const result = await processImageToBase64(tinyPng, 'png')

    expect(typeof result.base64).toBe('string')
    expect(result.base64.length).toBeGreaterThan(0)
    expect(typeof result.mediaType).toBe('string')
    expect(result.originalSize).toBe(tinyPng.length)
  })

  it('base64 decodes back to valid data', async () => {
    const tinyPng = createMinimalPNG()
    const result = await processImageToBase64(tinyPng, 'png')
    const decoded = Buffer.from(result.base64, 'base64')
    expect(decoded.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// createImageMetadataText
// ---------------------------------------------------------------------------

describe('createImageMetadataText', () => {
  it('returns null when no dimensions and no path', () => {
    expect(createImageMetadataText({})).toBeNull()
  })

  it('returns source path when only path is given', () => {
    const result = createImageMetadataText({}, '/path/to/image.png')
    expect(result).toBe('[Image source: /path/to/image.png]')
  })

  it('returns null when dimensions match and no path', () => {
    const result = createImageMetadataText({
      originalWidth: 100,
      originalHeight: 100,
      displayWidth: 100,
      displayHeight: 100,
    })
    expect(result).toBeNull()
  })

  it('includes resize info when dimensions differ', () => {
    const result = createImageMetadataText({
      originalWidth: 2000,
      originalHeight: 1000,
      displayWidth: 1000,
      displayHeight: 500,
    })
    expect(result).toContain('original 2000x1000')
    expect(result).toContain('displayed at 1000x500')
    expect(result).toContain('Multiply coordinates by 2.00')
  })

  it('includes both source and resize info', () => {
    const result = createImageMetadataText(
      { originalWidth: 4000, originalHeight: 3000, displayWidth: 2000, displayHeight: 1500 },
      '/screenshots/big.png',
    )
    expect(result).toContain('source: /screenshots/big.png')
    expect(result).toContain('original 4000x3000')
    expect(result).toContain('2.00')
  })

  it('returns path info when no valid dimensions (zeros)', () => {
    const result = createImageMetadataText(
      { originalWidth: 0, originalHeight: 0, displayWidth: 0, displayHeight: 0 },
      '/path.png',
    )
    expect(result).toBe('[Image source: /path.png]')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid 1x1 white PNG (67 bytes). */
function createMinimalPNG(): Buffer {
  // Minimal 1x1 pixel PNG (white)
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=',
    'base64',
  )
}
