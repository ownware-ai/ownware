/**
 * Tests for media/constants.ts
 *
 * File type detection, binary detection, extension helpers.
 */

import { describe, it, expect } from 'vitest'
import {
  hasBinaryExtension,
  hasImageExtension,
  isPDFExtension,
  isNotebookExtension,
  isBinaryContent,
  BINARY_EXTENSIONS,
  IMAGE_EXTENSIONS,
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_TARGET_RAW_SIZE,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  PDF_TARGET_RAW_SIZE,
  PDF_MAX_PAGES_PER_READ,
  MAX_TEXT_READ_SIZE,
  BINARY_CHECK_SIZE,
} from '../../../media/constants.js'

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('has correct API image size limit (5 MB)', () => {
    expect(API_IMAGE_MAX_BASE64_SIZE).toBe(5 * 1024 * 1024)
  })

  it('target raw size is 3/4 of base64 limit', () => {
    expect(IMAGE_TARGET_RAW_SIZE).toBe((API_IMAGE_MAX_BASE64_SIZE * 3) / 4)
  })

  it('image dimensions are 2000x2000', () => {
    expect(IMAGE_MAX_WIDTH).toBe(2000)
    expect(IMAGE_MAX_HEIGHT).toBe(2000)
  })

  it('PDF target raw size is 20 MB', () => {
    expect(PDF_TARGET_RAW_SIZE).toBe(20 * 1024 * 1024)
  })

  it('PDF max pages per read is 20', () => {
    expect(PDF_MAX_PAGES_PER_READ).toBe(20)
  })

  it('text read size is 10 MB', () => {
    expect(MAX_TEXT_READ_SIZE).toBe(10 * 1024 * 1024)
  })

  it('binary check size is 8192 bytes', () => {
    expect(BINARY_CHECK_SIZE).toBe(8192)
  })
})

// ---------------------------------------------------------------------------
// hasBinaryExtension
// ---------------------------------------------------------------------------

