/**
 * Attachment Processing
 *
 * Converts raw file attachments (from web client, TUI, CLI) into
 * content blocks ready for the Anthropic/OpenAI/Google API.
 *
 * This is the BRIDGE between user file uploads and model input.
 *
 * Flow:
 *   Client sends { filename, data (base64), mimeType }
 *     → categorizeFile() determines type
 *     → processAttachment() converts to ContentBlock[]
 *     → Gateway builds UserMessage with text + content blocks
 *     → Loom sends to provider
 *
 * Used by: cortex/gateway/attachments.ts, cortex/gateway/handlers/run.ts
 */

import type { ContentBlock } from '../messages/types.js'
import type { RawAttachment, AttachmentCategory } from './types.js'
import {
  hasImageExtension,
  isPDFExtension,
  isNotebookExtension,
  hasBinaryExtension,
} from './constants.js'
import { processImageToBase64, createImageMetadataText } from './image.js'
import { notebookCellsToContent } from './notebook.js'

// ---------------------------------------------------------------------------
// Categorize a file by its name/mime
// ---------------------------------------------------------------------------

/**
 * Determine how to process a file based on its name and MIME type.
 */
export function categorizeFile(filename: string, mimeType?: string): AttachmentCategory {
  // Check MIME first (more reliable when available)
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image'
    if (mimeType === 'application/pdf') return 'pdf'
    if (mimeType === 'application/x-ipynb+json') return 'notebook'
    if (mimeType.startsWith('text/')) return 'text'
  }

  // Fall back to extension
  if (hasImageExtension(filename)) return 'image'
  if (isPDFExtension(filename)) return 'pdf'
  if (isNotebookExtension(filename)) return 'notebook'
  if (hasBinaryExtension(filename)) return 'binary'

  return 'text'
}

// ---------------------------------------------------------------------------
// Process a single attachment → content blocks
// ---------------------------------------------------------------------------

export interface AttachmentResult {
  /** Content blocks to include in the user message. */
  readonly blocks: ContentBlock[]
  /** Human-readable summary for display in UI. */
  readonly summary: string
  /** The detected category. */
  readonly category: AttachmentCategory
}

/**
 * Process a raw attachment into content blocks for the API.
 *
 * Image → resize/compress → ImageBlock
 * PDF → base64 → DocumentBlock (or text fallback)
 * Notebook → parse → TextBlock + ImageBlocks for plots
 * Text → TextBlock with filename header
 * Binary → TextBlock with "binary file" notice
 */
export async function processAttachment(
  attachment: RawAttachment,
): Promise<AttachmentResult> {
  const category = categorizeFile(attachment.filename, attachment.mimeType)

  switch (category) {
    case 'image':
      return processImageAttachment(attachment)
    case 'pdf':
      return processPDFAttachment(attachment)
    case 'notebook':
      return processNotebookAttachment(attachment)
    case 'text':
      return processTextAttachment(attachment)
    case 'binary':
      return {
        blocks: [{ type: 'text', text: `[Binary file: ${attachment.filename} — cannot be displayed as text]` }],
        summary: `Binary file: ${attachment.filename}`,
        category: 'binary',
      }
  }
}

/**
 * Process multiple attachments. Returns all content blocks concatenated.
 */
export async function processAttachments(
  attachments: readonly RawAttachment[],
): Promise<AttachmentResult[]> {
  const results: AttachmentResult[] = []
  for (const attachment of attachments) {
    results.push(await processAttachment(attachment))
  }
  return results
}

// ---------------------------------------------------------------------------
// Image attachment
// ---------------------------------------------------------------------------

async function processImageAttachment(attachment: RawAttachment): Promise<AttachmentResult> {
  const buffer = Buffer.from(attachment.data, 'base64')
  const ext = attachment.filename.split('.').pop() ?? 'png'

  const result = await processImageToBase64(buffer, ext)
  const blocks: ContentBlock[] = []

  // Image block
  blocks.push({
    type: 'image',
    source: {
      type: 'base64',
      mediaType: result.mediaType,
      data: result.base64,
    },
  })

  // Metadata text (dimension info for coordinate mapping)
  if (result.dimensions) {
    const meta = createImageMetadataText(result.dimensions, attachment.filename)
    if (meta) {
      blocks.push({ type: 'text', text: meta })
    }
  }

  const sizeKB = Math.round(result.originalSize / 1024)
  return {
    blocks,
    summary: `Image: ${attachment.filename} (${sizeKB} KB)`,
    category: 'image',
  }
}

// ---------------------------------------------------------------------------
// PDF attachment
// ---------------------------------------------------------------------------

