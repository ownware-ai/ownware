import { describe, it, expect, vi, beforeEach } from 'vitest'
import { todoWrite, taskTools, type TaskStore, type TaskEntry } from '../tasks.js'
import type { ToolContext, ToolResult } from '../../types.js'
import type { LoomConfig } from '../../../core/config.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStore(
  impl?: Partial<TaskStore>,
): { store: TaskStore; replaceAll: ReturnType<typeof vi.fn> } {
  const replaceAll = vi.fn(async (tasks) => {
    const now = '2026-04-22T00:00:00.000Z'
    return tasks.map((t: { content: string; status: TaskEntry['status'] }, i: number) => ({
      id: `id-${i}`,
      content: t.content,
      status: t.status,
      order: i,
      createdAt: now,
      updatedAt: now,
    }))
  })
  const store: TaskStore = {
    replaceAll: impl?.replaceAll ?? replaceAll,
  }
  return { store, replaceAll }
}

function makeContext(store?: TaskStore): ToolContext {
  const config = (store == null ? {} : { taskStore: store }) as unknown as LoomConfig
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test-session',
    agentId: null,
    workspacePath: '/tmp',
    config,
    requestPermission: vi.fn().mockResolvedValue(true),
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

async function run(
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const res = await todoWrite.execute(input as Record<string, unknown>, ctx)
  // The tool is async not a generator — assert the shape.
  if (typeof (res as AsyncGenerator<unknown>).next === 'function') {
    throw new Error('todo_write should return a ToolResult, not a generator')
  }
  return res as ToolResult
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('todo_write', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is registered in taskTools', () => {
    expect(taskTools).toContain(todoWrite)
    expect(todoWrite.name).toBe('todo_write')
  })

  it('has the expected tool metadata', () => {
    expect(todoWrite.category).toBe('custom')
    expect(todoWrite.isReadOnly).toBe(false)
    expect(todoWrite.requiresPermission).toBe(false)
  })

  it('returns isError with reason=no_store when no TaskStore is configured', async () => {
    const ctx = makeContext()
    const result = await run({ tasks: [] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.metadata?.reason).toBe('no_store')
  })

  it('empty list returns "No tasks." and calls store exactly once with []', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: [] }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toBe('No tasks.')
    expect(replaceAll).toHaveBeenCalledTimes(1)
    expect(replaceAll).toHaveBeenCalledWith([])
    expect(result.metadata?.count).toBe(0)
  })

  it('defaults status to "pending" when omitted', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: [{ content: 'A' }] }, ctx)
    expect(result.isError).toBe(false)
    expect(replaceAll).toHaveBeenCalledWith([{ content: 'A', status: 'pending' }])
    expect(result.content).toContain('[ ] 1. A')
  })

  it('formats all three statuses with the expected glyphs', async () => {
    const { store } = makeStore()
    const ctx = makeContext(store)
    const result = await run(
      {
        tasks: [
          { content: 'One', status: 'in_progress' },
          { content: 'Two', status: 'pending' },
          { content: 'Three', status: 'completed' },
        ],
      },
      ctx,
    )
    expect(result.content).toContain('[~] 1. One')
    expect(result.content).toContain('[ ] 2. Two')
    expect(result.content).toContain('[x] 3. Three')
    expect(result.metadata).toMatchObject({
      count: 3,
      pending: 1,
      inProgress: 1,
      completed: 1,
    })
  })

  it('trims content before passing to the store', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    await run({ tasks: [{ content: '  trim me  ', status: 'pending' }] }, ctx)
    expect(replaceAll).toHaveBeenCalledWith([{ content: 'trim me', status: 'pending' }])
  })

  it('rejects empty / whitespace content without calling the store', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: [{ content: '   ' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/empty/i)
    expect(replaceAll).not.toHaveBeenCalled()
  })

  it('rejects content over MAX_CONTENT_LENGTH without calling the store', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const huge = 'x'.repeat(2001)
    const result = await run({ tasks: [{ content: huge }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/maximum is 2000/)
    expect(replaceAll).not.toHaveBeenCalled()
  })

  it('rejects invalid status values without calling the store', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: [{ content: 'A', status: 'bogus' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/pending, in_progress, completed/)
    expect(replaceAll).not.toHaveBeenCalled()
  })

  it('rejects non-array tasks input', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: 'nope' }, ctx)
    expect(result.isError).toBe(true)
    expect(replaceAll).not.toHaveBeenCalled()
  })

  it('rejects non-object tasks[i]', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const result = await run({ tasks: ['string-not-object'] }, ctx)
    expect(result.isError).toBe(true)
    expect(replaceAll).not.toHaveBeenCalled()
  })

  it('surfaces store errors as isError without crashing the loop', async () => {
    const failing: TaskStore = {
      replaceAll: async () => {
        throw new Error('db is down')
      },
    }
    const ctx = makeContext(failing)
    const result = await run({ tasks: [{ content: 'A' }] }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('db is down')
    expect(result.metadata?.reason).toBe('store_error')
  })

  it('preserves input order in the output text', async () => {
    const { store } = makeStore()
    const ctx = makeContext(store)
    const result = await run(
      {
        tasks: [
          { content: 'Z', status: 'pending' },
          { content: 'A', status: 'pending' },
          { content: 'M', status: 'pending' },
        ],
      },
      ctx,
    )
    const zIdx = result.content.indexOf('Z')
    const aIdx = result.content.indexOf('A')
    const mIdx = result.content.indexOf('M')
    expect(zIdx).toBeGreaterThan(0)
    expect(zIdx).toBeLessThan(aIdx)
    expect(aIdx).toBeLessThan(mIdx)
  })

  it('idempotency — same input twice = same output, store called twice with identical args', async () => {
    const { store, replaceAll } = makeStore()
    const ctx = makeContext(store)
    const input = { tasks: [{ content: 'A', status: 'pending' as const }] }
    const a = await run(input, ctx)
    const b = await run(input, ctx)
    expect(a.content).toBe(b.content)
    expect(replaceAll).toHaveBeenCalledTimes(2)
    expect(replaceAll.mock.calls[0]?.[0]).toEqual(replaceAll.mock.calls[1]?.[0])
  })
})
