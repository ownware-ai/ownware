/**
 * MCP Transport Implementations
 *
 * Each transport handles the raw communication layer between
 * the MCP client and server. The client uses MCPTransportLayer
 * interface, so transports are swappable.
 *
 * Supported:
 * - stdio:     Spawn child process, communicate via stdin/stdout
 * - SSE:       HTTP Server-Sent Events (long-lived GET + POST for requests)
 * - HTTP:      StreamableHTTP (POST per request, streaming response)
 * - WebSocket: Bidirectional ws:// or wss:// connection
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type {
  MCPTransportLayer,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHTTPServerConfig,
  MCPWebSocketServerConfig,
  MCPServerConfig,
} from './types.js'
import { MCPError } from './types.js'

// ---------------------------------------------------------------------------
// Stdio environment allowlist
// ---------------------------------------------------------------------------
//
// 2026-04-11 audit Hazard 2 fix.
//
// Previously the stdio transport spawned every MCP child with the FULL
// parent environment via `{ ...process.env, ...config.env }`. That leaked
// every secret in the user's shell — ANTHROPIC_API_KEY, OPENAI_API_KEY,
// AWS keys, GitHub tokens, anything ending in _SECRET — into untrusted
// MCP server packages installed via the marketplace. A malicious npm
// package could `console.log(process.env)` and exfiltrate the user's
// entire credential set on the first tool call.
//
// MCP servers are third-party code. They MUST run with the smallest env
// they can. The list below is the minimum needed for `npx`, `uvx`, `bun`,
// `python`, `node`, and `docker` to find their binaries, resolve module
// paths, write to caches, and pass through locale + tty hints.
//
// Anything an MCP server actually needs (a token, a connection string,
// etc.) MUST be passed via `config.env` — that's the contract. The
// audit + tests lock this in.
//
// Pattern entries (suffixed with `*`) match any env var name that starts
// with the prefix. They cover npm/node/uv/python/bun ecosystems where
// the relevant config vars are namespaced and can vary across versions.
const STDIO_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // ── POSIX basics ────────────────────────────────────────────────
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOSTNAME',
  // Locale (a lot of MCP servers crash without these on macOS)
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LANGUAGE',
  // Terminal hints (puppeteer / browser servers occasionally need these)
  'TERM',
  'COLORTERM',
  'DISPLAY',
  'XAUTHORITY',
  // ── Node / npx / npm ────────────────────────────────────────────
  'NODE_PATH',
  'NODE_OPTIONS',
  // ── Python / uv / uvx ───────────────────────────────────────────
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'VIRTUAL_ENV',
  // ── Windows essentials ──────────────────────────────────────────
  'SYSTEMROOT',
  'SystemRoot',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'ALLUSERSPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'NUMBER_OF_PROCESSORS',
  'OS',
])

const STDIO_ENV_PREFIX_ALLOWLIST: readonly string[] = [
  // npm/npx config vars (npm_config_cache, npm_config_prefix, etc.).
  // We deliberately do NOT include `npm_config__authToken` style auth
  // entries; those land via Set membership only if explicitly listed.
  'npm_config_',
  // Node version managers (nvm, fnm, volta) drop their root paths here.
  // npx running through one of these tools needs them to find binaries.
  'NVM_',
  'FNM_',
  'VOLTA_',
  // bun's own config
  'BUN_',
  // uv (Python) cache + config
  'UV_',
]

// Auth-token-shaped npm config keys we explicitly DROP even if they
// happen to start with `npm_config_`. Belt and braces — npm publishes
// authentication tokens through env vars in CI, and we don't want a
// random MCP package reading them.
const STDIO_ENV_DENY_PATTERNS: readonly RegExp[] = [
  /authToken/i,
  /password/i,
  /secret/i,
  /token$/i,
]

/**
 * Build the env object passed to a stdio MCP child process.
 *
 * Order:
 *   1. Start empty.
 *   2. Copy each parent env var that's on the allowlist (or matches an
 *      allowlist prefix and DOES NOT match a deny pattern).
 *   3. Layer the per-server `config.env` on top — these are the values
 *      the user explicitly opted in via the credential store / config.
 *      They override any inherited value of the same name.
 *
 * Exported (named with leading underscore) so the unit test can verify
 * the allowlist behavior without spawning real processes.
 */