describe('hasBinaryExtension', () => {
  it('detects common binary extensions', () => {
    expect(hasBinaryExtension('file.png')).toBe(true)
    expect(hasBinaryExtension('file.jpg')).toBe(true)
    expect(hasBinaryExtension('file.jpeg')).toBe(true)
    expect(hasBinaryExtension('file.gif')).toBe(true)
    expect(hasBinaryExtension('file.webp')).toBe(true)
    expect(hasBinaryExtension('file.pdf')).toBe(true)
    expect(hasBinaryExtension('file.zip')).toBe(true)
    expect(hasBinaryExtension('file.exe')).toBe(true)
    expect(hasBinaryExtension('file.dll')).toBe(true)
    expect(hasBinaryExtension('file.mp4')).toBe(true)
    expect(hasBinaryExtension('file.mp3')).toBe(true)
    expect(hasBinaryExtension('file.wasm')).toBe(true)
    expect(hasBinaryExtension('file.sqlite')).toBe(true)
  })

  it('does not flag text file extensions', () => {
    expect(hasBinaryExtension('file.ts')).toBe(false)
    expect(hasBinaryExtension('file.js')).toBe(false)
    expect(hasBinaryExtension('file.py')).toBe(false)
    expect(hasBinaryExtension('file.json')).toBe(false)
    expect(hasBinaryExtension('file.md')).toBe(false)
    expect(hasBinaryExtension('file.txt')).toBe(false)
    expect(hasBinaryExtension('file.html')).toBe(false)
    expect(hasBinaryExtension('file.css')).toBe(false)
    expect(hasBinaryExtension('file.yaml')).toBe(false)
    expect(hasBinaryExtension('file.toml')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(hasBinaryExtension('file.PNG')).toBe(true)
    expect(hasBinaryExtension('file.Jpg')).toBe(true)
    expect(hasBinaryExtension('file.PDF')).toBe(true)
  })

  it('handles paths with directories', () => {
    expect(hasBinaryExtension('/path/to/file.png')).toBe(true)
    expect(hasBinaryExtension('/path/to/file.ts')).toBe(false)
  })

  it('returns false for extensionless files', () => {
    expect(hasBinaryExtension('Makefile')).toBe(false)
    expect(hasBinaryExtension('Dockerfile')).toBe(false)
  })

  it('handles dotfiles', () => {
    expect(hasBinaryExtension('.gitignore')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hasImageExtension
// ---------------------------------------------------------------------------

describe('hasImageExtension', () => {
  it('detects image extensions', () => {
    expect(hasImageExtension('photo.png')).toBe(true)
    expect(hasImageExtension('photo.jpg')).toBe(true)
    expect(hasImageExtension('photo.jpeg')).toBe(true)
    expect(hasImageExtension('photo.gif')).toBe(true)
    expect(hasImageExtension('photo.webp')).toBe(true)
  })

  it('does not match non-image extensions', () => {
    expect(hasImageExtension('file.pdf')).toBe(false)
    expect(hasImageExtension('file.svg')).toBe(false)
    expect(hasImageExtension('file.bmp')).toBe(false)
    expect(hasImageExtension('file.ts')).toBe(false)
    expect(hasImageExtension('file.mp4')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(hasImageExtension('photo.PNG')).toBe(true)
    expect(hasImageExtension('photo.JPG')).toBe(true)
    expect(hasImageExtension('photo.WEBP')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isPDFExtension
// ---------------------------------------------------------------------------

describe('isPDFExtension', () => {
  it('detects .pdf', () => {
    expect(isPDFExtension('report.pdf')).toBe(true)
    expect(isPDFExtension('/path/to/report.pdf')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isPDFExtension('report.PDF')).toBe(true)
    expect(isPDFExtension('report.Pdf')).toBe(true)
  })

  it('does not match non-pdf', () => {
    expect(isPDFExtension('report.txt')).toBe(false)
    expect(isPDFExtension('report.doc')).toBe(false)
    expect(isPDFExtension('pdffile.txt')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isNotebookExtension
// ---------------------------------------------------------------------------

describe('isNotebookExtension', () => {
  it('detects .ipynb', () => {
    expect(isNotebookExtension('analysis.ipynb')).toBe(true)
    expect(isNotebookExtension('/path/to/notebook.ipynb')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isNotebookExtension('analysis.IPYNB')).toBe(true)
  })

  it('does not match non-notebook', () => {
    expect(isNotebookExtension('analysis.py')).toBe(false)
    expect(isNotebookExtension('analysis.json')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isBinaryContent
// ---------------------------------------------------------------------------

describe('isBinaryContent', () => {
  it('detects null bytes as binary', () => {
    const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f])
    expect(isBinaryContent(buffer)).toBe(true)
  })

  it('detects high non-printable ratio as binary', () => {
    // 50% non-printable chars (way above 10% threshold)
    const bytes = new Uint8Array(100)
    for (let i = 0; i < 50; i++) bytes[i] = 1 // non-printable
    for (let i = 50; i < 100; i++) bytes[i] = 65 // 'A'
    expect(isBinaryContent(Buffer.from(bytes))).toBe(true)
  })

  it('passes normal text content', () => {
    const text = 'Hello, world!\nThis is a normal text file.\n'
    expect(isBinaryContent(Buffer.from(text))).toBe(false)
  })

  it('passes content with tabs and newlines', () => {
    const text = 'line1\tvalue1\n\tindented\r\nwindows line\n'
    expect(isBinaryContent(Buffer.from(text))).toBe(false)
  })

  it('handles empty buffer', () => {
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false)
  })

  it('handles single-byte buffer', () => {
    expect(isBinaryContent(Buffer.from([65]))).toBe(false)  // 'A'
    expect(isBinaryContent(Buffer.from([0]))).toBe(true)    // null byte
  })

  it('checks only first BINARY_CHECK_SIZE bytes', () => {
    // Large buffer: first 8192 bytes are text, then binary
    const textPart = Buffer.alloc(BINARY_CHECK_SIZE, 65)  // 'A'
    const binaryPart = Buffer.alloc(1000, 0)              // null bytes
    const combined = Buffer.concat([textPart, binaryPart])
    expect(isBinaryContent(combined)).toBe(false) // only checks first 8192
  })
})

// ---------------------------------------------------------------------------
// Collection completeness
// ---------------------------------------------------------------------------

describe('BINARY_EXTENSIONS completeness', () => {
  it('includes all expected image formats', () => {
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif']
    for (const ext of imageExts) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  it('includes common archives', () => {
    const archiveExts = ['.zip', '.tar', '.gz', '.7z', '.rar']
    for (const ext of archiveExts) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })

  it('includes PDF', () => {
    expect(BINARY_EXTENSIONS.has('.pdf')).toBe(true)
  })

  it('IMAGE_EXTENSIONS is a subset of BINARY_EXTENSIONS', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(BINARY_EXTENSIONS.has(ext)).toBe(true)
    }
  })
})
