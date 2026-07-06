/**
 * Media Processing Types
 *
 * Result types for image, PDF, and notebook processing.
 * Used by both the readFile tool and the gateway attachment processor.
 */

import type { ImageMediaType } from './constants.js'

// =============================================================================
// IMAGE
// =============================================================================

export interface ImageDimensions {
  readonly originalWidth?: number
  readonly originalHeight?: number
  readonly displayWidth?: number
  readonly displayHeight?: number
}

export interface ImageProcessResult {
  readonly buffer: Buffer
  readonly mediaType: ImageMediaType
  readonly dimensions?: ImageDimensions
}

export interface CompressedImageResult {
  readonly base64: string
  readonly mediaType: ImageMediaType
  readonly originalSize: number
  readonly dimensions?: ImageDimensions
}

// =============================================================================
// PDF
// =============================================================================

export type PDFErrorReason =
  | 'empty'
  | 'too_large'
  | 'password_protected'
  | 'corrupted'
  | 'unavailable'
  | 'unknown'

export interface PDFError {
  readonly reason: PDFErrorReason
  readonly message: string
}

export type PDFResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: PDFError }

export interface PDFReadResult {
  readonly filePath: string
  readonly base64: string
  readonly originalSize: number
}

export interface PDFExtractResult {
  readonly filePath: string
  readonly originalSize: number
  readonly pageCount: number
  /** Directory containing extracted page-XX.jpg files. */
  readonly outputDir: string
}

// =============================================================================
// NOTEBOOK
// =============================================================================

export interface NotebookContent {
  readonly cells: readonly NotebookCell[]
  readonly metadata: {
    readonly language_info?: { readonly name: string }
    readonly [key: string]: unknown
  }
  readonly nbformat: number
  readonly nbformat_minor: number
}

export interface NotebookCell {
  readonly id?: string
  readonly cell_type: 'code' | 'markdown' | 'raw'
  readonly source: string | readonly string[]
  readonly outputs?: readonly NotebookCellOutput[]
  readonly execution_count?: number | null
  readonly metadata?: Record<string, unknown>
}

export interface NotebookCellOutput {
  readonly output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  readonly text?: string | readonly string[]
  readonly data?: Record<string, unknown>
  readonly ename?: string
  readonly evalue?: string
  readonly traceback?: readonly string[]
  readonly name?: string
}

export interface ProcessedCell {
  readonly cellType: string
  readonly cellId: string
  readonly source: string
  readonly language?: string
  readonly executionCount?: number
  readonly outputs?: readonly ProcessedOutput[]
}

export interface ProcessedOutput {
  readonly outputType: string
  readonly text?: string
  readonly image?: {
    readonly data: string
    readonly mediaType: string
  }
}

// =============================================================================
// ATTACHMENT (Gateway level)
// =============================================================================

/** Raw attachment from a client (web, TUI, CLI). */
export interface RawAttachment {
  readonly filename: string
  /** Base64-encoded file data. */
  readonly data: string
  readonly mimeType: string
}

/** Detected file category after inspecting the attachment. */
export type AttachmentCategory = 'image' | 'pdf' | 'notebook' | 'text' | 'binary'
