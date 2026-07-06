/**
 * OwnwareClient — the typed SDK over the gateway wire contract.
 *
 * "5 lines to talk to your agent":
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
 *   const { threadId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
 *   for await (const ev of ownware.streamReply(threadId)) {
 *     if (ev.type === 'delta') process.stdout.write(ev.text)
 *   }
 *
 * Transport rules the whole class follows:
 *   - fetch + ReadableStream SSE, never EventSource (bearer auth needs
 *     headers; EventSource can't send them).
 *   - Node and browser: nothing here touches node:* APIs.
 *   - Every SSE event carries `seq` — the resume cursor. Reconnect with
 *     `since: lastSeq` and the stream resumes instead of replaying.
 *
 * The wire contract itself is versioned next to this package:
 * `spec/openapi.yaml` (REST) + `spec/asyncapi.yaml` (SSE events).
 */

import { parseSseFrames } from './sse.js'
import { interpretSseEvent, type RunStreamEvent } from './run-stream.js'

// ── inputs / outputs ─────────────────────────────────────────────────────────

export interface RunInput {
  readonly profileId: string
  readonly prompt: string
  readonly threadId?: string
  readonly model?: string
}

export interface RunResult {
  readonly threadId: string
  /** Agent that answers — 'root' for a plain run. */
  readonly agentId?: string
  readonly profileId?: string
  /** The model the gateway ACTUALLY dispatched (profile default, your override, or the keyless fallback). */
  readonly model?: string
  readonly status?: string
}

export interface StreamReplyOptions {
  /** Resume cursor — replay events with seq > since. Default 0. */
  readonly since?: number
  readonly signal?: AbortSignal
}

/** One raw gateway event: the SSE frame's JSON with its seq surfaced. */
export interface GatewayEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

export interface ResumeInput {
  readonly action: 'approve' | 'deny' | 'always' | 'answer' | 'allow_folder_session'
  /** Free-text reply when `action: 'answer'`. */
  readonly answer?: string
  /** Specific pending request (when multiple are outstanding). */
  readonly requestId?: string
  /** Absolute path being granted when `action: 'allow_folder_session'`. */
  readonly grantPath?: string
}

/** One entry from GET /api/v1/models. */
export interface ModelEntry {
  readonly id: string
  readonly name?: string
  readonly provider?: string
  /** Whether this model can answer RIGHT NOW (key set, or local Ollama reachable). */
  readonly hasCredentials?: boolean
  /** At most one entry per catalog carries true — the recommended pick. */
  readonly default?: boolean
  readonly [key: string]: unknown
}

export interface HealthResult {
  readonly status: string
  readonly version?: string
  readonly [key: string]: unknown
}

/**
 * The minimal seam a channel adapter (or any driver) needs. `OwnwareClient`
 * implements it; tests substitute an in-memory fake.
 */
export interface GatewayClient {
  run(input: RunInput): Promise<RunResult>
  streamReply(threadId: string, opts?: StreamReplyOptions): AsyncIterable<RunStreamEvent>
  /**
   * Answer a paused run (`permission` stream event) — approve/deny the
   * pending request. Channel adapters use this to turn a chat reply
   * into the decision.
   */
  resume(threadId: string, input: ResumeInput): Promise<void>
}

export interface OwnwareClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:3011` (or `https://…` with a trusted/pinned cert). */
  readonly baseUrl: string
  /** Bearer token when gateway auth is enabled (`<dataDir>/gateway-token`, or `gateway.token` in-process). */
  readonly token?: string
  /** Injectable fetch (tests, custom TLS dispatcher). Defaults to global fetch. */
  readonly fetch?: typeof fetch
}

// ── the client ───────────────────────────────────────────────────────────────

export class OwnwareClient implements GatewayClient {
  private readonly base: string
  private readonly token: string | undefined
  private readonly doFetch: typeof fetch

