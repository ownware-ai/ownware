// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useOwnwareAgent, type AgentTransport } from '../index.js'
import type { RunResult, ModelEntry } from '@ownware/client'
import type { AgentEvent } from '@ownware/ui'

const tick = () => new Promise((r) => setTimeout(r, 0))

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
  const resume = vi.fn(async () => {})
  const abort = vi.fn(async () => {})
  const run = vi.fn(async (): Promise<RunResult> => ({ threadId: 't-1' }))
  const models = vi.fn(
    async (): Promise<ModelEntry[]> => [{ id: 'openai:gpt-5.5', hasCredentials: true, default: true }],
  )
  const transport: AgentTransport = {
    run,
    events: (tid, opts) => ch.stream(tid, opts),
    resume,
    abort,
    models,
  }
  return { transport, resume, abort, run, models, ch }
}

describe('useOwnwareAgent', () => {
  it('sends a prompt and streams the reply through the reducer', async () => {
    const ch = channel()
    const { transport, run } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => {
      await result.current.send('hi')
    })
    expect(run).toHaveBeenCalledWith({ profileId: 'assistant', prompt: 'hi', threadId: undefined, model: undefined })

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
    const { transport, resume } = fakeTransport(ch)
    const { result } = renderHook(() => useOwnwareAgent({ profileId: 'assistant', client: transport }))

    await act(async () => {
      await result.current.send('connect slack')
    })
    await act(async () => {
      ch.push({
        type: 'permission.request',
        seq: 1,
        data: { requestId: 'r1', toolName: 'slack_connect', reason: 'read + reply in #support only' },
      })
      await tick()
    })

    await waitFor(() => expect(result.current.status).toBe('awaiting_approval'))
    expect(result.current.pendingApproval).toMatchObject({ requestId: 'r1', toolName: 'slack_connect' })

    await act(async () => {
      await result.current.approve()
    })
    expect(resume).toHaveBeenCalledWith('t-1', { action: 'approve', requestId: 'r1' })
    expect(result.current.pendingApproval).toBeNull() // optimistic clear
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
      await result.current.send('hi')
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('gateway down')
    ch.close()
  })
})
