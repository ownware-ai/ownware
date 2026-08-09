import { describe, expect, it } from 'vitest'
import {
  bindThreadRuntime,
  capabilityFreshness,
  createRuntimePlan,
  resolveRuntimeSelection,
  RuntimeBindingConflictError,
  RuntimePlanSchema,
  ThreadRuntimeBindingSchema,
} from '../../../src/index.js'

const NOW = '2026-07-26T06:00:00.000Z'
const LATER = '2026-07-26T07:00:00.000Z'
const DIRECT_ACCESS = {
  route: 'openai-chatgpt-direct',
  experimentalOptIn: true,
  capabilityEnvelope: 'openai-chatgpt-direct.v1',
} as const

describe('runtime selection', () => {
  it('keeps legacy profiles on the current Ownware runtime and provider API route', () => {
    expect(resolveRuntimeSelection(undefined)).toEqual({
      runtime: 'ownware',
      access: { route: 'provider-api' },
    })
  })

  it('keeps Ownware execution when direct ChatGPT access is explicitly selected', () => {
    expect(resolveRuntimeSelection({
      runtime: 'ownware',
      access: DIRECT_ACCESS,
    })).toEqual({
      runtime: 'ownware',
      access: DIRECT_ACCESS,
    })
  })

  it('rejects direct mode without explicit opt-in and its named capability envelope', () => {
    expect(() => resolveRuntimeSelection({
      runtime: 'ownware',
      access: { route: 'openai-chatgpt-direct' },
    })).toThrow()
    expect(() => resolveRuntimeSelection({
      runtime: 'ownware',
      access: {
        route: 'openai-chatgpt-direct',
        experimentalOptIn: false,
        capabilityEnvelope: 'openai-chatgpt-direct.v1',
      },
    })).toThrow()
    expect(() => resolveRuntimeSelection({
      runtime: 'ownware',
      access: {
        route: 'openai-chatgpt-direct',
        experimentalOptIn: true,
        capabilityEnvelope: 'future-envelope',
      },
    })).toThrow()
  })

  it('selects the external Codex loop only with Codex-managed ChatGPT access', () => {
    expect(resolveRuntimeSelection({
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    })).toEqual({
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    })
  })

  it.each([
    {
      runtime: 'openai-codex',
      access: DIRECT_ACCESS,
    },
    {
      runtime: 'ownware',
      access: { route: 'openai-chatgpt-managed' },
    },
  ])('rejects a runtime/access combination that changes the claimed loop semantics', (selection) => {
    expect(() => resolveRuntimeSelection(selection)).toThrow()
  })

  it.each([
    { runtime: 'future-runtime', access: { route: 'provider-api' } },
    { runtime: 'ownware', access: { route: 'future-route' } },
  ])('fails honestly for unknown future values', (selection) => {
    expect(() => resolveRuntimeSelection(selection)).toThrow()
  })

  it('rejects unknown configuration fields instead of silently dropping them', () => {
    expect(() => resolveRuntimeSelection({
      runtime: 'ownware',
      access: { route: 'provider-api' },
      fallback: 'openai-codex',
    })).toThrow()
  })

  it('derives support status from the selected mechanism rather than caller input', () => {
    expect(createRuntimePlan(undefined, [], NOW).support).toBe('supported')
    expect(createRuntimePlan({
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    }, [], NOW).support).toBe('experimental')
    expect(createRuntimePlan({
      runtime: 'ownware',
      access: DIRECT_ACCESS,
    }, [], NOW).support).toBe('experimental')
  })

  it.each(['supported', 'unsupported', 'unknown'] as const)(
    'keeps %s capability evidence with authority and freshness',
    (status) => {
      const plan = createRuntimePlan(undefined, [{
        capability: 'profile.instructions',
        status,
        detail: `test ${status}`,
        provenance: {
          authority: 'ownware-contract',
          source: 'runtime-selection-test',
          observedAt: NOW,
          validUntil: LATER,
        },
      }], NOW)

      expect(plan.capabilities[0]?.status).toBe(status)
      expect(capabilityFreshness(plan.capabilities[0]!, NOW)).toBe('current')
      expect(capabilityFreshness(plan.capabilities[0]!, LATER)).toBe('stale')
    },
  )

  it('reports freshness as unknown when the authority supplied no expiry', () => {
    const plan = createRuntimePlan(undefined, [{
      capability: 'provider.quota',
      status: 'unknown',
      detail: 'No authoritative quota observation exists',
      provenance: {
        authority: 'provider-observation',
        source: 'account endpoint unavailable',
        observedAt: NOW,
        validUntil: null,
      },
    }], NOW)

    expect(capabilityFreshness(plan.capabilities[0]!, LATER)).toBe('unknown')
  })

  it('rejects duplicate capabilities and malformed or unknown evidence', () => {
    const evidence = {
      capability: 'tools',
      status: 'supported' as const,
      detail: 'contract',
      provenance: {
        authority: 'ownware-contract' as const,
        source: 'test',
        observedAt: NOW,
        validUntil: LATER,
      },
    }

    expect(() => createRuntimePlan(undefined, [evidence, evidence], NOW)).toThrow()
    expect(() => createRuntimePlan(undefined, [{
      ...evidence,
      status: 'future-status',
    }], NOW)).toThrow()
    expect(() => createRuntimePlan(undefined, [{
      ...evidence,
      provenance: {
        ...evidence.provenance,
        validUntil: 'not-a-date',
      },
    }], NOW)).toThrow()
  })

  it('binds a thread once and returns the same binding idempotently', () => {
    const request = {
      threadId: 'thread-one',
      selection: {
        runtime: 'ownware',
        access: DIRECT_ACCESS,
      },
      boundAt: NOW,
      migratedFromThreadId: null,
    }

    const first = bindThreadRuntime(undefined, request)
    const second = bindThreadRuntime(first, {
      ...request,
      boundAt: LATER,
    })

    expect(first).toEqual({
      schemaVersion: 1,
      ...request,
    })
    expect(second).toBe(first)
  })

  it('refuses to change an existing thread from one runtime to another', () => {
    const existing = bindThreadRuntime(undefined, {
      threadId: 'thread-one',
      selection: {
        runtime: 'ownware',
        access: DIRECT_ACCESS,
      },
      boundAt: NOW,
      migratedFromThreadId: null,
    })

    expect(() => bindThreadRuntime(existing, {
      threadId: 'thread-one',
      selection: {
        runtime: 'openai-codex',
        access: { route: 'openai-chatgpt-managed' },
      },
      boundAt: LATER,
      migratedFromThreadId: null,
    })).toThrow(RuntimeBindingConflictError)
  })

  it('represents an explicit runtime migration as a new thread binding', () => {
    const migrated = bindThreadRuntime(undefined, {
      threadId: 'thread-two',
      selection: {
        runtime: 'openai-codex',
        access: { route: 'openai-chatgpt-managed' },
      },
      boundAt: LATER,
      migratedFromThreadId: 'thread-one',
    })

    expect(migrated.threadId).toBe('thread-two')
    expect(migrated.migratedFromThreadId).toBe('thread-one')
  })

  it('rejects self-migration and unknown fields in thread bindings', () => {
    expect(() => bindThreadRuntime(undefined, {
      threadId: 'same-thread',
      selection: {
        runtime: 'ownware',
        access: { route: 'provider-api' },
      },
      boundAt: NOW,
      migratedFromThreadId: 'same-thread',
    })).toThrow()

    expect(() => bindThreadRuntime(undefined, {
      threadId: 'thread-one',
      selection: {
        runtime: 'ownware',
        access: { route: 'provider-api' },
      },
      boundAt: NOW,
      migratedFromThreadId: null,
      silentlyFallbackTo: 'openai-codex',
    })).toThrow()
  })

  it('round-trips every supported selection through the public JSON schemas', () => {
    const selections = [
      {
        runtime: 'ownware',
        access: { route: 'provider-api' },
      },
      {
        runtime: 'ownware',
        access: DIRECT_ACCESS,
      },
      {
        runtime: 'openai-codex',
        access: { route: 'openai-chatgpt-managed' },
      },
    ]

    for (const [index, selection] of selections.entries()) {
      const plan = createRuntimePlan(selection, [], NOW)
      expect(RuntimePlanSchema.parse(
        JSON.parse(JSON.stringify(plan)),
      )).toEqual(plan)

      const binding = bindThreadRuntime(undefined, {
        threadId: `thread-${index}`,
        selection,
        boundAt: NOW,
        migratedFromThreadId: null,
      })
      expect(ThreadRuntimeBindingSchema.parse(
        JSON.parse(JSON.stringify(binding)),
      )).toEqual(binding)
    }
  })

  it('rejects a freshness window that ends at or before its observation', () => {
    const capability = {
      capability: 'tools',
      status: 'supported',
      detail: 'test',
      provenance: {
        authority: 'runtime-observation',
        source: 'test',
        observedAt: NOW,
        validUntil: NOW,
      },
    }

    expect(() => createRuntimePlan(undefined, [capability], NOW)).toThrow()
  })
})
