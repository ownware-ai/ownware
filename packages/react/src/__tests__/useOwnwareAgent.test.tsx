// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useOwnwareAgent, type AgentTransport } from '../index.js'
import type {
  CapabilityNegotiationResult,
  EffectReceipt,
  ProviderHubModelPage,
  RunResult,
  RunSnapshot,
  ThreadHydration,
} from '@ownware/client'
import type { AgentEvent } from '@ownware/ui'

const tick = () => new Promise((r) => setTimeout(r, 0))

function hubPage(id: string): ProviderHubModelPage {
  const [provider = 'test', wireModelId = id] = id.split(':', 2)
  return {
    generationId: 'test-generation',
    items: [{
      model: {
        id,
        providerRouteId: `route:${provider}`,
        wireModelId,
        name: id,
        aliases: [],
        contextWindow: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        capabilities: [],
        variants: [],
        availability: {
          catalogued: true,
          connectable: true,
          credentialed: true,
          verified: false,
          recommended: true,
          lifecycle: 'active',
          connectionIds: ['connection:test'],
        },
        billingKind: provider === 'ollama' ? 'local' : 'metered',
        catalogSourceRef: 'test',
      },
      prices: [],
    }],
    page: { limit: 200, total: 1, nextCursor: null },
    warnings: [],
  }
}

/** A controllable SSE-like stream the test pushes events onto. */
function channel() {
  const q: AgentEvent[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    push(e: AgentEvent) {
      q.push(e)
      wake?.()
      wake = null
    },
    close() {
      closed = true
      wake?.()
      wake = null
    },
    async *stream(_tid: string, opts?: { signal?: AbortSignal }): AsyncGenerator<AgentEvent> {
      const signal = opts?.signal
      for (;;) {
        while (q.length) yield q.shift()!
        if (closed || signal?.aborted) return
        await new Promise<void>((r) => {
          wake = r
          signal?.addEventListener('abort', () => r(), { once: true })
        })
      }
    },
  }
}

function fakeTransport(ch: ReturnType<typeof channel>) {
  const decidePermission = vi.fn(async (runId: string, requestId: string, input: { decision: 'approve' | 'deny'; operationHash: string }) => ({
    runId,
    requestId,
    ...input,
    intentRevision: 1 as const,
  }))
  const cancel = vi.fn(async () => ({
    runId: 'run-1',
    status: 'cancel_requested' as const,
    consequence: 'none_observed' as const,
    terminal: false,
    outcomeKnown: false,
    cancellation: 'requested' as const,
  }))
  const submitSensitiveInput = vi.fn(async (runId: string, requestId: string, _value: string) => ({
    runId,
    requestId,
    accepted: true as const,
    status: 'provided' as const,
  }))
  const denySensitiveInput = vi.fn(async (runId: string, requestId: string) => ({
    runId,
    requestId,
    accepted: true as const,
    status: 'denied' as const,
  }))
  const run = vi.fn(async (): Promise<RunResult> => ({ threadId: 't-1', runId: 'run-1' }))
  const providerHubModels = vi.fn(async () => hubPage('openai:gpt-5.5'))
  const capabilities = vi.fn(async (): Promise<CapabilityNegotiationResult> => ({
    status: 'available',
    contract: { name: 'ownware.gateway', major: 1, revision: '0.46.0' },
    capabilities: [
      { id: 'runs.permissions.decide', version: 1 },
      { id: 'runs.abort', version: 4 },
      { id: 'runs.sensitive-input.submit', version: 1 },
      { id: 'runs.sensitive-input.deny', version: 1 },
      { id: 'threads.hydrate', version: 1 },
    ],
  }))
  const transport: AgentTransport = {
    run,
    events: (tid, opts) => ch.stream(tid, opts),
    capabilities,
    decidePermission,
    cancel,
    submitSensitiveInput,
    denySensitiveInput,
    providerHubModels,
  }
  return {
    transport,
    decidePermission,
    cancel,
    submitSensitiveInput,
    denySensitiveInput,
    run,
    providerHubModels,
    ch,
  }
}