  constructor(opts: OwnwareClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.doFetch = opts.fetch ?? fetch
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`ownware ${path} failed: ${res.status} ${await safeText(res)}`)
    }
    return res
  }

  /** Start a run. Returns immediately — stream the reply separately. */
  async run(input: RunInput): Promise<RunResult> {
    const body: Record<string, unknown> = { prompt: input.prompt, profileId: input.profileId }
    if (input.threadId) body['threadId'] = input.threadId
    if (input.model) body['model'] = input.model

    const res = await this.post('/api/v1/run', body)
    const data = (await res.json()) as RunResult & { threadId?: string }
    if (!data.threadId) throw new Error('ownware run response missing threadId')
    return data as RunResult
  }

  /**
   * One run's reply as text deltas → done/error. Closes the socket
   * itself at the run's terminal event (the root SSE never closes on
   * its own — see run-stream.ts).
   */
  async *streamReply(threadId: string, opts: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    const since = opts.since ?? 0
    let lastSeq = since
    for await (const frame of this.rawFrames(threadId, since, opts.signal)) {
      const { event, stop, seq } = interpretSseEvent(frame.event, frame.data, lastSeq)
      lastSeq = seq
      if (event) yield event
      if (stop) break
    }
  }

  /**
   * The RAW event stream — every gateway event (tool calls, permission
   * requests, thinking, usage…), uninterpreted, with its seq. Stays open
   * until the caller stops reading or aborts; it does NOT end at a
   * run's terminal event. Use `streamReply` for "one reply as text".
   */
  async *events(threadId: string, opts: StreamReplyOptions = {}): AsyncIterable<GatewayEvent> {
    let lastSeq = opts.since ?? 0
    for await (const frame of this.rawFrames(threadId, opts.since ?? 0, opts.signal)) {
      const seq = typeof frame.data['seq'] === 'number' ? (frame.data['seq'] as number) : lastSeq
      lastSeq = seq
      const type = typeof frame.data['type'] === 'string' ? (frame.data['type'] as string) : frame.event
      yield { type, seq, data: frame.data }
    }
  }

  /** Answer a `permission.request` (or other pause) — the run resumes. */
  async resume(threadId: string, input: ResumeInput): Promise<void> {
    const body: Record<string, unknown> = { action: input.action }
    if (input.answer !== undefined) body['answer'] = input.answer
    if (input.requestId !== undefined) body['requestId'] = input.requestId
    if (input.grantPath !== undefined) body['grantPath'] = input.grantPath
    await this.post(`/api/v1/threads/${encodeURIComponent(threadId)}/resume`, body)
  }

  /** Stop a running agent. */
  async abort(threadId: string): Promise<void> {
    await this.post(`/api/v1/threads/${encodeURIComponent(threadId)}/abort`, {})
  }

  /** The model catalog with live availability (`hasCredentials`). */
  async models(): Promise<ModelEntry[]> {
    const res = await this.doFetch(`${this.base}/api/v1/models`, { headers: this.headers(false) })
    if (!res.ok) throw new Error(`ownware /models failed: ${res.status} ${await safeText(res)}`)
    return (await res.json()) as ModelEntry[]
  }

  /** Liveness — the one unauthenticated route. */
  async health(): Promise<HealthResult> {
    const res = await this.doFetch(`${this.base}/api/v1/health`, { headers: this.headers(false) })
    if (!res.ok) throw new Error(`ownware /health failed: ${res.status}`)
    return (await res.json()) as HealthResult
  }

  private async *rawFrames(
    threadId: string,
    since: number,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const url = `${this.base}/api/v1/threads/${encodeURIComponent(threadId)}/agents/root/events?since=${since}`
    const init: RequestInit = { headers: this.headers(false) }
    if (signal) init.signal = signal

    const res = await this.doFetch(url, init)
    if (!res.ok || !res.body) throw new Error(`ownware stream failed: ${res.status}`)

    for await (const frame of parseSseFrames(res.body as ReadableStream<Uint8Array>)) {
      if (typeof frame.data !== 'object' || frame.data === null) continue
      yield { event: frame.event, data: frame.data as Record<string, unknown> }
    }
  }
}

/**
 * Back-compat name from the shuttle era — same class. Prefer
 * `OwnwareClient` in new code.
 */
export { OwnwareClient as HttpGatewayClient }
export type { OwnwareClientOptions as HttpGatewayClientOptions }

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
