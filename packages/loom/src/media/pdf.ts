/**
 * PDF Processing
 *
 * Read PDFs as base64 for native document blocks,
 * or extract pages as JPEG images via pdftoppm (poppler-utils).
 *
 * Zero npm dependencies — uses system binaries only.
 * - pdfinfo: get page count
 * - pdftoppm: extract pages as JPEG images
 *
 * Graceful degradation: if poppler is not installed, native PDF path
 * still works (base64 document block). Page extraction returns structured error.
 */

import { execFile } from 'child_process'
import { mkdir, readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import {
  PDF_TARGET_RAW_SIZE,
  PDF_MAX_EXTRACT_SIZE,
} from './constants.js'
import type { PDFResult, PDFReadResult, PDFExtractResult } from './types.js'

// ---------------------------------------------------------------------------
// Read PDF as base64 (for native document blocks)
// ---------------------------------------------------------------------------

/**
 * Read a PDF file and return it as base64-encoded data.
 * Validates magic bytes, size limits, and emptiness.
 */
export async function readPDF(filePath: string): Promise<PDFResult<PDFReadResult>> {
  try {
    const stats = await stat(filePath)

    if (stats.size === 0) {
      return { success: false, error: { reason: 'empty', message: `PDF file is empty: ${filePath}` } }
    }

    if (stats.size > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF exceeds maximum size of ${formatBytes(PDF_TARGET_RAW_SIZE)}.`,
        },
      }
    }

    const buffer = await readFile(filePath)

    // Validate PDF magic bytes (%PDF-)
    const header = buffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: { reason: 'corrupted', message: `File is not a valid PDF (missing %PDF- header): ${filePath}` },
      }
    }

    return {
      success: true,
      data: {
        filePath,
        base64: buffer.toString('base64'),
        originalSize: stats.size,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: { reason: 'unknown', message: err instanceof Error ? err.message : String(err) },
    }
  }
}

// ---------------------------------------------------------------------------
// Page count (via pdfinfo)
// ---------------------------------------------------------------------------

/**
 * Get page count using pdfinfo (poppler-utils).
 * Returns null if pdfinfo is unavailable or fails.
 */
export async function getPDFPageCount(filePath: string): Promise<number | null> {
  try {
    const stdout = await execFileAsync('pdfinfo', [filePath], 10_000)
    const match = /^Pages:\s+(\d+)/m.exec(stdout)
    if (!match?.[1]) return null
    const count = parseInt(match[1], 10)
    return isNaN(count) ? null : count
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Extract pages as JPEG images (via pdftoppm)
// ---------------------------------------------------------------------------

let _pdftoppmAvailable: boolean | undefined

/**
 * Check if pdftoppm is available on the system. Result is cached.
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (_pdftoppmAvailable !== undefined) return _pdftoppmAvailable
  try {
    await execFileAsync('pdftoppm', ['-v'], 5_000)
    _pdftoppmAvailable = true
  } catch {
    _pdftoppmAvailable = false
  }
  return _pdftoppmAvailable
}

/**
 * Extract PDF pages as JPEG images.
 * Produces page-01.jpg, page-02.jpg, etc. in an output directory.
 *
 * @param filePath Path to the PDF
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractResult>> {
  try {
    const stats = await stat(filePath)

    if (stats.size === 0) {
      return { success: false, error: { reason: 'empty', message: `PDF file is empty: ${filePath}` } }
    }

    if (stats.size > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF exceeds maximum extraction size of ${formatBytes(PDF_MAX_EXTRACT_SIZE)}.`,
        },
      }
    }

    const available = await isPdftoppmAvailable()
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: 'pdftoppm is not installed. Install poppler-utils (brew install poppler / apt-get install poppler-utils) for PDF page rendering.',
        },
      }
    }

    const outputDir = join(tmpdir(), `loom-pdf-${randomUUID()}`)
    await mkdir(outputDir, { recursive: true })

    const prefix = join(outputDir, 'page')
    const args = ['-jpeg', '-r', '100']

    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, prefix)

    try {
      await execFileAsync('pdftoppm', args, 120_000)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/password/i.test(msg)) {
        return { success: false, error: { reason: 'password_protected', message: 'PDF is password-protected.' } }
      }
      if (/damaged|corrupt|invalid/i.test(msg)) {
        return { success: false, error: { reason: 'corrupted', message: 'PDF file is corrupted or invalid.' } }
      }
      return { success: false, error: { reason: 'unknown', message: `pdftoppm failed: ${msg}` } }
    }

    const entries = await readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()

    if (imageFiles.length === 0) {
      return {
        success: false,
        error: { reason: 'corrupted', message: 'pdftoppm produced no output pages. The PDF may be invalid.' },
      }
    }

    return {
      success: true,
      data: {
        filePath,
        originalSize: stats.size,
        pageCount: imageFiles.length,
        outputDir,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: { reason: 'unknown', message: err instanceof Error ? err.message : String(err) },
    }
  }
}

// ---------------------------------------------------------------------------
// Page range parsing
// ---------------------------------------------------------------------------

/**
 * Parse a page range string into firstPage/lastPage.
 *
 * Formats: "5", "1-10", "3-"
 * Returns null on invalid input. Pages are 1-indexed.
 */
export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) return null

  // "N-" open-ended range
  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) return null
    return { firstPage: first, lastPage: Infinity }
  }

  const dashIdx = trimmed.indexOf('-')
  if (dashIdx === -1) {
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) return null
    return { firstPage: page, lastPage: page }
  }

  const first = parseInt(trimmed.slice(0, dashIdx), 10)
  const last = parseInt(trimmed.slice(dashIdx + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) return null
  return { firstPage: first, lastPage: last }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execFileAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        // Include stderr in error message for better diagnostics
        const msg = stderr?.trim() || error.message
        reject(new Error(msg))
        return
      }
      resolve(stdout)
    })
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
