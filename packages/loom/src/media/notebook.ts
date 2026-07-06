/**
 * Jupyter Notebook Processing
 *
 * Parses .ipynb files (JSON) and extracts cells with code, markdown,
 * and output images (matplotlib plots, etc.).
 *
 * Zero dependencies — pure TypeScript JSON parsing.
 */

import { readFile } from 'fs/promises'
import type {
  NotebookContent,
  NotebookCell,
  NotebookCellOutput,
  ProcessedCell,
  ProcessedOutput,
} from './types.js'

const LARGE_OUTPUT_THRESHOLD = 10_000

// ---------------------------------------------------------------------------
// Read and parse
// ---------------------------------------------------------------------------

/**
 * Read and parse a Jupyter notebook file into processed cell data.
 *
 * @param notebookPath Absolute path to the .ipynb file
 * @param cellId Optional: read only a specific cell by ID
 * @returns Array of processed cells with source, outputs, and images
 */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<ProcessedCell[]> {
  const raw = await readFile(notebookPath, 'utf-8')

  let notebook: NotebookContent
  try {
    notebook = JSON.parse(raw) as NotebookContent
  } catch {
    throw new Error(`Invalid notebook JSON: ${notebookPath}`)
  }

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new Error(`Notebook has no cells array: ${notebookPath}`)
  }

  const language = notebook.metadata?.language_info?.name ?? 'python'

  if (cellId) {
    const cell = notebook.cells.find(c => c.id === cellId)
    if (!cell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`)
    }
    return [processCell(cell, notebook.cells.indexOf(cell), language, true)]
  }

  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  )
}

// ---------------------------------------------------------------------------
// Cell processing
// ---------------------------------------------------------------------------

function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): ProcessedCell {
  const cellId = cell.id ?? `cell-${index}`
  const source: string = Array.isArray(cell.source) ? (cell.source as string[]).join('') : cell.source as string

  const result: ProcessedCell = {
    cellType: cell.cell_type,
    cellId,
    source,
    language: cell.cell_type === 'code' ? codeLanguage : undefined,
    executionCount: cell.cell_type === 'code' ? (cell.execution_count ?? undefined) : undefined,
  }

  if (cell.cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput)

    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      return {
        ...result,
        outputs: [{
          outputType: 'stream',
          text: `[Output too large to include. Use shell to extract: cat <notebook> | jq '.cells[${index}].outputs']`,
        }],
      }
    }

    return { ...result, outputs }
  }

  return result
}

// ---------------------------------------------------------------------------
// Output processing
// ---------------------------------------------------------------------------

function processOutput(output: NotebookCellOutput): ProcessedOutput {
  switch (output.output_type) {
    case 'stream':
      return {
        outputType: output.output_type,
        text: processOutputText(output.text),
      }

    case 'execute_result':
    case 'display_data':
      return {
        outputType: output.output_type,
        text: processOutputText(output.data?.['text/plain'] as string | string[] | undefined),
        image: output.data ? extractImage(output.data) : undefined,
      }

    case 'error':
      return {
        outputType: output.output_type,
        text: `${output.ename ?? 'Error'}: ${output.evalue ?? ''}\n${(output.traceback ?? []).join('\n')}`,
      }

    default:
      return { outputType: 'unknown' }
  }
}

function processOutputText(text: string | readonly string[] | undefined): string {
  if (!text) return ''
  const raw: string = Array.isArray(text) ? (text as string[]).join('') : text as string
  // Truncate very large outputs
  if (raw.length > LARGE_OUTPUT_THRESHOLD) {
    return raw.slice(0, LARGE_OUTPUT_THRESHOLD) + '\n... [output truncated]'
  }
  return raw
}

function extractImage(
  data: Record<string, unknown>,
): { data: string; mediaType: string } | undefined {
  if (typeof data['image/png'] === 'string') {
    return {
      data: (data['image/png'] as string).replace(/\s/g, ''),
      mediaType: 'image/png',
    }
  }
  if (typeof data['image/jpeg'] === 'string') {
    return {
      data: (data['image/jpeg'] as string).replace(/\s/g, ''),
      mediaType: 'image/jpeg',
    }
  }
  return undefined
}

function isLargeOutputs(outputs: ProcessedOutput[]): boolean {
  let size = 0
  for (const o of outputs) {
    size += (o.text?.length ?? 0) + (o.image?.data.length ?? 0)
    if (size > LARGE_OUTPUT_THRESHOLD) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Notebook cells → content blocks
// ---------------------------------------------------------------------------

/**
 * Convert processed cells to a text representation suitable for LLM consumption.
 * Returns an array of content segments (text and images).
 */
export function notebookCellsToContent(
  cells: ProcessedCell[],
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string }> {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string }> = []
  let textAccumulator = ''

  for (const cell of cells) {
    // Cell header
    const meta: string[] = []
    if (cell.cellType !== 'code') meta.push(`type="${cell.cellType}"`)
    if (cell.language && cell.language !== 'python' && cell.cellType === 'code') {
      meta.push(`lang="${cell.language}"`)
    }
    if (cell.executionCount !== undefined) meta.push(`exec=${cell.executionCount}`)

    const metaStr = meta.length > 0 ? ` ${meta.join(' ')}` : ''
    textAccumulator += `<cell id="${cell.cellId}"${metaStr}>${cell.source}</cell>\n`

    // Cell outputs
    if (cell.outputs) {
      for (const output of cell.outputs) {
        if (output.text) {
          textAccumulator += `${output.text}\n`
        }
        if (output.image) {
          // Flush accumulated text before image
          if (textAccumulator.trim()) {
            blocks.push({ type: 'text', text: textAccumulator })
            textAccumulator = ''
          }
          blocks.push({ type: 'image', data: output.image.data, mediaType: output.image.mediaType })
        }
      }
    }
  }

  // Flush remaining text
  if (textAccumulator.trim()) {
    blocks.push({ type: 'text', text: textAccumulator })
  }

  return blocks
}
