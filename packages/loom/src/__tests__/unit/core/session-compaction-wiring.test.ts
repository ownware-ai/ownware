/**
 * Session compaction auto-wiring.
 *
 * Before this change, Session's constructor interpreted `undefined`
 * and `null` the same way — both resulted in no compaction. Every
 * consumer that forgot to pass a manager (including the production
 * gateway) silently ran without compaction, regardless of what the
 * profile's `compaction` block said.
 *
 * The fix: `undefined` now auto-constructs a manager from
 * `config.compaction`; `null` is an explicit opt-out. This test file
 * pins the three-path contract so a future refactor can't quietly
 * collapse it back.
 */

import { describe, it, expect } from 'vitest'
import { Session } from '../../../core/session.js'
import { createDefaultConfig } from '../../../core/config.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../provider/types.js'
import type { ModelPricing } from '../../../provider/pricing.js'
import type { CompactionManager } from '../../../compaction/manager.js'
import type { Message } from '../../../messages/types.js'

// ---------------------------------------------------------------------------
// Minimal stubs — enough to satisfy the types without dragging a real
// provider or pricing catalog.
// ---------------------------------------------------------------------------

function makeProvider(): ProviderAdapter {
  return {
    name: 'sessionwiring',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      // Session compaction wiring does not drive a turn in these tests,
      // so stream() is never actually called — only its shape matters.
      yield {
        type: 'message_complete',
        content: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
    },
    async countTokens(_messages: Message[]): Promise<number> {
      return 0
    },
    supportsFeature(_f: ProviderFeature): boolean {
      return false
    },
    formatTools(_tools: ToolDefinition[]): unknown[] {
      return []
    },
    getModelPricing(_model: string): ModelPricing | null {
      return null
    },
  }
}

/** Read the session's private compaction field for assertion. */
function getCompaction(session: Session): CompactionManager | null {
  // The field is private, but TypeScript only enforces this at
  // compile time; at runtime it is a plain object property. Access
  // via bracket-notation with a cast so the test intent is explicit.
  return (session as unknown as { compaction: CompactionManager | null }).compaction
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session compaction auto-wiring', () => {
  it('default (undefined) → manager is auto-constructed', () => {
    const config = createDefaultConfig('sessionwiring:any-model')
    const session = new Session({
      config,
      provider: makeProvider(),
      tools: [],
    })
    const compaction = getCompaction(session)
    expect(compaction).not.toBeNull()
    // Duck-type check — the auto-constructed manager exposes the
    // contract interface consumers depend on.
    expect(typeof compaction?.compactIfNeeded).toBe('function')
    expect(typeof compaction?.forceCompact).toBe('function')
  })

  it('explicit null → compaction is disabled (escape hatch)', () => {
    const config = createDefaultConfig('sessionwiring:any-model')
    const session = new Session({
      config,
      provider: makeProvider(),
      tools: [],
      compaction: null,
    })
    expect(getCompaction(session)).toBeNull()
  })

  it('explicit manager instance → used verbatim (no auto-construction)', () => {
    const config = createDefaultConfig('sessionwiring:any-model')
    // A sentinel manager — trivially identifiable, just needs to
    // satisfy the type.
    const sentinel: CompactionManager = {
      async compactIfNeeded() { return null },
      async forceCompact() { return null },
    }
    const session = new Session({
      config,
      provider: makeProvider(),
      tools: [],
      compaction: sentinel,
    })
    expect(getCompaction(session)).toBe(sentinel)
  })

  it('auto-constructed manager respects LoomConfig.compaction (strategy, trigger, retain)', () => {
    // The manager is constructed from `config.compaction` — if a
    // consumer tunes the compaction block on LoomConfig, the session
    // must honour it. We cannot easily inspect the manager's internal
    // config directly, but we can confirm the auto-wire path ran by
    // checking that `compaction` is non-null and the shape is right.
    // The behavioural confirmation lives in the drop-then-summarize
    // e2e test where both tiers fire on a real API call.
    const config = createDefaultConfig('sessionwiring:any-model')
    const session = new Session({
      config,
      provider: makeProvider(),
      tools: [],
    })
    expect(getCompaction(session)).not.toBeNull()
  })
})
