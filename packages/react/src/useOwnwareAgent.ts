/**
 * useOwnwareAgent — drive a live Ownware agent from React.
 *
 * Wires the transport (@ownware/client) to the headless reducer (@ownware/ui):
 *   run()  starts/continues a run · events()  streams · resume()  approves.
 *
 * One persistent SSE stream per thread tails everything (deltas, tool calls,
 * approvals, the follow-up after a tool round-trip). `send()` just injects a
 * prompt with run(); the open stream carries the reply back into the reducer.
 *
 *   const a = useOwnwareAgent({ baseUrl: 'http://localhost:4000', token, profileId: 'assistant' })
 *   a.send('hello')
 *   // a.messages · a.streaming · a.pendingApproval · a.approve() / a.deny()
 *
 * Headless: this returns state + actions. The <OwnwareChat> component (next)
 * renders it with the design-system-v2 skin.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { OwnwareClient, type GatewayEvent, type ModelEntry, type ResumeInput, type RunResult } from '@ownware/client'
import {
  addUserMessage,
  chatReducer,
  initialChatState,
  type AgentEvent,
  type ChatState,
  type Message,
  type PendingApproval,
} from '@ownware/ui'

/** The transport the hook needs — implemented by OwnwareClient; faked in tests. */
export interface AgentTransport {
  run(input: { profileId: string; prompt: string; threadId?: string; model?: string }): Promise<RunResult>
  events(threadId: string, opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<GatewayEvent>
  resume(threadId: string, input: ResumeInput): Promise<void>
  abort(threadId: string): Promise<void>
  models(): Promise<ModelEntry[]>
}

export interface UseOwnwareAgentOptions {
  /** Which profile answers. */
  readonly profileId: string
  /** Gateway base URL (required unless you pass `client`). */
  readonly baseUrl?: string
  /** Bearer token when gateway auth is on. */
  readonly token?: string
  /** Override the model for this session. */
  readonly model?: string
  /** Continue an existing thread instead of starting fresh. */
  readonly threadId?: string
  /** Inject a transport (tests / custom). Overrides baseUrl/token. */
  readonly client?: AgentTransport
}

export interface OwnwareAgent {
  readonly messages: readonly Message[]
  readonly status: ChatState['status']
  /** Convenience: status === 'streaming'. */
  readonly streaming: boolean
  readonly pendingApproval: PendingApproval | null
  readonly model?: string
  readonly error?: string
  /** Model catalog with live availability (`hasCredentials`). */
  readonly models: readonly ModelEntry[]
  readonly threadId?: string
  /** Send a prompt (starts the thread on the first call). */
  readonly send: (prompt: string) => Promise<void>
  /** Approve the pending request (the amber card). */
  readonly approve: () => Promise<void>
  /** Deny the pending request. */
  readonly deny: () => Promise<void>
  /** Stop the running agent. */
  readonly abort: () => Promise<void>
}

type Action =
  | { readonly k: 'ev'; readonly e: AgentEvent }
  | { readonly k: 'user'; readonly text: string }

function reduce(state: ChatState, action: Action): ChatState {
  return action.k === 'ev' ? chatReducer(state, action.e) : addUserMessage(state, action.text)
}

export function useOwnwareAgent(opts: UseOwnwareAgentOptions): OwnwareAgent {
  const { profileId, model } = opts

  const client = useMemo<AgentTransport>(() => {
    if (opts.client) return opts.client
    if (!opts.baseUrl) throw new Error('useOwnwareAgent requires `baseUrl` (or a `client`)')
    return new OwnwareClient({ baseUrl: opts.baseUrl, token: opts.token })
  }, [opts.client, opts.baseUrl, opts.token])

  const [state, dispatch] = useReducer(reduce, null, initialChatState)
  const [models, setModels] = useState<readonly ModelEntry[]>([])

  const threadIdRef = useRef<string | undefined>(opts.threadId)
  const streamingRef = useRef(false) // guard: one events loop per thread
  const abortRef = useRef<AbortController | null>(null)
  const pendingRef = useRef<PendingApproval | null>(null)

  // Keep a ref of the pending approval so action callbacks stay stable.
  useEffect(() => {
    pendingRef.current = state.pendingApproval
  }, [state.pendingApproval])

  // Load the model catalog once.
  useEffect(() => {
    let alive = true
    client
      .models()
      .then((m) => {
        if (alive) setModels(m)
      })
      .catch(() => {
        /* non-fatal — models are informational */
      })
    return () => {
      alive = false
    }
  }, [client])

  // Close the stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  const startStream = useCallback(
    (threadId: string) => {
      if (streamingRef.current) return // already tailing this thread
      streamingRef.current = true
      const ac = new AbortController()
      abortRef.current = ac
      void (async () => {
        try {
          for await (const ev of client.events(threadId, { since: 0, signal: ac.signal })) {
            // We render our own optimistic user row, so skip the echo.
            // (Full history hydration of an existing thread lands with the component.)
            if (ev.type === 'user.message') continue
            dispatch({ k: 'ev', e: ev })
          }
        } catch (err) {
          if (!ac.signal.aborted) {
            dispatch({ k: 'ev', e: { type: 'error', seq: 0, data: { message: errMsg(err) } } })
          }
        } finally {
          streamingRef.current = false
        }
      })()
    },
    [client],
  )

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim()
      if (!text) return
      dispatch({ k: 'user', text }) // optimistic — shows instantly
      try {
        const res: RunResult = await client.run({ profileId, prompt: text, threadId: threadIdRef.current, model })
        threadIdRef.current = res.threadId
        startStream(res.threadId)
      } catch (err) {
        dispatch({ k: 'ev', e: { type: 'error', seq: 0, data: { message: errMsg(err) } } })
      }
    },
    [client, profileId, model, startStream],
  )

  const resumeWith = useCallback(
    async (action: ResumeInput['action']) => {
      const tid = threadIdRef.current
      const pending = pendingRef.current
      if (!tid || !pending) return
      // Optimistically dismiss the card so it feels instant.
      dispatch({ k: 'ev', e: { type: 'permission.response', seq: 0, data: { requestId: pending.requestId } } })
      try {
        await client.resume(tid, { action, requestId: pending.requestId })
      } catch (err) {
        dispatch({ k: 'ev', e: { type: 'error', seq: 0, data: { message: errMsg(err) } } })
      }
    },
    [client],
  )

  const approve = useCallback(() => resumeWith('approve'), [resumeWith])
  const deny = useCallback(() => resumeWith('deny'), [resumeWith])

  const abort = useCallback(async () => {
    const tid = threadIdRef.current
    if (!tid) return
    try {
      await client.abort(tid)
    } catch {
      /* best-effort */
    }
  }, [client])

  return {
    messages: state.messages,
    status: state.status,
    streaming: state.status === 'streaming',
    pendingApproval: state.pendingApproval,
    model: state.model,
    error: state.error,
    models,
    threadId: threadIdRef.current,
    send,
    approve,
    deny,
    abort,
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
