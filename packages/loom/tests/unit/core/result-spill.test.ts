/**
 * Unit Test — foundation-hardening B1: oversized tool-output truncation must
 * be RECOVERABLE, not silently destroyed.
 *
 * Before: the loop head/tail-truncated a tool result over the byte cap and the
 * middle was gone — and a dead config default (`truncationMessage`) falsely
 * claimed "Full result saved to disk" while nothing was saved. After: when
 * `config.toolExecution.spillDir` is set, the full pre-truncation output is
 * written there, the in-context marker cites the path, and `metadata.spillPath`
 * carries it — the model can readFile/grep the omitted middle. When unset, the
 * loop degrades to in-context-only truncation with no false promise.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spillToolResult, spillMarker } from '../../../src/tools/result-spill.js'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { defineTool } from '../../../src/tools/types.js'
import type {
  ProviderAdapter, ProviderChunk, ProviderRequest, ProviderFeature, ToolDefinition,
} from '../../../src/provider/types.js'
import type { Tool } from '../../../src/tools/types.js'
import type { LoomEvent } from '../../../src/core/events.js'

const SCRATCH = mkdtempSync(join(tmpdir(), 'loom-spill-'))
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// Helper-level
// ---------------------------------------------------------------------------

describe('spillToolResult / spillMarker', () => {
  it('writes the full content and returns an absolute path when spillDir is set', async () => {
    const content = 'line\n'.repeat(1000)
    const path = await spillToolResult(SCRATCH, 'sess1', 'tc1', content)
    expect(path).toBeTruthy()
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!, 'utf8')).toBe(content) // full, untruncated
  })

  it('returns null and writes nothing when spillDir is undefined', async () => {
    const path = await spillToolResult(undefined, 'sess1', 'tc1', 'x')
    expect(path).toBeNull()
  })

  it('sanitises session/call ids so they cannot escape the directory', async () => {
    const path = await spillToolResult(SCRATCH, '../../etc', 'a/b', 'data')
    expect(path).toBeTruthy()
    // The written file stays inside SCRATCH — no path traversal.
    expect(path!.startsWith(SCRATCH)).toBe(true)
    expect(existsSync(path!)).toBe(true)
  })

  it('returns null on an unwritable spillDir (degrades, never throws)', async () => {
    // A path under a file (not a dir) — mkdir fails → null, no throw.
    const filePath = await spillToolResult(SCRATCH, 'sess', 'real', 'x')
    const unwritable = join(filePath!, 'nope') // filePath is a file, not a dir
    const path = await spillToolResult(unwritable, 'sess2', 'tc2', 'data')
    expect(path).toBeNull()
  })

  it('spillMarker cites the path when spilled, empty when not', () => {
    expect(spillMarker('/tmp/x.txt')).toContain('/tmp/x.txt')
    expect(spillMarker('/tmp/x.txt')).toContain('readFile')
    expect(spillMarker(null)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Loop integration
// ---------------------------------------------------------------------------

function makeToolUseProvider(toolName: string): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      yield { type: 'tool_use_start', toolCallId: 'tc-1', toolName, input: {} } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use' as const, id: 'tc-1', name: toolName, input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as ProviderChunk
    },
    async countTokens() { return 10 },
    supportsFeature(_f: ProviderFeature) { return true },
    formatTools(t: ToolDefinition[]) { return t },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
}

const BIG = 'A'.repeat(500)
function makeBigTool(): Tool {
  return defineTool({
    name: 'big',
    description: 'returns oversized output',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: { type: 'object', properties: {} },
    async execute() { return { content: BIG, isError: false } },
  })
}

function makeSession(spillDir: string | undefined): Session {
  const base = createDefaultConfig('mock:m')
  return new Session({
    config: {
      ...base,
      maxTurns: 1,
      maxTokens: 100,
      toolExecution: { ...base.toolExecution, maxResultSize: 100, spillDir },
    },
    provider: makeToolUseProvider('big'),
    tools: [makeBigTool()],
    permissionMode: 'ask',
    checkPermission: async () => 'allow' as const,
    requestApproval: async () => true,
  })
}

async function toolEnd(session: Session) {
  const events: LoomEvent[] = []
  const gen = session.submitMessage('go')
  let next = await gen.next()
  while (!next.done) { events.push(next.value); next = await gen.next() }
  return events.find((e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
    e.type === 'tool.call.end',
  )
}

describe('B1 — loop spills oversized tool output and cites the path', () => {
  it('with spillDir: full output on disk, marker + metadata.spillPath cite it', async () => {
    const end = await toolEnd(makeSession(SCRATCH))
    expect(end).toBeDefined()
    expect(end!.truncated).toBe(true)

    const spillPath = (end!.metadata as Record<string, unknown> | undefined)?.spillPath as string | undefined
    expect(typeof spillPath).toBe('string')
    expect(existsSync(spillPath!)).toBe(true)
    // The spilled file holds the FULL untruncated output.
    expect(readFileSync(spillPath!, 'utf8')).toBe(BIG)
    // The in-context result is truncated BUT points the model at the path.
    expect(String(end!.result).length).toBeLessThan(BIG.length)
    expect(String(end!.result)).toContain(spillPath!)
    expect(String(end!.result)).toContain('readFile')
  })

  it('without spillDir: truncated in context, no false disk promise', async () => {
    const end = await toolEnd(makeSession(undefined))
    expect(end).toBeDefined()
    expect(end!.truncated).toBe(true)
    const spillPath = (end!.metadata as Record<string, unknown> | undefined)?.spillPath
    expect(spillPath).toBeUndefined()
    // No "saved to disk" promise — only the honest head/tail truncation marker.
    expect(String(end!.result)).not.toContain('saved to')
    expect(String(end!.result)).toContain('truncated')
  })
})