export function _buildStdioEnv(
  parentEnv: NodeJS.ProcessEnv,
  serverEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    const allowed =
      STDIO_ENV_ALLOWLIST.has(key) ||
      STDIO_ENV_PREFIX_ALLOWLIST.some(prefix => key.startsWith(prefix))
    if (!allowed) continue
    if (STDIO_ENV_DENY_PATTERNS.some(re => re.test(key))) continue
    out[key] = value
  }
  if (serverEnv) {
    for (const [key, value] of Object.entries(serverEnv)) {
      out[key] = value
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Stdio Transport
// ---------------------------------------------------------------------------

export class StdioTransport implements MCPTransportLayer {
  private process: ChildProcess | null = null
  private readline: ReadlineInterface | null = null
  private messageHandler: ((msg: string) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null
  private _isOpen = false

  constructor(private readonly config: MCPStdioServerConfig) {}

  get isOpen(): boolean {
    return this._isOpen
  }

  /**
   * Spawn the server process and set up line-based I/O.
   *
   * Three audit fixes happen here (2026-04-11):
   *
   *   - Hazard 2: env is built via the strict allowlist above. The
   *     parent process.env is no longer leaked wholesale to MCP children.
   *     Provider API keys, AWS credentials, GitHub tokens, etc. stay
   *     in the gateway process where they belong.
   *
   *   - Hazard 3: child stderr is drained continuously. Without this,
   *     ~64KB of stderr output (any chatty MCP server) fills the OS
   *     pipe buffer and the child wedges on the next stderr write,
   *     looking from outside like "the server got slow." We accumulate
   *     a bounded tail buffer so initialization errors are visible
   *     when reconnect logs them.
   */
  async start(): Promise<void> {
    const env = _buildStdioEnv(process.env, this.config.env)
    const args = this.config.args ? [...this.config.args] : []

    this.process = spawn(this.config.command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.on('exit', () => {
      this._isOpen = false
      this.closeHandler?.()
    })

    this.process.on('error', (err) => {
      this._isOpen = false
      this.errorHandler?.(err)
    })

    if (!this.process.stdout) {
      throw new MCPError('Failed to open stdout', this.config.name)
    }

    // Hazard 3: drain stderr so the child never blocks on a full pipe.
    // We keep the most recent 8KB so error reporting can include the
    // tail of whatever the server complained about, but otherwise the
    // bytes are discarded. NEVER forward to console.log directly — a
    // buggy MCP server could echo a token in its own logs.
    if (this.process.stderr) {
      const STDERR_TAIL_LIMIT = 8 * 1024
      this.process.stderr.on('data', (chunk: Buffer) => {
        try {
          const piece = chunk.toString('utf-8')
          const merged = this._stderrTail + piece
          this._stderrTail = merged.length > STDERR_TAIL_LIMIT
            ? merged.slice(merged.length - STDERR_TAIL_LIMIT)
            : merged
        } catch {
          // Decoder errors are non-fatal — we just lose this slice.
        }
      })
      // A pipe error after exit shouldn't crash the process.
      this.process.stderr.on('error', () => { /* ignore */ })
    }

    this.readline = createInterface({ input: this.process.stdout })
    this.readline.on('line', (line) => {
      const trimmed = line.trim()
      if (trimmed) this.messageHandler?.(trimmed)
    })

    this._isOpen = true
  }

  /**
   * Most recent ~8KB of child stderr output. Useful for diagnostics
   * when initialization fails — the manager can include this in the
   * MCPError it surfaces. Empty until the child writes something.
   */
  get stderrTail(): string {
    return this._stderrTail
  }
  private _stderrTail = ''

  send(message: string): void {
    if (!this.process?.stdin?.writable) {
      throw new MCPError('Server stdin not writable', this.config.name)
    }
    this.process.stdin.write(message + '\n')
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  /**
   * 2026-04-11 Hazard 14 fix.
   *
   * Previously close() called kill('SIGTERM'), scheduled a 5-second
   * SIGKILL fallback, and returned immediately. The manager's
   * removeServer awaited close() and thought it was done while the
   * child was actually still alive. The next addServer with the same
   * name could spawn a SECOND child while the first was still being
   * killed.
   *
   * Now close() awaits the actual exit event (or the SIGKILL timeout
   * fallback) before resolving. The promise is never rejected — even
   * a child that refuses to die just times out and we move on.
   */
  async close(): Promise<void> {
    this._isOpen = false

    if (this.readline) {
      this.readline.close()
      this.readline = null
    }

    const proc = this.process
    if (!proc) return
    this.process = null

    // If the child has already exited, kill() throws — that's fine.
    await new Promise<void>((resolve) => {
      let resolved = false
      const done = () => {
        if (resolved) return
        resolved = true
        clearTimeout(forceTimer)
        resolve()
      }

      const forceTimer = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
        // Give the OS one more tick to actually reap, then resolve.
        setTimeout(done, 200)
      }, 5000)

      proc.once('exit', done)
      proc.once('close', done)

      try {
        // exitCode === null means still running; non-null means already
        // exited and 'exit' won't fire again.
        if (proc.exitCode != null || proc.signalCode != null) {
          done()
        } else {
          proc.kill('SIGTERM')
        }
      } catch {
        done()
      }
    })
  }
}

// ---------------------------------------------------------------------------
// SSE Transport
// ---------------------------------------------------------------------------

/**
 * SSE transport follows the MCP SSE protocol:
 * 1. GET to the SSE endpoint to establish event stream
 * 2. Server sends an `endpoint` event with the POST URL for requests
 * 3. Client POSTs JSON-RPC requests to that endpoint
 * 4. Server sends responses via the SSE stream
 */
export class SSETransport implements MCPTransportLayer {
  private messageHandler: ((msg: string) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null
  private _isOpen = false
  private postEndpoint: string | null = null
  private abortController: AbortController | null = null

  constructor(private readonly config: MCPSSEServerConfig) {}

  get isOpen(): boolean {
    return this._isOpen
  }

  /** Connect to the SSE endpoint and wait for the endpoint event */
  async start(): Promise<void> {
    this.abortController = new AbortController()

    const endpointPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new MCPError('SSE endpoint discovery timed out', this.config.name))
      }, 30_000)

      this.connectSSE((event, data) => {
        if (event === 'endpoint') {
          clearTimeout(timeout)
          resolve(data)
        } else if (event === 'message') {
          this.messageHandler?.(data)
        }
      }).catch((err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    this.postEndpoint = await endpointPromise
    // Resolve relative endpoint URLs against the base
    if (this.postEndpoint && !this.postEndpoint.startsWith('http')) {
      const base = new URL(this.config.url)
      this.postEndpoint = new URL(this.postEndpoint, base).toString()
    }
    this._isOpen = true
  }

  private async connectSSE(
    onEvent: (event: string, data: string) => void,
  ): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...this.config.headers,
    }

    const response = await fetch(this.config.url, {
      headers,
      signal: this.abortController!.signal,
    })

    if (!response.ok) {
      throw new MCPError(
        `SSE connection failed: ${response.status} ${response.statusText}`,
        this.config.name,
      )
    }

    if (!response.body) {
      throw new MCPError('SSE response has no body', this.config.name)
    }

    // Parse SSE stream in background
    this.parseSSEStream(response.body, onEvent).catch((err) => {
      if (err.name !== 'AbortError') {
        this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async parseSSEStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: string, data: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder()
    const reader = body.getReader()
    let buffer = ''
    let currentEvent = 'message'
    let currentData = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()! // Keep incomplete line

        for (const line of lines) {
          if (line === '') {
            // Empty line = end of event
            if (currentData) {
              onEvent(currentEvent, currentData)
              currentEvent = 'message'
              currentData = ''
            }
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            currentData += (currentData ? '\n' : '') + line.slice(5).trim()
          }
          // Ignore comments (lines starting with ':') and other fields
        }
      }
    } finally {
      reader.releaseLock()
      this._isOpen = false
      this.closeHandler?.()
    }
  }

  send(message: string): void {
    if (!this.postEndpoint) {
      throw new MCPError('SSE endpoint not discovered yet', this.config.name)
    }

    // Fire-and-forget POST — responses come via SSE stream
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    }

    fetch(this.postEndpoint, {
      method: 'POST',
      headers,
      body: message,
      signal: this.abortController?.signal,
    }).catch((err) => {
      if (err.name !== 'AbortError') {
        this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  async close(): Promise<void> {
    this._isOpen = false
    this.abortController?.abort()
    this.abortController = null
    this.postEndpoint = null
  }
}

// ---------------------------------------------------------------------------
// HTTP Transport (StreamableHTTP)
// ---------------------------------------------------------------------------

/**
 * StreamableHTTP transport:
 * - Each JSON-RPC request is a POST to the server URL
 * - Server responds with JSON-RPC response in the body
 * - Supports streaming via SSE response format
 */
export class HTTPTransport implements MCPTransportLayer {
  private messageHandler: ((msg: string) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null
  private _isOpen = false
  private sessionId: string | null = null

  constructor(private readonly config: MCPHTTPServerConfig) {}

  get isOpen(): boolean {
    return this._isOpen
  }

  async start(): Promise<void> {
    this._isOpen = true
  }

  send(message: string): void {
    if (!this._isOpen) {
      throw new MCPError('HTTP transport is closed', this.config.name)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.config.headers,
    }

    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId
    }

    fetch(this.config.url, {
      method: 'POST',
      headers,
      body: message,
    }).then(async (response) => {
      if (!response.ok) {
        this.errorHandler?.(new MCPError(
          `HTTP ${response.status}: ${response.statusText}`,
          this.config.name,
        ))
        return
      }

      // Capture session ID from response
      const sid = response.headers.get('Mcp-Session-Id')
      if (sid) this.sessionId = sid

      const contentType = response.headers.get('Content-Type') ?? ''

      if (contentType.includes('text/event-stream') && response.body) {
        // StreamableHTTP: server returns SSE stream
        await this.parseStreamableResponse(response.body)
      } else {
        // Plain JSON response — skip empty bodies and bare `null`
        // (Paper returns `202 null` for notifications).
        const text = await response.text()
        if (text.trim() && text.trim() !== 'null') {
          this.messageHandler?.(text.trim())
        }
      }
    }).catch((err) => {
      this.errorHandler?.(err instanceof Error ? err : new Error(String(err)))
    })
  }

  private async parseStreamableResponse(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    const reader = body.getReader()
    let buffer = ''
    let currentData = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!

        for (const line of lines) {
          if (line === '' && currentData) {
            this.messageHandler?.(currentData)
            currentData = ''
          } else if (line.startsWith('data:')) {
            currentData += (currentData ? '\n' : '') + line.slice(5).trim()
          }
        }
      }
      // Flush any remaining data
      if (currentData) {
        this.messageHandler?.(currentData)
      }
    } finally {
      reader.releaseLock()
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  async close(): Promise<void> {
    this._isOpen = false
    this.sessionId = null
    this.closeHandler?.()
  }
}

// ---------------------------------------------------------------------------
// WebSocket Transport
// ---------------------------------------------------------------------------

export class WebSocketTransport implements MCPTransportLayer {
  private messageHandler: ((msg: string) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null
  private _isOpen = false
  private _ws: WebSocket | null = null

  constructor(private readonly config: MCPWebSocketServerConfig) {}

  get isOpen(): boolean {
    return this._isOpen
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new MCPError('WebSocket connection timed out', this.config.name))
      }, 30_000)

      try {
        // Audit Hazard 8 fix (2026-04-11): the previous code did
        // `new WebSocket(this.config.url)` and the user-supplied
        // headers were silently dropped, leading to opaque 401s on
        // any auth-protected WebSocket MCP server. The undici
        // WebSocket constructor in Node 22+ accepts a second-arg
        // options object with a `headers` field — pass it through.
        const headers = this.config.headers
        const hasHeaders = headers && Object.keys(headers).length > 0
        // The DOM WebSocket type doesn't declare options; the runtime
        // (undici / Node 22+) accepts them. Cast through unknown to
        // sidestep the lib.dom.d.ts mismatch without using `any`.
        const Ctor = WebSocket as unknown as new (
          url: string,
          options?: { headers?: Record<string, string> },
        ) => WebSocket
        this._ws = hasHeaders
          ? new Ctor(this.config.url, { headers: { ...headers } })
          : new Ctor(this.config.url)

        this._ws.onopen = () => {
          clearTimeout(timeout)
          this._isOpen = true
          resolve()
        }

        this._ws.onmessage = (event: MessageEvent) => {
          const data = typeof event.data === 'string' ? event.data : String(event.data)
          this.messageHandler?.(data)
        }

        this._ws.onerror = () => {
          clearTimeout(timeout)
          const err = new MCPError('WebSocket error', this.config.name)
          this.errorHandler?.(err)
          if (!this._isOpen) reject(err)
        }

        this._ws.onclose = () => {
          this._isOpen = false
          this.closeHandler?.()
        }
      } catch (err) {
        clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  send(message: string): void {
    if (!this._ws || !this._isOpen) {
      throw new MCPError('WebSocket not connected', this.config.name)
    }
    this._ws.send(message)
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  async close(): Promise<void> {
    this._isOpen = false
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate transport for a server config.
 * Returns the transport (not started — call .start() separately).
 */
export function createTransport(config: MCPServerConfig): MCPTransportLayer & { start(): Promise<void> } {
  switch (config.transport) {
    case 'stdio':
      return new StdioTransport(config)
    case 'sse':
      return new SSETransport(config)
    case 'http':
      return new HTTPTransport(config)
    case 'websocket':
      return new WebSocketTransport(config)
    default: {
      const exhaustive: never = config
      throw new MCPError(
        `Unsupported transport: ${(exhaustive as MCPServerConfig).transport}`,
        (exhaustive as MCPServerConfig).name,
      )
    }
  }
}
