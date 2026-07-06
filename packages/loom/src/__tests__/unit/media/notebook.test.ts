/**
 * Tests for media/notebook.ts
 *
 * Jupyter notebook parsing, cell extraction, content conversion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  readNotebook,
  notebookCellsToContent,
} from '../../../media/notebook.js'
import type { ProcessedCell } from '../../../media/types.js'

// ---------------------------------------------------------------------------
// readNotebook
// ---------------------------------------------------------------------------

describe('readNotebook', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `loom-nb-test-${randomUUID()}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('reads a minimal notebook with one code cell', async () => {
    const notebook = createNotebook([
      { cell_type: 'code', source: 'print("hello")', outputs: [] },
    ])
    const filePath = join(testDir, 'test.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells).toHaveLength(1)
    expect(cells[0]!.cellType).toBe('code')
    expect(cells[0]!.source).toBe('print("hello")')
    expect(cells[0]!.language).toBe('python')
    expect(cells[0]!.cellId).toBe('cell-0')
  })

  it('reads markdown cells', async () => {
    const notebook = createNotebook([
      { cell_type: 'markdown', source: '# Title\n\nSome text' },
    ])
    const filePath = join(testDir, 'md.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells).toHaveLength(1)
    expect(cells[0]!.cellType).toBe('markdown')
    expect(cells[0]!.source).toBe('# Title\n\nSome text')
    expect(cells[0]!.language).toBeUndefined() // markdown cells don't get language
  })

  it('reads multiple cells in order', async () => {
    const notebook = createNotebook([
      { cell_type: 'markdown', source: '# Header' },
      { cell_type: 'code', source: 'x = 1' },
      { cell_type: 'code', source: 'print(x)' },
    ])
    const filePath = join(testDir, 'multi.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells).toHaveLength(3)
    expect(cells[0]!.cellType).toBe('markdown')
    expect(cells[1]!.cellType).toBe('code')
    expect(cells[2]!.cellType).toBe('code')
    expect(cells[0]!.cellId).toBe('cell-0')
    expect(cells[1]!.cellId).toBe('cell-1')
    expect(cells[2]!.cellId).toBe('cell-2')
  })

  it('uses cell.id when available', async () => {
    const notebook = createNotebook([
      { cell_type: 'code', source: 'x = 1', id: 'my-custom-id' },
    ])
    const filePath = join(testDir, 'custom-id.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.cellId).toBe('my-custom-id')
  })

  it('reads cell with array source (multi-line)', async () => {
    const notebook = createNotebook([
      { cell_type: 'code', source: ['line1\n', 'line2\n', 'line3'] },
    ])
    const filePath = join(testDir, 'array-source.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.source).toBe('line1\nline2\nline3')
  })

  it('reads stream output', async () => {
    const notebook = createNotebook([
      {
        cell_type: 'code',
        source: 'print("hello")',
        outputs: [{ output_type: 'stream', text: 'hello\n' }],
      },
    ])
    const filePath = join(testDir, 'stream.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.outputs).toHaveLength(1)
    expect(cells[0]!.outputs![0]!.outputType).toBe('stream')
    expect(cells[0]!.outputs![0]!.text).toBe('hello\n')
  })

  it('reads execute_result output', async () => {
    const notebook = createNotebook([
      {
        cell_type: 'code',
        source: '2 + 2',
        outputs: [{
          output_type: 'execute_result',
          data: { 'text/plain': '4' },
        }],
      },
    ])
    const filePath = join(testDir, 'exec.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.outputs).toHaveLength(1)
    expect(cells[0]!.outputs![0]!.text).toBe('4')
  })

  it('reads display_data with image output', async () => {
    const notebook = createNotebook([
      {
        cell_type: 'code',
        source: 'plt.show()',
        outputs: [{
          output_type: 'display_data',
          data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': '<Figure>' },
        }],
      },
    ])
    const filePath = join(testDir, 'image-output.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.outputs).toHaveLength(1)
    expect(cells[0]!.outputs![0]!.image).toBeDefined()
    expect(cells[0]!.outputs![0]!.image!.data).toBe('iVBORw0KGgo=')
    expect(cells[0]!.outputs![0]!.image!.mediaType).toBe('image/png')
  })

  it('reads error output', async () => {
    const notebook = createNotebook([
      {
        cell_type: 'code',
        source: '1/0',
        outputs: [{
          output_type: 'error',
          ename: 'ZeroDivisionError',
          evalue: 'division by zero',
          traceback: ['Traceback (most recent call last):', '  File "<stdin>", line 1', 'ZeroDivisionError: division by zero'],
        }],
      },
    ])
    const filePath = join(testDir, 'error.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.outputs).toHaveLength(1)
    expect(cells[0]!.outputs![0]!.text).toContain('ZeroDivisionError')
    expect(cells[0]!.outputs![0]!.text).toContain('division by zero')
  })

  it('reads specific cell by ID', async () => {
    const notebook = createNotebook([
      { cell_type: 'code', source: 'cell_0', id: 'first' },
      { cell_type: 'code', source: 'cell_1', id: 'second' },
      { cell_type: 'code', source: 'cell_2', id: 'third' },
    ])
    const filePath = join(testDir, 'by-id.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath, 'second')
    expect(cells).toHaveLength(1)
    expect(cells[0]!.source).toBe('cell_1')
  })

  it('throws for non-existent cell ID', async () => {
    const notebook = createNotebook([
      { cell_type: 'code', source: 'x = 1', id: 'existing' },
    ])
    const filePath = join(testDir, 'missing-id.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    await expect(readNotebook(filePath, 'nonexistent')).rejects.toThrow('Cell with ID "nonexistent" not found')
  })

  it('throws for invalid JSON', async () => {
    const filePath = join(testDir, 'invalid.ipynb')
    await writeFile(filePath, 'not json at all')

    await expect(readNotebook(filePath)).rejects.toThrow('Invalid notebook JSON')
  })

  it('throws for notebook without cells', async () => {
    const filePath = join(testDir, 'no-cells.ipynb')
    await writeFile(filePath, JSON.stringify({ metadata: {}, nbformat: 4 }))

    await expect(readNotebook(filePath)).rejects.toThrow('no cells array')
  })

  it('detects language from metadata', async () => {
    const notebook = {
      cells: [{ cell_type: 'code', source: 'val x = 1', outputs: [] }],
      metadata: { language_info: { name: 'scala' } },
      nbformat: 4,
      nbformat_minor: 5,
    }
    const filePath = join(testDir, 'scala.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.language).toBe('scala')
  })

  it('defaults to python when no language metadata', async () => {
    const notebook = {
      cells: [{ cell_type: 'code', source: 'x = 1', outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    const filePath = join(testDir, 'no-lang.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.language).toBe('python')
  })

  it('truncates large outputs', async () => {
    const bigOutput = 'x'.repeat(20_000) // > 10KB threshold
    const notebook = createNotebook([
      {
        cell_type: 'code',
        source: 'big',
        outputs: [{ output_type: 'stream', text: bigOutput }],
      },
    ])
    const filePath = join(testDir, 'big-output.ipynb')
    await writeFile(filePath, JSON.stringify(notebook))

    const cells = await readNotebook(filePath)
    expect(cells[0]!.outputs).toHaveLength(1)
    // Should be truncated with a message
    expect(cells[0]!.outputs![0]!.text).toContain('Output too large')
  })
})

// ---------------------------------------------------------------------------
// notebookCellsToContent
// ---------------------------------------------------------------------------

describe('notebookCellsToContent', () => {
  it('converts a code cell to text', () => {
    const cells: ProcessedCell[] = [{
      cellType: 'code',
      cellId: 'cell-0',
      source: 'print("hello")',
      language: 'python',
    }]

    const content = notebookCellsToContent(cells)
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('cell-0')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('print("hello")')
  })

  it('converts markdown cell to text', () => {
    const cells: ProcessedCell[] = [{
      cellType: 'markdown',
      cellId: 'cell-0',
      source: '# Title',
    }]

    const content = notebookCellsToContent(cells)
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('type="markdown"')
  })

  it('produces image blocks for cells with image output', () => {
    const cells: ProcessedCell[] = [{
      cellType: 'code',
      cellId: 'cell-0',
      source: 'plt.plot([1,2,3])',
      language: 'python',
      outputs: [{
        outputType: 'display_data',
        image: { data: 'iVBORw0=', mediaType: 'image/png' },
      }],
    }]

    const content = notebookCellsToContent(cells)
    expect(content.length).toBeGreaterThanOrEqual(2)
    const imageBlock = content.find(b => b.type === 'image')
    expect(imageBlock).toBeDefined()
    expect((imageBlock as any).data).toBe('iVBORw0=')
    expect((imageBlock as any).mediaType).toBe('image/png')
  })

  it('merges adjacent text blocks', () => {
    const cells: ProcessedCell[] = [
      { cellType: 'code', cellId: 'cell-0', source: 'x = 1', language: 'python' },
      { cellType: 'code', cellId: 'cell-1', source: 'y = 2', language: 'python' },
    ]

    const content = notebookCellsToContent(cells)
    // Should merge into one text block (no images to break them apart)
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('text')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('cell-0')
    expect((content[0] as { type: 'text'; text: string }).text).toContain('cell-1')
  })

  it('handles empty cells array', () => {
    const content = notebookCellsToContent([])
    expect(content).toHaveLength(0)
  })

  it('includes non-python language annotation', () => {
    const cells: ProcessedCell[] = [{
      cellType: 'code',
      cellId: 'cell-0',
      source: 'val x = 1',
      language: 'scala',
    }]

    const content = notebookCellsToContent(cells)
    expect((content[0] as { type: 'text'; text: string }).text).toContain('lang="scala"')
  })

  it('does not annotate python (default language)', () => {
    const cells: ProcessedCell[] = [{
      cellType: 'code',
      cellId: 'cell-0',
      source: 'x = 1',
      language: 'python',
    }]

    const content = notebookCellsToContent(cells)
    expect((content[0] as { type: 'text'; text: string }).text).not.toContain('lang=')
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNotebook(cells: Array<Record<string, unknown>>) {
  return {
    cells,
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
}
