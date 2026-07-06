/**
 * SSE Pattern 15: Checkpoint Save/Restore
 *
 * Validates that session state can be saved via checkpoint store
 * and restored in a new session with full conversation context.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { Session, resolveProvider, createDefaultConfig, mergeConfig, MemoryCheckpointStore } from '../../../src/index.js'
import { collectEvents } from '../harness/event-collector.js'
import {
  assertStreamCompleted,
  assertTextContains,
  assertHasUsage,
} from '../harness/assertions.js'
import { createSandbox, type Sandbox } from '../harness/sandbox.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 15: Checkpoint Save/Restore', () => {
  let sandbox: Sandbox

  afterEach(async () => {
    if (sandbox) await sandbox.cleanup()
  })

  it('session state survives save and restore via MemoryCheckpointStore', async () => {
    sandbox = await createSandbox()
    const model = 'anthropic:claude-haiku-4-5-20251001'
    const { provider } = resolveProvider(model)
    const store = new MemoryCheckpointStore()
    const baseConfig = createDefaultConfig(model)
    const config = mergeConfig(baseConfig, {
      model,
      maxTurns: 2,
      maxTokens: 128,
      systemPrompt: 'You are a concise assistant. Remember everything told to you.',
      workspacePath: sandbox.path,
    })

    // Session 1: Establish context
    const session1 = new Session({
      config,
      provider,
      tools: [],
      checkpoint: store,
    })

    const stream1 = await collectEvents(
      session1.submitMessage('My secret password is COBALT-99. Acknowledge.'),
      30_000,
    )
    assertStreamCompleted(stream1)

    // Save state
    const state = session1.getState()
    expect(state.messages.length).toBeGreaterThanOrEqual(2)
    expect(state.turnCount).toBe(1)
    expect(state.totalUsage.inputTokens).toBeGreaterThan(0)

    // Session 2: Restore from saved state
    const session2 = new Session({
      config,
      provider,
      tools: [],
      checkpoint: store,
    })
    session2.restore(state)

    // Verify restored state matches
    const restoredState = session2.getState()
    expect(restoredState.turnCount).toBe(1)
    expect(restoredState.messages.length).toBe(state.messages.length)

    // Ask the restored session about the secret
    const stream2 = await collectEvents(
      session2.submitMessage('What was my secret password?'),
      30_000,
    )
    assertStreamCompleted(stream2)
    assertTextContains(stream2, 'COBALT-99')
    assertHasUsage(stream2)

    // Verify turn count accumulated
    const finalState = session2.getState()
    expect(finalState.turnCount).toBe(2)
  }, 60_000)

  it('MemoryCheckpointStore saves and loads correctly', async () => {
    const store = new MemoryCheckpointStore()

    const checkpoint = {
      sessionId: 'test-123',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
      turnIndex: 3,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
      timestamp: Date.now(),
    }

    // Save
    await store.save(checkpoint)

    // Load
    const loaded = await store.load('test-123')
    expect(loaded).toBeTruthy()
    expect(loaded!.sessionId).toBe('test-123')
    expect(loaded!.turnIndex).toBe(3)
    expect(loaded!.messages.length).toBe(1)

    // Non-existent
    const missing = await store.load('nonexistent')
    expect(missing).toBeNull()

    // Size
    expect(store.size).toBe(1)

    // Delete
    await store.delete('test-123')
    expect(store.size).toBe(0)
  })
})
