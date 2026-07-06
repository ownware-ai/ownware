/**
 * Memory Tools — E2E Test
 *
 * Tests memory_store, memory_search, and memory_forget with a real LLM
 * and a real (in-memory) MemoryStore implementation. Verifies the model
 * can store information, search for it, and forget it.
 */

import { describe, it, afterEach } from 'vitest'
import { createTestSession } from '../harness/index.js'
import {
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
} from '../harness/assertions.js'
import type { TestSession } from '../harness/session.js'
import { memoryTools } from '../../../src/tools/builtins/memory.js'
import type { MemoryStore, MemoryEntry } from '../../../src/tools/builtins/memory.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

// ---------------------------------------------------------------------------
// In-memory store implementation for testing
// ---------------------------------------------------------------------------

class InMemoryStore implements MemoryStore {
  private entries = new Map<string, { content: string; metadata?: Record<string, unknown>; createdAt: string }>()
  private counter = 0

  async store(entry: { content: string; metadata?: Record<string, unknown> }): Promise<string> {
    const id = `mem_${++this.counter}`
    this.entries.set(id, {
      content: entry.content,
      metadata: entry.metadata,
      createdAt: new Date().toISOString(),
    })
    return id
  }

  async search(query: string, options?: { limit?: number; threshold?: number }): Promise<MemoryEntry[]> {
    const limit = options?.limit ?? 10
    const results: MemoryEntry[] = []

    for (const [id, entry] of this.entries) {
      // Simple keyword matching for testing
      const queryLower = query.toLowerCase()
      const contentLower = entry.content.toLowerCase()
      const words = queryLower.split(/\s+/)
      const matchCount = words.filter(w => contentLower.includes(w)).length
      const score = matchCount / words.length

      if (score > 0) {
        results.push({
          id,
          content: entry.content,
          score,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
        })
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id)
  }

  get size() { return this.entries.size }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Tool: memory (E2E)', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('stores and retrieves a memory via LLM', async () => {
    const store = new InMemoryStore()

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: memoryTools,
      systemPrompt:
        'You are a concise assistant with memory tools. ' +
        'When asked to remember something, use memory_store. ' +
        'When asked to recall, use memory_search.',
      maxTurns: 5,
      maxTokens: 512,
      configOverrides: {
        memoryStore: store,
      } as Record<string, unknown>,
    })

    // Store a fact
    const storeStream = await ts.run(
      'Remember this fact: The capital of Australia is Canberra. Use memory_store to save it.',
    )
    assertStreamCompleted(storeStream)
    assertToolCalled(storeStream, 'memory_store')
    assertToolSucceeded(storeStream, 'memory_store')

    // Verify store was called
    if (store.size === 0) throw new Error('No memory was stored')

    // Search for it
    const searchStream = await ts.run(
      'What is the capital of Australia? Use memory_search to find the answer.',
    )
    assertStreamCompleted(searchStream)
    assertToolCalled(searchStream, 'memory_search')
    assertToolSucceeded(searchStream, 'memory_search')
    assertTextContains(searchStream, 'Canberra')
  }, 60_000)

  it('forgets a memory via LLM', async () => {
    const store = new InMemoryStore()

    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: memoryTools,
      systemPrompt:
        'You are a concise assistant. Use memory tools when asked. ' +
        'When asked to forget, first search for the memory, then delete it using memory_forget.',
      maxTurns: 8,
      maxTokens: 512,
      permissionMode: 'allow-all',
      configOverrides: {
        memoryStore: store,
      } as Record<string, unknown>,
    })

    // Store something first
    await ts.run('Remember: my favorite color is blue. Use memory_store.')

    // Now forget it
    const forgetStream = await ts.run(
      'Forget the memory about my favorite color. First search for it, then delete it with memory_forget.',
    )
    assertStreamCompleted(forgetStream)
    assertToolCalled(forgetStream, 'memory_search')
    assertToolCalled(forgetStream, 'memory_forget')

    // Store should be empty after deletion
    if (store.size !== 0) throw new Error(`Expected 0 memories but got ${store.size}`)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Unit tests (no API key needed)
// ---------------------------------------------------------------------------

describe('Tool: memory (unit)', () => {
  it('memory_store returns error when no store configured', async () => {
    const tool = memoryTools.find(t => t.name === 'memory_store')!
    const result = await tool.execute(
      { content: 'test' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: {} as any,
        requestPermission: async () => true,
      },
    )
    if (!('content' in result)) throw new Error('Expected ToolResult')
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error')
    if (!res.content.includes('not configured')) throw new Error('Expected "not configured" message')
  })

  it('memory_store rejects empty content', async () => {
    const store = new InMemoryStore()
    const tool = memoryTools.find(t => t.name === 'memory_store')!
    const result = await tool.execute(
      { content: '' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { memoryStore: store } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (!res.isError) throw new Error('Expected error for empty content')
  })

  it('memory_search returns "no memories" for empty store', async () => {
    const store = new InMemoryStore()
    const tool = memoryTools.find(t => t.name === 'memory_search')!
    const result = await tool.execute(
      { query: 'anything' },
      {
        cwd: '/tmp',
        signal: new AbortController().signal,
        sessionId: 'test',
        agentId: null,
        workspacePath: '/tmp',
        config: { memoryStore: store } as any,
        requestPermission: async () => true,
      },
    )
    const res = result as { content: string; isError: boolean }
    if (res.isError) throw new Error('Should not be an error')
    if (!res.content.includes('No memories found')) throw new Error('Expected "No memories found"')
  })
})