describe('useOwnwareAgent', () => {
  it('sends a prompt and streams the reply through the reducer', async () => {
    const ch = channel()
    const { transport, run } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => {
      await result.current.send('hi')
    })
    expect(run).toHaveBeenCalledWith({ profileId: 'assistant', prompt: 'hi' })

    await act(async () => {
      ch.push({ type: 'text.delta', seq: 1, data: { text: 'Hello ' } })
      ch.push({ type: 'text.delta', seq: 2, data: { text: 'there' } })
      ch.push({ type: 'turn.end', seq: 3, data: { stopReason: 'end_turn' } })
      await tick()
    })

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello there'],
    ])
    expect(result.current.threadId).toBe('t-1')
    ch.close()
  })

  it('surfaces a pending approval and resumes on approve()', async () => {
    const ch = channel()
    const { transport, decidePermission } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => {
      await result.current.send('connect slack')
    })
    await act(async () => {
      ch.push({
        type: 'permission.request',
        seq: 1,
        data: {
          requestId: 'r1',
          toolName: 'slack_connect',
          reason: 'read + reply in #support only',
          operationHash: 'a'.repeat(64),
          intentRevision: 1,
        },
      })
      await tick()
    })

    await waitFor(() => expect(result.current.status).toBe('awaiting_approval'))
    await waitFor(() => expect(result.current.support.permissionDecision.state).toBe('supported'))
    expect(result.current.pendingApproval).toMatchObject({ requestId: 'r1', toolName: 'slack_connect' })

    await act(async () => {
      await result.current.approve()
    })
    expect(decidePermission).toHaveBeenCalledWith('run-1', 'r1', {
      decision: 'approve',
      operationHash: 'a'.repeat(64),
    })
    expect(result.current.pendingApproval).toBeNull()
    ch.close()
  })

  it('keeps an exact approval pending when the authoritative mutation fails', async () => {
    const ch = channel()
    const { transport, decidePermission } = fakeTransport(ch)
    decidePermission.mockRejectedValueOnce(new Error('conflict'))
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => { await result.current.send('connect slack') })
    await act(async () => {
      ch.push({
        type: 'permission.request',
        seq: 1,
        data: {
          requestId: 'r1',
          toolName: 'slack_connect',
          operationHash: 'a'.repeat(64),
          intentRevision: 1,
        },
      })
      await tick()
    })
    await waitFor(() => expect(result.current.pendingApproval?.requestId).toBe('r1'))
    await act(async () => {
      await expect(result.current.approve()).rejects.toThrow('conflict')
    })
    expect(result.current.pendingApproval?.requestId).toBe('r1')
    expect(result.current.actionErrors['permission:r1']).toBe(
      'The exact permission decision was not accepted.',
    )
    ch.close()
  })

  it('loads the model catalog on mount', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await waitFor(() => expect(result.current.models.length).toBe(1))
    expect(result.current.models[0]!.id).toBe('openai:gpt-5.5')
    ch.close()
  })

  it('reports a run failure as an error state', async () => {
    const ch = channel()
    const { transport, run } = fakeTransport(ch)
    run.mockRejectedValueOnce(new Error('gateway down'))
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => {
      await expect(result.current.send('hi')).rejects.toThrow('gateway down')
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('Could not start the run.')
    ch.close()
  })

  it('hydrates durable history and does not invent an active run identity', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    const hydration: ThreadHydration = {
      thread: {
        id: 't-existing',
        profileId: 'assistant',
        workspaceId: null,
        title: null,
        status: 'completed',
        messageCount: 2,
        totalTokens: 3,
        totalCost: 0,
        model: 'test:model',
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:01.000Z',
        lastMessagePreview: 'hello',
      },
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-08-18T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'hi', timestamp: '2026-08-18T00:00:01.000Z' },
      ],
      agents: [],
      runningAgentId: null,
      runningRunId: null,
      maxSeq: 8,
      lastClosedTurnEndSeq: 8,
    }
    transport.hydrateThread = vi.fn(async () => hydration)
    const events = vi.fn(transport.events)
    transport.events = events

    const { result } = renderHook(() => useOwnwareAgent({
      profileId: 'assistant',
      threadId: 't-existing',
      client: transport,
    }))

    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.messages.map(message => message.text)).toEqual(['hello', 'hi'])
    expect(result.current.activeRunId).toBeUndefined()
    expect(result.current.connection.lastDeliveredSeq).toBe(8)
    expect(events).not.toHaveBeenCalled()
    ch.close()
  })

  it('rehydrates instead of applying a run-event sequence gap', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    const hydration: ThreadHydration = {
      thread: {
        id: 't-1',
        profileId: 'assistant',
        workspaceId: null,
        title: null,
        status: 'completed',
        messageCount: 2,
        totalTokens: 0,
        totalCost: 0,
        model: null,
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:01.000Z',
        lastMessagePreview: 'authoritative',
      },
      messages: [
        { id: 'm1', role: 'user', content: 'go', timestamp: '2026-08-18T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'authoritative', timestamp: '2026-08-18T00:00:01.000Z' },
      ],
      agents: [],
      runningAgentId: null,
      runningRunId: null,
      maxSeq: 3,
      lastClosedTurnEndSeq: 3,
    }
    transport.hydrateThread = vi.fn(async () => hydration)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => { await result.current.send('go') })
    await act(async () => {
      ch.push({ type: 'text.delta', seq: 1, data: { text: 'partial' } })
      ch.push({ type: 'text.delta', seq: 3, data: { text: 'must not append' } })
      await tick()
    })
    await waitFor(() => expect(transport.hydrateThread).toHaveBeenCalledWith('t-1'))
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe('authoritative'))
    expect(result.current.messages.at(-1)?.text).not.toContain('must not append')
    ch.close()
  })

  it('keeps a sensitive value out of reducer state and submits it only to the dedicated method', async () => {
    const ch = channel()
    const { transport, submitSensitiveInput } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({
      profileId: 'assistant',
      sensitiveInputMode: 'component-local',
      client: transport,
    }))
    await act(async () => { await result.current.send('sign in') })
    await act(async () => {
      ch.push({
        type: 'sensitive.input.request',
        seq: 1,
        data: {
          requestId: 's1',
          toolCallId: 'call-1',
          toolName: 'managed_input',
          label: 'Password',
          usage: 'Enter it in the selected field.',
          agentId: null,
          adapterRevision: 'managed-browser.v1',
        },
      })
      await tick()
    })
    await waitFor(() => expect(result.current.pendingSensitiveInput?.requestId).toBe('s1'))
    const canary = 'sensitive-canary-value'
    await act(async () => { await result.current.submitSensitiveInput('s1', canary) })
    expect(submitSensitiveInput).toHaveBeenCalledWith('run-1', 's1', canary)
    expect(JSON.stringify(result.current)).not.toContain(canary)
    expect(result.current.pendingSensitiveInput).toBeNull()
    ch.close()
  })

  it('loads every evidence page and preserves effect uncertainty after success', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    const snapshot: RunSnapshot = {
      runId: 'run-1',
      threadId: 't-1',
      workspaceId: null,
      profileId: 'assistant',
      model: 'test:model',
      timeoutMs: 1_000,
      egressMode: 'unrestricted',
      status: 'succeeded',
      consequence: 'effect_possible',
      terminal: true,
      outcomeKnown: false,
      acceptedAt: 1,
      startedAt: 2,
      updatedAt: 3,
      terminalAt: 3,
      cancelRequestedAt: null,
      startSeq: 1,
      endSeq: 4,
      earliestRetainedCursor: 0,
      code: null,
    }
    const first: EffectReceipt = {
      receiptId: 'receipt-1',
      sequence: 1,
      effectId: 'effect-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'custom',
      kind: 'intent_observed',
      outcome: 'pending',
      consequence: 'none_observed',
      authorityKind: 'runtime',
      authorityRef: 'runtime.tool_call.start',
      observedAt: 2,
    }
    const second: EffectReceipt = {
      ...first,
      receiptId: 'receipt-2',
      sequence: 2,
      kind: 'reconciliation',
      outcome: 'unknown',
      consequence: 'effect_possible',
      authorityKind: 'reconciler',
      authorityRef: 'gateway.reconcile',
      observedAt: 3,
    }
    transport.capabilities = vi.fn(async () => ({
      status: 'available' as const,
      contract: { name: 'ownware.gateway', major: 1, revision: '0.46.0' },
      capabilities: [
        { id: 'runs.snapshot', version: 5 },
        { id: 'runs.effects.read', version: 1 },
      ],
    }))
    transport.runSnapshot = vi.fn(async () => snapshot)
    transport.listEffectReceipts = vi.fn(async (_runId, options) => options?.cursor === 'next'
      ? { items: [second], nextCursor: null }
      : { items: [first], nextCursor: 'next' })

    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))
    await act(async () => { await result.current.send('do it') })
    await waitFor(() => expect(result.current.evidence.effects.state).toBe('ready'))
    expect(result.current.evidence.effects.state === 'ready'
      ? result.current.evidence.effects.value
      : []).toHaveLength(2)
    expect(result.current.evidence.consequence).toMatchObject({
      state: 'ready',
      consequence: 'effect_possible',
      statement: 'An external effect may have occurred.',
    })
    ch.close()
  })
})
