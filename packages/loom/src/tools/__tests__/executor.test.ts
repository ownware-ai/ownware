import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeTool, executeToolBatch } from '../executor.js'
import { defineTool } from '../types.js'
import { ToolHookRegistry } from '../hooks.js'
import { ToolResultCache } from '../result-cache.js'
import type { ToolContext, ToolResult, ToolProgress, Tool, ToolCall } from '../types.js'
import type { LoomConfig } from '../../core/config.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp/test',
    signal: new AbortController().signal,
    sessionId: 'test-session',
    agentId: null,
    workspacePath: '/tmp/test',
    config: {} as LoomConfig,
    requestPermission: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

function createToolCall(name: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${name}-${Date.now()}`, name, input }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'Echoes input back',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message to echo' },
    },
    required: ['message'],
  },
  async execute(input) {
    return { content: (input as { message: string }).message, isError: false }
  },
})

const failingTool = defineTool({
  name: 'fail',
  description: 'Always throws',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    throw new Error('Tool exploded')
  },
})

const permissionTool = defineTool({
  name: 'dangerous',
  description: 'Needs permission',
  requiresPermission: true,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { content: 'executed', isError: false }
  },
})

function createStreamingTool(chunks: string[]): Tool {
  return defineTool({
    name: 'streamer',
    description: 'Streams progress',
    inputSchema: { type: 'object', properties: {} },
    async *execute(): AsyncGenerator<ToolProgress, ToolResult> {
      for (const chunk of chunks) {
        yield { message: chunk }
      }
      return { content: 'done', isError: false }
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeTool', () => {
  let context: ToolContext

  beforeEach(() => {
    context = createMockContext()
  })

  describe('basic execution', () => {
    it('executes a simple tool and returns result', async () => {
      const result = await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'hello' }),
        context,
      })

      expect(result.result.content).toBe('hello')
      expect(result.result.isError).toBe(false)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.wasPermissionDenied).toBe(false)
    })

    it('wraps thrown errors in ToolResult', async () => {
      const result = await executeTool({
        tool: failingTool,
        toolCall: createToolCall('fail'),
        context,
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content).toContain('Tool exploded')
    })

    it('tracks duration', async () => {
      const slowTool = defineTool({
        name: 'slow',
        description: 'Slow tool',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          await new Promise((r) => setTimeout(r, 50))
          return { content: 'done', isError: false }
        },
      })

      const result = await executeTool({
        tool: slowTool,
        toolCall: createToolCall('slow'),
        context,
      })

      expect(result.durationMs).toBeGreaterThanOrEqual(40)
    })
  })

  describe('permission checks', () => {
    it('allows execution when permission granted', async () => {
      const result = await executeTool({
        tool: permissionTool,
        toolCall: createToolCall('dangerous'),
        context,
      })

      expect(result.result.content).toBe('executed')
      expect(result.wasPermissionDenied).toBe(false)
      expect(context.requestPermission).toHaveBeenCalledOnce()
    })

    it('blocks execution when permission denied', async () => {
      const ctx = createMockContext({
        requestPermission: vi.fn().mockResolvedValue(false),
      })

      const result = await executeTool({
        tool: permissionTool,
        toolCall: createToolCall('dangerous'),
        context: ctx,
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content).toContain('Permission denied')
      expect(result.wasPermissionDenied).toBe(true)
    })

    it('does not check permission for non-requiring tools', async () => {
      await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'hi' }),
        context,
      })

      expect(context.requestPermission).not.toHaveBeenCalled()
    })
  })

  describe('AsyncGenerator support', () => {
    it('drains generator and returns final result', async () => {
      const tool = createStreamingTool(['step 1', 'step 2', 'step 3'])

      const result = await executeTool({
        tool,
        toolCall: createToolCall('streamer'),
        context,
      })

      expect(result.result.content).toBe('done')
      expect(result.result.isError).toBe(false)
    })

    it('calls onProgress for each yield', async () => {
      const tool = createStreamingTool(['a', 'b', 'c'])
      const onProgress = vi.fn()

      await executeTool({
        tool,
        toolCall: createToolCall('streamer'),
        context,
        onProgress,
      })

      expect(onProgress).toHaveBeenCalledTimes(3)
      expect(onProgress).toHaveBeenCalledWith({ message: 'a' })
      expect(onProgress).toHaveBeenCalledWith({ message: 'b' })
      expect(onProgress).toHaveBeenCalledWith({ message: 'c' })
    })
  })

  describe('result size capping', () => {
    it('truncates results exceeding maxResultSize', async () => {
      const bigTool = defineTool({
        name: 'big',
        description: 'Returns big output',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return { content: 'x'.repeat(500), isError: false }
        },
      })

      const result = await executeTool({
        tool: bigTool,
        toolCall: createToolCall('big'),
        context,
        config: { maxResultSize: 100 },
      })

      expect(Buffer.byteLength(result.result.content, 'utf8')).toBeLessThanOrEqual(100)
      expect(result.result.content).toContain('truncated')
      expect(result.result.metadata?.truncated).toBe(true)
      expect(result.result.metadata?.originalSize).toBe(500)
    })

    it('does not truncate results within limit', async () => {
      const result = await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'short' }),
        context,
        config: { maxResultSize: 100_000 },
      })

      expect(result.result.content).toBe('short')
      expect(result.result.metadata?.truncated).toBeUndefined()
    })

    it('respects per-tool maxResultSize', async () => {
      const smallTool = defineTool({
        name: 'small',
        description: 'Small result cap',
        maxResultSize: 200,
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          return { content: 'x'.repeat(1000), isError: false }
        },
      })

      const result = await executeTool({
        tool: smallTool,
        toolCall: createToolCall('small'),
        context,
      })

      expect(Buffer.byteLength(result.result.content, 'utf8')).toBeLessThanOrEqual(200)
      expect(result.result.content).toContain('truncated')
      expect(result.result.metadata?.originalSize).toBe(1000)
    })
  })

  describe('timeout enforcement', () => {
    it('times out slow tools', async () => {
      const hangingTool = defineTool({
        name: 'hang',
        description: 'Hangs forever',
        timeoutMs: 100,
        inputSchema: { type: 'object', properties: {} },
        async execute(_input, ctx) {
          await new Promise((resolve, reject) => {
            ctx.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          })
          return { content: 'never', isError: false }
        },
      })

      const result = await executeTool({
        tool: hangingTool,
        toolCall: createToolCall('hang'),
        context,
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content).toMatch(/timed out|cancelled/i)
    })
  })

  describe('hooks integration', () => {
    it('runs before hooks that modify input', async () => {
      const hooks = new ToolHookRegistry()
      hooks.registerBefore('echo', async (_name, input) => ({
        blocked: false,
        modifiedInput: { ...input, message: 'modified' },
      }))

      const result = await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'original' }),
        context,
        hooks,
      })

      expect(result.result.content).toBe('modified')
    })

    it('blocks execution via before hook', async () => {
      const hooks = new ToolHookRegistry()
      hooks.registerBefore('*', async () => ({
        blocked: true,
        reason: 'Blocked by policy',
      }))

      const result = await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'hi' }),
        context,
        hooks,
      })

      expect(result.result.isError).toBe(true)
      expect(result.result.content).toBe('Blocked by policy')
    })

    it('runs after hooks that modify output', async () => {
      const hooks = new ToolHookRegistry()
      hooks.registerAfter('echo', async (_name, _input, result) => ({
        ...result,
        content: result.content + ' [logged]',
      }))

      const result = await executeTool({
        tool: echoTool,
        toolCall: createToolCall('echo', { message: 'hello' }),
        context,
        hooks,
      })

      expect(result.result.content).toBe('hello [logged]')
    })
  })
})

describe('executeToolBatch', () => {
  it('executes multiple tools sequentially', async () => {
    const context = createMockContext()
    const calls = [
      { tool: echoTool, toolCall: createToolCall('echo', { message: 'a' }) },
      { tool: echoTool, toolCall: createToolCall('echo', { message: 'b' }) },
    ]

    const results = await executeToolBatch(calls, context)

    expect(results).toHaveLength(2)
    expect(results[0]!.result.content).toBe('a')
    expect(results[1]!.result.content).toBe('b')
  })

  it('calls onProgress with tool call IDs', async () => {
    const context = createMockContext()
    const tool = createStreamingTool(['progress'])
    const onProgress = vi.fn()
    const tc = createToolCall('streamer')

    await executeToolBatch(
      [{ tool, toolCall: tc }],
      context,
      undefined,
      undefined,
      onProgress,
    )

    expect(onProgress).toHaveBeenCalledWith(tc.id, { message: 'progress' })
  })
})

// ---------------------------------------------------------------------------
// Result cache integration
// ---------------------------------------------------------------------------

describe('executeTool — result cache', () => {
  it('does not cache when no cache instance is provided', async () => {
    let executions = 0
    const tool = defineTool({
      name: 'counter',
      description: 'counts',
      inputSchema: { type: 'object', properties: {} },
      cacheKey: () => 'k',
      async execute() {
        executions += 1
        return { content: 'v', isError: false }
      },
    })
    const ctx = createMockContext()
    await executeTool({ tool, toolCall: createToolCall('counter'), context: ctx })
    await executeTool({ tool, toolCall: createToolCall('counter'), context: ctx })
    expect(executions).toBe(2)
  })

  it('serves the second identical call from cache', async () => {
    const cache = new ToolResultCache()
    let executions = 0
    const tool = defineTool({
      name: 'counter',
      description: 'counts',
      inputSchema: { type: 'object', properties: {} },
      cacheKey: () => 'same-key',
      async execute() {
        executions += 1
        return { content: `result-${executions}`, isError: false }
      },
    })
    const ctx = createMockContext()
    const r1 = await executeTool({ tool, toolCall: createToolCall('counter'), context: ctx, cache })
    const r2 = await executeTool({ tool, toolCall: createToolCall('counter'), context: ctx, cache })

    expect(executions).toBe(1)
    expect(r1.cacheHit).toBe(false)
    expect(r2.cacheHit).toBe(true)
    expect(r2.result.content).toBe('result-1')
  })

  it('different cacheKeys are independent (no false hits)', async () => {
    const cache = new ToolResultCache()
    let executions = 0
    const tool = defineTool({
      name: 'reader',
      description: 'reads',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      cacheKey: (input) => (input as { path: string }).path,
      async execute(input) {
        executions += 1
        return { content: `content-of-${(input as { path: string }).path}`, isError: false }
      },
    })
    const ctx = createMockContext()
    await executeTool({ tool, toolCall: createToolCall('reader', { path: '/a' }), context: ctx, cache })
    await executeTool({ tool, toolCall: createToolCall('reader', { path: '/b' }), context: ctx, cache })
    await executeTool({ tool, toolCall: createToolCall('reader', { path: '/a' }), context: ctx, cache })

    expect(executions).toBe(2) // /a executed once, /b executed once, second /a was cached
    expect(cache.stats().hits).toBe(1)
  })

  it('cacheKey returning null bypasses the cache', async () => {
    const cache = new ToolResultCache()
    let executions = 0
    const tool = defineTool({
      name: 'volatile',
      description: 'unsafe to cache',
      inputSchema: { type: 'object', properties: {} },
      cacheKey: () => null,
      async execute() {
        executions += 1
        return { content: 'v', isError: false }
      },
    })
    const ctx = createMockContext()
    await executeTool({ tool, toolCall: createToolCall('volatile'), context: ctx, cache })
    await executeTool({ tool, toolCall: createToolCall('volatile'), context: ctx, cache })
    expect(executions).toBe(2)
    expect(cache.stats().hits).toBe(0)
    expect(cache.stats().entries).toBe(0)
  })

  it('errors are NOT cached (transient failures stay retryable)', async () => {
    const cache = new ToolResultCache()
    let executions = 0
    const tool = defineTool({
      name: 'flaky',
      description: 'fails first then succeeds',
      inputSchema: { type: 'object', properties: {} },
      cacheKey: () => 'k',
      async execute() {
        executions += 1
        if (executions === 1) return { content: 'transient error', isError: true }
        return { content: 'ok', isError: false }
      },
    })
    const ctx = createMockContext()
    const r1 = await executeTool({ tool, toolCall: createToolCall('flaky'), context: ctx, cache })
    const r2 = await executeTool({ tool, toolCall: createToolCall('flaky'), context: ctx, cache })
    expect(r1.result.isError).toBe(true)
    expect(r2.result.isError).toBe(false)
    expect(r2.result.content).toBe('ok')
    expect(executions).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// validateInput phase
// ---------------------------------------------------------------------------

describe('validateInput phase', () => {
  let context: ToolContext

  beforeEach(() => {
    context = createMockContext()
  })

  it('runs validateInput before execute and returns its rejection unchanged', async () => {
    const executeSpy = vi.fn().mockResolvedValue({
      content: 'should not run',
      isError: false,
    })
    const tool = defineTool({
      name: 'gate',
      description: 'Has a validation gate',
      inputSchema: { type: 'object', properties: {} },
      async validateInput() {
        return { result: false, message: 'denied at validation', errorCode: 42 }
      },
      execute: executeSpy,
    })

    const result = await executeTool({
      tool,
      toolCall: createToolCall('gate'),
      context,
    })

    expect(result.result.isError).toBe(true)
    expect(result.result.content).toBe('denied at validation')
    expect(result.result.metadata?.validation).toEqual({ errorCode: 42 })
    expect(executeSpy).not.toHaveBeenCalled()
    expect(result.wasPermissionDenied).toBe(false)
  })

  it('defaults errorCode to 0 when validateInput omits it', async () => {
    const tool = defineTool({
      name: 'gate2',
      description: 'No errorCode',
      inputSchema: { type: 'object', properties: {} },
      async validateInput() {
        return { result: false, message: 'no code given' }
      },
      async execute() {
        return { content: 'unused', isError: false }
      },
    })
    const result = await executeTool({
      tool,
      toolCall: createToolCall('gate2'),
      context,
    })
    expect(result.result.metadata?.validation).toEqual({ errorCode: 0 })
  })

  it('does NOT run after-hooks on validation failure', async () => {
    const afterSpy = vi.fn()
    const hooks = new ToolHookRegistry()
    hooks.registerAfter('*', async (_name, _input, result) => {
      afterSpy()
      return { result }
    })

    const tool = defineTool({
      name: 'gate3',
      description: 'Validation rejects, after-hook should be skipped',
      inputSchema: { type: 'object', properties: {} },
      async validateInput() {
        return { result: false, message: 'no', errorCode: 1 }
      },
      async execute() {
        return { content: 'unused', isError: false }
      },
    })

    await executeTool({
      tool,
      toolCall: createToolCall('gate3'),
      context,
      hooks,
    })
    expect(afterSpy).not.toHaveBeenCalled()
  })

  it('proceeds to execute when validateInput returns result: true', async () => {
    const tool = defineTool({
      name: 'pass',
      description: 'Validation passes',
      inputSchema: { type: 'object', properties: {} },
      async validateInput() {
        return { result: true }
      },
      async execute() {
        return { content: 'executed', isError: false }
      },
    })
    const result = await executeTool({
      tool,
      toolCall: createToolCall('pass'),
      context,
    })
    expect(result.result.isError).toBe(false)
    expect(result.result.content).toBe('executed')
  })

  it('runs validateInput AFTER permission denial — short-circuits without validation call', async () => {
    const validateSpy = vi.fn().mockResolvedValue({ result: true })
    const tool = defineTool({
      name: 'permitted',
      description: 'Requires permission',
      requiresPermission: true,
      inputSchema: { type: 'object', properties: {} },
      validateInput: validateSpy,
      async execute() {
        return { content: 'never', isError: false }
      },
    })

    const denyContext = createMockContext({
      requestPermission: vi.fn().mockResolvedValue(false),
    })
    const result = await executeTool({
      tool,
      toolCall: createToolCall('permitted'),
      context: denyContext,
    })

    expect(result.wasPermissionDenied).toBe(true)
    expect(validateSpy).not.toHaveBeenCalled()
  })

  it('runs validateInput AFTER before-hooks (so modified input flows in)', async () => {
    const seen: Record<string, unknown>[] = []
    const tool = defineTool({
      name: 'modified',
      description: 'Sees modified input',
      inputSchema: { type: 'object', properties: {} },
      async validateInput(input) {
        seen.push(input as Record<string, unknown>)
        return { result: true }
      },
      async execute() {
        return { content: 'ok', isError: false }
      },
    })

    const hooks = new ToolHookRegistry()
    hooks.registerBefore('*', async (_name, input) => ({
      modifiedInput: { ...input, injected: 'yes' },
    }))

    await executeTool({
      tool,
      toolCall: createToolCall('modified', { original: true }),
      context,
      hooks,
    })

    expect(seen).toEqual([{ original: true, injected: 'yes' }])
  })

  it('tools without validateInput run unchanged (backwards-compat)', async () => {
    const result = await executeTool({
      tool: echoTool,
      toolCall: createToolCall('echo', { message: 'still works' }),
      context,
    })
    expect(result.result.content).toBe('still works')
    expect(result.result.metadata?.validation).toBeUndefined()
  })
})
