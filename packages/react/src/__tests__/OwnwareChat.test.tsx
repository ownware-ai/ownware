// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'

afterEach(cleanup)
import { OwnwareChat, type AgentTransport } from '../index.js'
import type { RunResult, ModelEntry } from '@ownware/client'
import type { AgentEvent } from '@ownware/ui'

const tick = () => new Promise((r) => setTimeout(r, 0))

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
  const resume = vi.fn(async () => {})
  const transport: AgentTransport = {
    run: vi.fn(async (): Promise<RunResult> => ({ threadId: 't-1' })),
    events: (tid, opts) => ch.stream(tid, opts),
    resume,
    abort: vi.fn(async () => {}),
    models: vi.fn(async (): Promise<ModelEntry[]> => [{ id: 'ollama:llama3.2', hasCredentials: true, default: true }]),
  }
  return { transport, resume }
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
      ch.push({ type: 'tool.call.start', seq: 1, data: { toolCallId: 't1', toolName: 'web_search', input: { query: 'flower shops' } } })
      ch.push({ type: 'tool.call.end', seq: 2, data: { toolCallId: 't1', result: '5 results', isError: false, durationMs: 420 } })
      ch.push({ type: 'text.delta', seq: 3, data: { text: 'Here are some.' } })
      ch.push({ type: 'turn.end', seq: 4, data: { stopReason: 'end_turn' } })
      await tick()
    })

    await waitFor(() => expect(screen.getByText('Here are some.')).toBeTruthy())
    // the tool card now renders the descriptor verb + primary (not the raw tool name)
    expect(screen.getByText('Searched web')).toBeTruthy()
    expect(screen.getByText('flower shops')).toBeTruthy()
    expect(screen.getByText(/done/)).toBeTruthy()
    ch.close()
  })

  it('shows the approval card and approves on click', async () => {
    const ch = channel()
    const { transport, resume } = fakeTransport(ch)
    render(<OwnwareChat profileId="assistant" client={transport} />)

    const box = screen.getByPlaceholderText('Message the agent…') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(box, { target: { value: 'connect slack' } })
      fireEvent.keyDown(box, { key: 'Enter' })
    })
    await act(async () => {
      ch.push({ type: 'permission.request', seq: 1, data: { requestId: 'r1', toolName: 'slack_connect', reason: 'read + reply in #support only' } })
      await tick()
    })

    await waitFor(() => expect(screen.getByText(/Approval needed/)).toBeTruthy())
    expect(screen.getByText('read + reply in #support only')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByText('Approve'))
    })
    expect(resume).toHaveBeenCalledWith('t-1', { action: 'approve', requestId: 'r1' })
    ch.close()
  })
})
