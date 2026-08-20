// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

afterEach(cleanup)
import { OwnwareChat, type AgentTransport } from '../index.js'
import type {
  CapabilityNegotiationResult,
  ProviderHubModelPage,
  RunResult,
  ThreadHydration,
} from '@ownware/client'
import type { AgentEvent } from '@ownware/ui'

const tick = () => new Promise((r) => setTimeout(r, 0))

const MODEL_PAGE = {
  generationId: 'test-generation',
  items: [{
    model: {
      id: 'ollama:llama3.2',
      providerRouteId: 'route:ollama',
      wireModelId: 'llama3.2',
      name: 'Llama 3.2',
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
      billingKind: 'local',
      catalogSourceRef: 'test',
    },
    prices: [],
  }],
  page: { limit: 200, total: 1, nextCursor: null },
  warnings: [],
} satisfies ProviderHubModelPage

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
  const transport: AgentTransport = {
    run: vi.fn(async (): Promise<RunResult> => ({ threadId: 't-1', runId: 'run-1' })),
    events: (tid, opts) => ch.stream(tid, opts),
    capabilities: vi.fn(async (): Promise<CapabilityNegotiationResult> => ({
      status: 'available',
      contract: { name: 'ownware.gateway', major: 1, revision: '0.46.0' },
      capabilities: [
        { id: 'runs.permissions.decide', version: 1 },
        { id: 'runs.sensitive-input.submit', version: 1 },
        { id: 'runs.sensitive-input.deny', version: 1 },
      ],
    })),
    decidePermission,
    submitSensitiveInput,
    denySensitiveInput,
    providerHubModels: vi.fn(async () => MODEL_PAGE),
  }
  return { transport, decidePermission, submitSensitiveInput, denySensitiveInput }
}

describe('<OwnwareChat>', () => {
  it('renders the greeting, then a sent message and the streamed reply + tool card', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    render(<OwnwareChat profileId="assistant" client={transport} agentName="Rosa" greeting="Ask Rosa anything" />)

    expect(screen.getByText('Rosa')).toBeTruthy()
    expect(screen.getByText('Ask Rosa anything')).toBeTruthy()

    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(box, { target: { value: 'find flower shops' } })
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    expect(screen.getByText('find flower shops')).toBeTruthy()

    await act(async () => {
      const uiDescriptor = {
        kind: 'search',
        summary: { verb: 'Search web', primaryField: 'query' },
      }
      ch.push({ type: 'tool.call.start', seq: 1, data: { toolCallId: 't1', toolName: 'web_search', input: { query: 'flower shops' }, uiDescriptor } })
      ch.push({ type: 'tool.call.end', seq: 2, data: { toolCallId: 't1', toolName: 'web_search', result: '5 results', isError: false, durationMs: 420, uiDescriptor } })
      ch.push({ type: 'text.delta', seq: 3, data: { text: 'Here are some.' } })
      ch.push({ type: 'turn.end', seq: 4, data: { stopReason: 'end_turn' } })
      await tick()
    })

    await waitFor(() => expect(screen.getByText('Here are some.')).toBeTruthy())
    // the tool card now renders the descriptor verb + primary (not the raw tool name)
    expect(screen.getByText('Search web')).toBeTruthy()
    expect(screen.getByText('flower shops')).toBeTruthy()
    expect(screen.getByText(/tool finished/)).toBeTruthy()
    ch.close()
  })

  it('shows the approval card and approves on click', async () => {
    const ch = channel()
    const { transport, decidePermission } = fakeTransport(ch)
    render(<OwnwareChat profileId="assistant" client={transport} />)

    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(box, { target: { value: 'connect slack' } })
      fireEvent.keyDown(box, { key: 'Enter' })
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

    await waitFor(() => expect(screen.getByText(/Approval needed/)).toBeTruthy())
    expect(screen.getByText('read + reply in #support only')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByText('Approve exact request'))
    })
    expect(decidePermission).toHaveBeenCalledWith('run-1', 'r1', {
      decision: 'approve',
      operationHash: 'a'.repeat(64),
    })
    ch.close()
  })

  it('keeps sensitive text in a local password field and clears it after dedicated submission', async () => {
    const ch = channel()
    const { transport, submitSensitiveInput } = fakeTransport(ch)
    render(<OwnwareChat profileId="assistant" client={transport} />)
    const composer = screen.getByRole('textbox', { name: 'Message the agent' })
    await act(async () => {
      fireEvent.change(composer, { target: { value: 'sign in' } })
      fireEvent.keyDown(composer, { key: 'Enter' })
    })
    await act(async () => {
      ch.push({
        type: 'sensitive.input.request',
        seq: 1,
        data: {
          requestId: 's1',
          toolCallId: 'call-1',
          toolName: 'managed_input',
          label: 'Password',
          usage: 'Enter it into the selected field.',
          agentId: null,
          adapterRevision: 'managed-browser.v1',
        },
      })
      await tick()
    })
    await waitFor(() => {
      expect(document.querySelector('input[name="ownware-sensitive-s1"]')).toBeTruthy()
    })
    const field = document.querySelector('input[name="ownware-sensitive-s1"]') as HTMLInputElement
    const canary = 'sensitive-ui-canary'
    fireEvent.change(field, { target: { value: canary } })
    expect(field.type).toBe('password')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Submit securely' })) })
    await waitFor(() => expect(submitSensitiveInput).toHaveBeenCalledWith('run-1', 's1', canary))
    await waitFor(() => {
      expect(document.querySelector('input[name="ownware-sensitive-s1"]')).toBeNull()
    })
    expect(document.body.textContent).not.toContain(canary)
    ch.close()
  })

  it('renders hydrated text and tool activity in the authoritative durable order', async () => {
    const ch = channel()
    const { transport } = fakeTransport(ch)
    transport.hydrateThread = vi.fn(async (): Promise<ThreadHydration> => ({
      thread: {
        id: 't-history',
        profileId: 'assistant',
        workspaceId: null,
        title: null,
        status: 'completed',
        messageCount: 1,
        totalTokens: 0,
        totalCost: 0,
        model: null,
        createdAt: '2026-08-18T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
        lastMessagePreview: 'before after',
      },
      messages: [{
        id: 'm-history',
        role: 'assistant',
        content: 'before after',
        timestamp: '2026-08-18T00:00:00.000Z',
        tools: [{
          toolCallId: 'history-tool',
          name: 'unfamiliar_search_provider',
          input: { query: 'flowers' },
          output: 'found',
          isError: false,
          uiDescriptor: {
            kind: 'search',
            summary: { verb: 'Lookup', primaryField: 'query' },
          },
        }],
        parts: [
          { kind: 'text', text: 'before ' },
          { kind: 'tool', toolCallId: 'history-tool' },
          { kind: 'text', text: 'after' },
        ],
      }],
      agents: [],
      runningAgentId: null,
      runningRunId: null,
      maxSeq: 9,
      lastClosedTurnEndSeq: 9,
    }))
    render(<OwnwareChat profileId="assistant" threadId="t-history" client={transport} />)
    const message = await screen.findByLabelText('Agent message')
    const content = message.textContent ?? ''
    expect(content.indexOf('before')).toBeLessThan(content.indexOf('Lookup'))
    expect(content.indexOf('Lookup')).toBeLessThan(content.indexOf('after'))
    ch.close()
  })
})