async function processPDFAttachment(attachment: RawAttachment): Promise<AttachmentResult> {
  const buffer = Buffer.from(attachment.data, 'base64')

  // Validate PDF magic bytes
  const header = buffer.subarray(0, 5).toString('ascii')
  if (!header.startsWith('%PDF-')) {
    return {
      blocks: [{ type: 'text', text: `[File ${attachment.filename} has .pdf extension but is not a valid PDF]` }],
      summary: `Invalid PDF: ${attachment.filename}`,
      category: 'pdf',
    }
  }

  const sizeMB = (buffer.length / (1024 * 1024)).toFixed(1)

  // Native document block (Anthropic supports this)
  const blocks: ContentBlock[] = [{
    type: 'document' as const,
    source: {
      type: 'base64' as const,
      mediaType: 'application/pdf' as const,
      data: attachment.data,
    },
  } as unknown as ContentBlock] // DocumentBlock added below

  return {
    blocks,
    summary: `PDF: ${attachment.filename} (${sizeMB} MB)`,
    category: 'pdf',
  }
}

// ---------------------------------------------------------------------------
// Notebook attachment
// ---------------------------------------------------------------------------

async function processNotebookAttachment(attachment: RawAttachment): Promise<AttachmentResult> {
  const content = Buffer.from(attachment.data, 'base64').toString('utf-8')

  let notebook: { cells: unknown[]; metadata: { language_info?: { name: string } } }
  try {
    notebook = JSON.parse(content) as typeof notebook
  } catch {
    return {
      blocks: [{ type: 'text', text: `[Invalid notebook JSON: ${attachment.filename}]` }],
      summary: `Invalid notebook: ${attachment.filename}`,
      category: 'notebook',
    }
  }

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    return {
      blocks: [{ type: 'text', text: `[Notebook has no cells: ${attachment.filename}]` }],
      summary: `Empty notebook: ${attachment.filename}`,
      category: 'notebook',
    }
  }

  // Write notebook to temp file for processing, or parse inline
  // Since we have the content, parse it inline.
  const language = notebook.metadata?.language_info?.name ?? 'python'
  const processedCells = notebook.cells.map((cell: any, index: number) => ({
    cellType: cell.cell_type ?? 'code',
    cellId: cell.id ?? `cell-${index}`,
    source: Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? ''),
    language: cell.cell_type === 'code' ? language : undefined,
    executionCount: cell.execution_count ?? undefined,
    outputs: cell.outputs?.map((o: any) => processNotebookOutput(o)) ?? [],
  }))

  const contentBlocks = notebookCellsToContent(processedCells)
  const blocks: ContentBlock[] = contentBlocks.map(block => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text }
    }
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, mediaType: block.mediaType, data: block.data },
    }
  })

  // Prepend filename header
  blocks.unshift({ type: 'text', text: `[Notebook: ${attachment.filename} — ${processedCells.length} cells]` })

  return {
    blocks,
    summary: `Notebook: ${attachment.filename} (${processedCells.length} cells)`,
    category: 'notebook',
  }
}

function processNotebookOutput(output: any): { outputType: string; text?: string; image?: { data: string; mediaType: string } } {
  const type = output.output_type ?? 'unknown'

  if (type === 'stream') {
    const text = Array.isArray(output.text) ? output.text.join('') : (output.text ?? '')
    return { outputType: type, text }
  }

  if (type === 'execute_result' || type === 'display_data') {
    const textPlain = output.data?.['text/plain']
    const text = textPlain ? (Array.isArray(textPlain) ? textPlain.join('') : textPlain) : undefined

    let image: { data: string; mediaType: string } | undefined
    if (typeof output.data?.['image/png'] === 'string') {
      image = { data: output.data['image/png'].replace(/\s/g, ''), mediaType: 'image/png' }
    } else if (typeof output.data?.['image/jpeg'] === 'string') {
      image = { data: output.data['image/jpeg'].replace(/\s/g, ''), mediaType: 'image/jpeg' }
    }

    return { outputType: type, text, image }
  }

  if (type === 'error') {
    return {
      outputType: type,
      text: `${output.ename ?? 'Error'}: ${output.evalue ?? ''}\n${(output.traceback ?? []).join('\n')}`,
    }
  }

  return { outputType: 'unknown' }
}

// ---------------------------------------------------------------------------
// Text attachment
// ---------------------------------------------------------------------------

async function processTextAttachment(attachment: RawAttachment): Promise<AttachmentResult> {
  const content = Buffer.from(attachment.data, 'base64').toString('utf-8')
  const lines = content.split('\n')
  const lineCount = lines.length

  // Add line numbers
  const numbered = lines.map((line, i) => `${i + 1}\t${line}`).join('\n')

  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `File: ${attachment.filename} (${lineCount} lines)\n\n${numbered}`,
  }]

  return {
    blocks,
    summary: `File: ${attachment.filename} (${lineCount} lines)`,
    category: 'text',
  }
}
