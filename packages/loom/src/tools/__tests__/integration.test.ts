/**
 * Integration tests for the tool system.
 * Tests the full pipeline: policy → hooks → executor → orchestrator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { executeTool } from '../executor.js'
import { ToolHookRegistry } from '../hooks.js'
import { ToolPolicy } from '../policy.js'
import { executeOrchestrated } from '../orchestrator.js'
import { formatToolsForProvider } from '../formatter.js'
import { createBuiltinTools, createBuiltinToolMap } from '../builtins/index.js'
import { readFile, writeFile, editFile, grep } from '../builtins/filesystem.js'
import type { ToolContext, Tool, ToolCall } from '../types.js'
import type { ToolUseBlock } from '../../messages/types.js'
import type { LoomConfig } from '../../core/config.js'

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string
let context: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-integration-'))
  context = {
    cwd: tmpDir,
    signal: new AbortController().signal,
    sessionId: 'integration-test',
    agentId: null,
    workspacePath: tmpDir,
    config: {} as LoomConfig,
    requestPermission: vi.fn().mockResolvedValue(true),
  }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Policy + Executor integration
// ---------------------------------------------------------------------------

describe('policy → executor pipeline', () => {
  it('policy filters tools before execution', () => {
    const policy = ToolPolicy.denyOnly('shell.*')
    const tools = createBuiltinTools()
    const allowed = policy.filterAllowed(tools)

    const names = allowed.map((t) => t.name)
    expect(names).toContain('readFile')
    expect(names).toContain('writeFile')
    expect(names).not.toContain('shell.execute')
  })

  it('can build tool map from filtered tools', () => {
    const policy = ToolPolicy.allowOnly('readFile', 'grep')
    const tools = createBuiltinTools()
    const allowed = policy.filterAllowed(tools)

    const map = new Map(allowed.map((t) => [t.name, t]))
    expect(map.size).toBe(2)
    expect(map.has('readFile')).toBe(true)
    expect(map.has('grep')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Hooks + Executor integration
// ---------------------------------------------------------------------------

describe('hooks → executor pipeline', () => {
  it('audit log hook records all tool calls', async () => {
    const auditLog: Array<{ tool: string; input: unknown; result: string }> = []
    const hooks = new ToolHookRegistry()

    hooks.registerAfter('*', async (toolName, input, result) => {
      auditLog.push({ tool: toolName, input, result: result.content })
      return result
    })

    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello', 'utf-8')

    await executeTool({
      tool: readFile,
      toolCall: { id: '1', name: 'readFile', input: { file_path: 'test.txt' } },
      context,
      hooks,
    })

    expect(auditLog).toHaveLength(1)
    expect(auditLog[0]!.tool).toBe('readFile')
    expect(auditLog[0]!.result).toContain('hello')
  })

  it('validation hook blocks invalid input', async () => {
    const hooks = new ToolHookRegistry()
    hooks.registerBefore('readFile', async (_name, input) => {
      const filePath = (input as { file_path?: string }).file_path ?? ''
      if (filePath.includes('..')) {
        return { blocked: true, reason: 'Path traversal not allowed' }
      }
      return { blocked: false }
    })

    const result = await executeTool({
      tool: readFile,
      toolCall: { id: '1', name: 'readFile', input: { file_path: '../../../etc/passwd' } },
      context,
      hooks,
    })

    expect(result.result.isError).toBe(true)
    expect(result.result.content).toBe('Path traversal not allowed')
  })

  it('transform hook normalizes paths', async () => {
    const hooks = new ToolHookRegistry()
    hooks.registerBefore('readFile', async (_name, input) => ({
      blocked: false,
      modifiedInput: {
        ...input,
        file_path: (input as { file_path: string }).file_path.replace(/\\/g, '/'),
      },
    }))

    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content', 'utf-8')

    const result = await executeTool({
      tool: readFile,
      toolCall: { id: '1', name: 'readFile', input: { file_path: 'test.txt' } },
      context,
      hooks,
    })

    expect(result.result.isError).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Orchestrator + Builtins integration
// ---------------------------------------------------------------------------

describe('orchestrator + builtins', () => {
  it('runs multiple read-only tools in parallel', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'file-a', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'file-b', 'utf-8')

    const toolMap = createBuiltinToolMap()
    const calls: ToolUseBlock[] = [
      { type: 'tool_use', id: '1', name: 'readFile', input: { file_path: 'a.txt' } },
      { type: 'tool_use', id: '2', name: 'readFile', input: { file_path: 'b.txt' } },
    ]

    const results = await executeOrchestrated(calls, toolMap, context, 10)

    expect(results).toHaveLength(2)
    const contents = results.map((r) => r.result.content)
    expect(contents.some((c) => c.includes('file-a'))).toBe(true)
    expect(contents.some((c) => c.includes('file-b'))).toBe(true)
  })

  it('runs write tools serially', async () => {
    const toolMap = createBuiltinToolMap()
    const calls: ToolUseBlock[] = [
      {
        type: 'tool_use',
        id: '1',
        name: 'writeFile',
        input: { file_path: 'first.txt', content: 'one' },
      },
      {
        type: 'tool_use',
        id: '2',
        name: 'writeFile',
        input: { file_path: 'second.txt', content: 'two' },
      },
    ]

    const results = await executeOrchestrated(calls, toolMap, context, 10)

    expect(results).toHaveLength(2)
    expect(results[0]!.result.isError).toBe(false)
    expect(results[1]!.result.isError).toBe(false)

    const f1 = await fs.readFile(path.join(tmpDir, 'first.txt'), 'utf-8')
    const f2 = await fs.readFile(path.join(tmpDir, 'second.txt'), 'utf-8')
    expect(f1).toBe('one')
    expect(f2).toBe('two')
  })
})

// ---------------------------------------------------------------------------
// Formatter + Builtins integration
// ---------------------------------------------------------------------------

describe('formatter + builtins', () => {
  it('formats all builtins for every provider without error', () => {
    const tools = createBuiltinTools()

    const anthropic = formatToolsForProvider(tools, 'anthropic')
    expect(anthropic).toHaveLength(tools.length)

    const openai = formatToolsForProvider(tools, 'openai')
    expect(openai).toHaveLength(tools.length)

    const google = formatToolsForProvider(tools, 'google')
    expect(google).toHaveLength(1) // wrapped in functionDeclarations
  })
})

// ---------------------------------------------------------------------------
// Full pipeline: write → edit → read → grep
// ---------------------------------------------------------------------------

describe('end-to-end file workflow', () => {
  it('write → edit → read → grep lifecycle', async () => {
    // 1. Write a file
    const writeResult = await writeFile.execute(
      { file_path: 'app.ts', content: 'const x = 1;\nconst y = 2;\n' } as Record<string, unknown>,
      context,
    )
    expect((writeResult as Awaited<typeof writeResult>).isError).toBe(false)

    // 2. Edit the file
    const editResult = await editFile.execute(
      {
        file_path: 'app.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 42;',
      } as Record<string, unknown>,
      context,
    )
    expect((editResult as Awaited<typeof editResult>).isError).toBe(false)

    // 3. Read and verify
    const readResult = await readFile.execute(
      { file_path: 'app.ts' } as Record<string, unknown>,
      context,
    )
    const read = readResult as Awaited<typeof readResult>
    expect(read.isError).toBe(false)
    expect(read.content).toContain('const x = 42;')
    expect(read.content).not.toContain('const x = 1;')

    // 4. Grep for the change
    const grepResult = await grep.execute(
      { pattern: '42' } as Record<string, unknown>,
      context,
    )
    const grepR = grepResult as Awaited<typeof grepResult>
    expect(grepR.isError).toBe(false)
    expect(grepR.content).toContain('const x = 42;')
  })
})
