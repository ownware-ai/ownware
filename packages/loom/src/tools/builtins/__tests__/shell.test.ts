import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execute, shellTools } from '../shell.js'
import type { ToolContext, ToolProgress, ToolResult } from '../../types.js'
import type { LoomConfig } from '../../../core/config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: process.cwd(),
    config: {} as LoomConfig,
    requestPermission: vi.fn().mockResolvedValue(true),
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
    ...overrides,
  }
}

async function drainGenerator(
  gen: AsyncGenerator<ToolProgress, ToolResult>,
): Promise<{ progress: ToolProgress[]; result: ToolResult }> {
  const progress: ToolProgress[] = []
  let next = await gen.next()
  while (!next.done) {
    progress.push(next.value)
    next = await gen.next()
  }
  return { progress, result: next.value }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('shell_execute', () => {
  it('runs a simple command and captures stdout', async () => {
    const gen = execute.execute(
      { command: 'echo "hello world"' } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { result } = await drainGenerator(gen)

    expect(result.isError).toBe(false)
    expect(result.content).toContain('hello world')
    expect(result.metadata?.exitCode).toBe(0)
  })

  it('captures stderr', async () => {
    const gen = execute.execute(
      { command: 'echo "error output" >&2' } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { result } = await drainGenerator(gen)

    expect(result.content).toContain('error output')
  })

  it('returns non-zero exit code as error', async () => {
    const gen = execute.execute(
      { command: 'exit 42' } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { result } = await drainGenerator(gen)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Exit code: 42')
    expect(result.metadata?.exitCode).toBe(42)
  })

  it('yields initial progress with command', async () => {
    const gen = execute.execute(
      { command: 'echo hi' } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { progress } = await drainGenerator(gen)

    expect(progress.length).toBeGreaterThanOrEqual(1)
    expect(progress[0]!.message).toBe('$ echo hi')
  })

  it('respects cwd parameter', async () => {
    const gen = execute.execute(
      { command: 'pwd', cwd: '/tmp' } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { result } = await drainGenerator(gen)

    // /tmp might resolve to /private/tmp on macOS
    expect(result.content).toMatch(/\/tmp/)
  })

  it('handles timeout', async () => {
    const gen = execute.execute(
      { command: 'sleep 30', timeout: 200 } as Record<string, unknown>,
      createMockContext(),
    ) as AsyncGenerator<ToolProgress, ToolResult>

    const { result } = await drainGenerator(gen)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('timed out')
  }, 10_000)

  it('handles abort signal', async () => {
    const controller = new AbortController()
    const ctx = createMockContext({ signal: controller.signal })

    const gen = execute.execute(
      { command: 'sleep 30' } as Record<string, unknown>,
      ctx,
    ) as AsyncGenerator<ToolProgress, ToolResult>

    // Abort after a short delay
    setTimeout(() => controller.abort(), 200)

    const { result } = await drainGenerator(gen)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('cancelled')
  }, 10_000)

  it('is NOT read-only', () => {
    expect(execute.isReadOnly).toBe(false)
  })

  it('requires permission', () => {
    expect(execute.requiresPermission).toBe(true)
  })

  it('has category shell', () => {
    expect(execute.category).toBe('shell')
  })
})

describe('shellTools export', () => {
  it('exports an array containing the execute tool', () => {
    expect(shellTools).toHaveLength(1)
    expect(shellTools[0]!.name).toBe('shell_execute')
  })
})
