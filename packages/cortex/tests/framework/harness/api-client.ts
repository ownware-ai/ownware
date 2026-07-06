/**
 * Typed HTTP API client for the test gateway.
 *
 * Wraps fetch with:
 *   - Auto-injected auth token
 *   - JSON parsing
 *   - Optional Zod schema validation
 *   - Status code surfaced in response
 *   - Raw text preserved for debugging
 *
 * For SSE endpoints, use .sse() which returns a parsed SSEStream.
 */

import type { ZodType } from 'zod'
import { parseSSE, type SSEStream } from './sse-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  /** HTTP status code */
  readonly status: number
  /** Parsed body (typed if a schema was provided) */
  readonly body: T
  /** Response headers (lowercase keys) */
  readonly headers: Record<string, string>
  /** Raw response text (for debugging) */
  readonly raw: string
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  // ── HTTP methods ─────────────────────────────────────────────────────

  async get<T = unknown>(path: string, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('GET', path, undefined, schema)
  }

  async post<T = unknown>(path: string, body?: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('POST', path, body, schema)
  }

  async put<T = unknown>(path: string, body?: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('PUT', path, body, schema)
  }

  async patch<T = unknown>(path: string, body?: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('PATCH', path, body, schema)
  }

  async delete<T = unknown>(path: string, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('DELETE', path, undefined, schema)
  }

  /**
   * DELETE with a JSON body. Less RESTful than a query parameter but
   * matches the gateway's `DELETE /threads/:id/workspace-roots`
   * contract — the path being revoked goes in the body to keep URLs
   * clean of long absolute paths.
   */
  async del<T = unknown>(path: string, body: unknown, schema?: ZodType<T>): Promise<ApiResponse<T>> {
    return this.request('DELETE', path, body, schema)
  }

  // ── SSE ──────────────────────────────────────────────────────────────

  /**
   * Send a POST that returns an SSE stream. Reads the entire stream
   * to completion, then returns a parsed SSEStream object.
   *
   * For tests that need to interact mid-stream (e.g., respond to
   * permission.request via /resume), use .sseRaw() instead.
   */
  async sse(path: string, body: unknown): Promise<SSEStream> {
    // /api/v1/run is decoupled: POST returns JSON { threadId, agentId }
    // and the SSE stream lives at /threads/:tid/agents/:aid/events.
    if (path === '/api/v1/run') {
      const { text } = await this.runAndReadSSE(body)
      return parseSSE(text)
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const errBody = await res.json()
      throw new Error(`SSE request failed: ${res.status} ${JSON.stringify(errBody)}`)
    }
    const text = await res.text()
    return parseSSE(text)
  }

  /**
   * Internal helper: POST /api/v1/run (decoupled) then read the agent-events
   * SSE stream until `done` / `session.end` or a bounded timeout. Returns
   * the assembled SSE text plus metadata so callers can parse / inspect.
   */
  private async runAndReadSSE(body: unknown): Promise<{
    text: string
    threadId: string
    agentId: string
  }> {
    const runRes = await fetch(`${this.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!runRes.ok) {
      const errText = await runRes.text()
      throw new Error(`POST /api/v1/run failed: ${runRes.status} ${errText}`)
    }
    const start = await runRes.json() as { threadId: string; agentId: string }
    const threadId = start.threadId
    const agentId = start.agentId ?? 'root'

    const sseRes = await fetch(
      `${this.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
      { headers: { Authorization: `Bearer ${this['token']}` } },
    )
    if (!sseRes.ok) {
      const errText = await sseRes.text()
      throw new Error(`GET agent-events failed: ${sseRes.status} ${errText}`)
    }

    const text = await readSSEUntilDone(sseRes, 120_000)
    return { text, threadId, agentId }
  }

  /**
   * Streaming SSE that yields events as they arrive (for mid-stream interaction).
   * Returns an async iterator AND the underlying response so the caller can
   * cancel or inspect headers.
   */
  async sseRaw(path: string, body: unknown): Promise<{
    response: Response
    events: AsyncGenerator<{ event: string; data: unknown }, void, unknown>
    threadId?: string
    agentId?: string
  }> {
    // Decoupled run: POST /run returns JSON, SSE lives on agent-events.
    if (path === '/api/v1/run') {
      const runRes = await fetch(`${this.baseUrl}/api/v1/run`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      })
      if (!runRes.ok) {
        const errText = await runRes.text()
        throw new Error(`POST /api/v1/run failed: ${runRes.status} ${errText}`)
      }
      const start = await runRes.json() as { threadId: string; agentId: string }
      const threadId = start.threadId
      const agentId = start.agentId ?? 'root'
      const sseRes = await fetch(
        `${this.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
        { headers: { Authorization: `Bearer ${this['token']}` } },
      )
      return {
        response: sseRes,
        events: iterateSSE(sseRes),
        threadId,
        agentId,
      }
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })

    async function* iterate(): AsyncGenerator<{ event: string; data: unknown }, void, unknown> {
      if (!response.body) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Process complete events (terminated by \n\n)
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          if (block.startsWith(':')) continue // keepalive comment

          const lines = block.split('\n')
          let eventName = 'message'
          let dataStr = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7)
            else if (line.startsWith('data: ')) dataStr = line.slice(6)
          }
          if (dataStr) {
            try {
              yield { event: eventName, data: JSON.parse(dataStr) }
            } catch {
              yield { event: eventName, data: dataStr }
            }
          }
        }
      }
    }

    return { response, events: iterate() }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    schema?: ZodType<T>,
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { parsed = raw }

    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })

    if (schema && res.ok) {
      const result = schema.safeParse(parsed)
      if (!result.success) {
        throw new Error(
          `Schema validation failed for ${method} ${path}:\n` +
          `${result.error.errors.map(e => `  - ${e.path.join('.')}: ${e.message}`).join('\n')}\n` +
          `Body: ${JSON.stringify(parsed, null, 2)}`,
        )
      }
      return { status: res.status, body: result.data, headers, raw }
    }

    return { status: res.status, body: parsed as T, headers, raw }
  }
}

// ---------------------------------------------------------------------------
// SSE helpers for the decoupled-run flow
// ---------------------------------------------------------------------------

/**
 * Read an SSE Response body until a `done` (or `session.end`) event is seen,
 * or until `maxMs` elapses. Returns the raw SSE text so callers can feed it
 * into parseSSE(). Cancels the underlying stream on exit.
 */
async function readSSEUntilDone(res: Response, maxMs: number): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let buffer = ''
  const start = Date.now()
  let sawDone = false

  try {
    while (Date.now() - start < maxMs && !sawDone) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ])
      if (done && value === undefined) continue
      if (done) break
      if (value) {
        const chunk = decoder.decode(value, { stream: true })
        text += chunk
        buffer += chunk

        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) {
              const name = line.slice(7).trim()
              if (name === 'done' || name === 'session.end') sawDone = true
            }
          }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); await res.body!.cancel() } catch {}
  }
  return text
}

/** Yield SSE events incrementally from a Response body. */
async function* iterateSSE(
  response: Response,
): AsyncGenerator<{ event: string; data: unknown }, void, unknown> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      if (block.startsWith(':') || !block.trim()) continue
      let eventName = 'message'
      let dataStr = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7)
        else if (line.startsWith('data: ')) dataStr = line.slice(6)
      }
      if (dataStr) {
        try { yield { event: eventName, data: JSON.parse(dataStr) } }
        catch { yield { event: eventName, data: dataStr } }
      } else {
        yield { event: eventName, data: null }
      }
      if (eventName === 'done' || eventName === 'session.end') return
    }
  }
}
