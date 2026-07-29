import { execFile, spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'

export const SUPPORTED_CODEX_VERSION_RANGE = '>=0.145.0 <0.146.0'

const MAX_STDOUT_LINE_BYTES = 1024 * 1024
const MAX_INBOX_ITEMS = 1_024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

export interface ParsedCodexVersion {
  readonly raw: string
  readonly major: number
  readonly minor: number
  readonly patch: number
}

export function parseCodexVersion(output: string): ParsedCodexVersion | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(output.trim())
  if (match == null) return null
  const [, major, minor, patch] = match
  return {
    raw: `${major}.${minor}.${patch}`,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  }
}

function isSupportedVersion(version: ParsedCodexVersion): boolean {
  return version.major === 0 && version.minor === 145
}

type CodexFailureCode =
  | 'binary_not_found'
  | 'version_probe_failed'
  | 'incompatible_version'
  | 'spawn_failed'
  | 'request_timeout'
  | 'write_failed'
  | 'malformed_message'
  | 'message_too_large'
  | 'invalid_message'
  | 'unknown_response_id'
  | 'inbox_overflow'
  | 'process_exited'
  | 'client_closed'
  | 'shutdown_timeout'
  | 'configuration_isolation_failed'

export class CodexProcessError extends Error {
  public override readonly name = 'CodexProcessError'

  constructor(
    readonly code: CodexFailureCode,
    readonly exitCode?: number | null,
    readonly signal?: NodeJS.Signals | null,
  ) {
    super(`Codex app-server failed (${code}).`)
  }
}

export class CodexAppServerError extends Error {
  public override readonly name = 'CodexAppServerError'

  constructor(
    readonly method: string,
    readonly rpcCode: number,
  ) {
    super(`Codex app-server rejected "${method}" (${rpcCode}).`)
  }
}

export interface CodexChildProcess {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly pid?: number
  readonly exitCode: number | null
  on(event: string, listener: (...args: any[]) => void): this
  once(event: string, listener: (...args: any[]) => void): this
  removeListener(event: string, listener: (...args: any[]) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export interface CodexSpawnOptions {
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
  readonly stdio: readonly ['pipe', 'pipe', 'pipe']
}

export type CodexSpawnProcess = (
  binary: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChildProcess

export interface CodexNotification {
  readonly method: string
  readonly params: unknown
}

export interface CodexServerRequest extends CodexNotification {
  readonly id: string | number
}

export type CodexInbound =
  | {
      readonly kind: 'notification'
      readonly message: CodexNotification
    }
  | {
      readonly kind: 'server_request'
      readonly message: CodexServerRequest
    }

export interface CodexDiagnostics {
  readonly state: 'starting' | 'running' | 'closing' | 'closed' | 'failed'
  readonly version: string
  readonly pid: number | null
  readonly stderrBytes: number
  readonly failureCode: CodexFailureCode | null
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

interface PendingRequest {
  readonly method: string
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface InboxWaiter<T> {
  readonly resolve: (value: T | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly matches: (value: T) => boolean
}

class BoundedInbox<T> {
  private readonly values: T[] = []
  private readonly waiters: InboxWaiter<T>[] = []

  constructor(
    private readonly capacity: number,
    private readonly overflow: () => void,
  ) {}

  push(value: T): void {
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.matches(value))
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0]!
      clearTimeout(waiter.timer)
      waiter.resolve(value)
      return
    }
    if (this.values.length >= this.capacity) {
      this.overflow()
      return
    }
    this.values.push(value)
  }

  next(timeoutMs: number): Promise<T | undefined> {
    return this.nextMatching(() => true, timeoutMs)
  }

  nextMatching(
    matches: (value: T) => boolean,
    timeoutMs: number,
  ): Promise<T | undefined> {
    const valueIndex = this.values.findIndex(matches)
    if (valueIndex >= 0) {
      const [value] = this.values.splice(valueIndex, 1)
      return Promise.resolve(value)
    }

    return new Promise((resolveValue) => {
      const waiter: InboxWaiter<T> = {
        resolve: resolveValue,
        matches,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          resolveValue(undefined)
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }
}

export interface CodexAppServerStartOptions {
  readonly codexHome: string
  readonly clientVersion: string
  readonly codexBinary?: string
  readonly cwd?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly requestTimeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly inboxCapacity?: number
  readonly probeVersion?: (binary: string) => Promise<string>
  readonly spawnProcess?: CodexSpawnProcess
}

interface InitializeResponse {
  readonly userAgent: string
  readonly codexHome: string
  readonly platformFamily: string
  readonly platformOs: string
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['userAgent'] === 'string' &&
    typeof record['codexHome'] === 'string' &&
    typeof record['platformFamily'] === 'string' &&
    typeof record['platformOs'] === 'string'
  )
}

function defaultSpawnProcess(
  binary: string,
  args: readonly string[],
  options: CodexSpawnOptions,
): CodexChildProcess {
  return spawn(binary, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [...options.stdio],
  })
}

export function probeCodexVersion(binary: string): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      binary,
      ['--version'],
      {
        encoding: 'utf8',
        maxBuffer: 16 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error != null) {
          const code = (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'binary_not_found'
            : 'version_probe_failed'
          rejectOutput(new CodexProcessError(code))
          return
        }
        resolveOutput(stdout)
      },
    )
  })
}

/**
 * Version-pinned JSONL client for the official Codex app-server.
 *
 * Stdout is protocol-only. Stderr content is deliberately never retained:
 * diagnostics expose a byte count, process status, and stable failure code,
 * but cannot echo a token, account identity, prompt, or tool result.
 */
export class CodexAppServerClient {
  private nextId = 1
  private state: CodexDiagnostics['state'] = 'starting'
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBytes = 0
  private failureCode: CodexFailureCode | null = null
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly inbound: BoundedInbox<CodexInbound>
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly child: CodexChildProcess,
    private readonly version: ParsedCodexVersion,
    private readonly requestTimeoutMs: number,
    private readonly closeTimeoutMs: number,
    inboxCapacity: number,
  ) {
    const overflow = () => this.fail(new CodexProcessError('inbox_overflow'))
    this.inbound = new BoundedInbox(inboxCapacity, overflow)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.acceptStdout(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBytes += Buffer.byteLength(chunk)
    })
    child.on('error', () => {
      this.fail(new CodexProcessError('spawn_failed'))
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitCode = code
      this.exitSignal = signal
      if (this.state !== 'closing' && this.state !== 'closed' && this.state !== 'failed') {
        this.fail(new CodexProcessError('process_exited', code, signal), false)
      }
    })
  }

  static async start(options: CodexAppServerStartOptions): Promise<CodexAppServerClient> {
    if (!isAbsolute(options.codexHome)) {
      throw new CodexProcessError('configuration_isolation_failed')
    }
    const requestedCodexHome = resolve(options.codexHome)
    await mkdir(requestedCodexHome, { recursive: true, mode: 0o700 })
    // macOS exposes /var and /tmp through /private symlinks. The app-server
    // reports its canonical filesystem path, so isolation proof must compare
    // identities rather than lexical aliases.
    const codexHome = await realpath(requestedCodexHome)

    const binary = options.codexBinary ?? 'codex'
    const versionOutput = await (options.probeVersion ?? probeCodexVersion)(binary)
    const version = parseCodexVersion(versionOutput)
    if (version == null || !isSupportedVersion(version)) {
      throw new CodexProcessError('incompatible_version')
    }

    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess
    let child: CodexChildProcess
    try {
      child = spawnProcess(binary, ['app-server', '--strict-config'], {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          CODEX_HOME: codexHome,
          RUST_LOG: options.env?.['RUST_LOG'] ?? 'warn',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      throw new CodexProcessError('spawn_failed')
    }

    const client = new CodexAppServerClient(
      child,
      version,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      options.inboxCapacity ?? MAX_INBOX_ITEMS,
    )

    try {
      const result = await client.request('initialize', {
        clientInfo: {
          name: 'ownware',
          title: 'Ownware',
          version: options.clientVersion,
        },
        capabilities: {},
      })
      let reportedCodexHome: string | null = null
      if (isInitializeResponse(result) && isAbsolute(result.codexHome)) {
        try {
          reportedCodexHome = await realpath(result.codexHome)
        } catch {
          // A reported home that does not exist cannot prove isolation.
        }
      }
      if (reportedCodexHome !== codexHome) {
        throw new CodexProcessError('configuration_isolation_failed')
      }
      await client.notify('initialized', {})
      client.state = 'running'
      return client
    } catch (error) {
      try {
        await client.close()
      } catch {
        // Preserve the startup authority; teardown failure remains observable
        // through diagnostics but must not replace the initiating error.
      }
      throw error
    }
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.state === 'failed' || this.state === 'closing' || this.state === 'closed') {
      return Promise.reject(new CodexProcessError(this.failureCode ?? 'process_exited'))
    }
    const id = this.nextId++

    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(this.idKey(id))
        if (pending == null) return
        this.pending.delete(this.idKey(id))
        const error = new CodexProcessError('request_timeout')
        rejectRequest(error)
        this.fail(error)
      }, this.requestTimeoutMs)

      this.pending.set(this.idKey(id), {
        method,
        timer,
        resolve: resolveRequest,
        reject: rejectRequest,
      })

      try {
        this.send({ id, method, params })
      } catch {
        clearTimeout(timer)
        this.pending.delete(this.idKey(id))
        const error = new CodexProcessError('write_failed')
        rejectRequest(error)
        this.fail(error)
      }
    })
  }

  notify(method: string, params: unknown = {}): Promise<void> {
    try {
      this.send({ method, params })
      return Promise.resolve()
    } catch {
      const error = new CodexProcessError('write_failed')
      this.fail(error)
      return Promise.reject(error)
    }
  }

  respond(id: string | number, result: unknown): Promise<void> {
    try {
      this.send({ id, result })
      return Promise.resolve()
    } catch {
      const error = new CodexProcessError('write_failed')
      this.fail(error)
      return Promise.reject(error)
    }
  }

  respondError(id: string | number, code: number): Promise<void> {
    try {
      this.send({
        id,
        error: {
          code,
          message: 'Request is not supported by this Ownware runtime.',
        },
      })
      return Promise.resolve()
    } catch {
      const error = new CodexProcessError('write_failed')
      this.fail(error)
      return Promise.reject(error)
    }
  }

  nextNotification(timeoutMs = 0): Promise<CodexNotification | undefined> {
    return this.inbound
      .nextMatching((value) => value.kind === 'notification', timeoutMs)
      .then((value) => value?.message)
  }

  nextServerRequest(timeoutMs = 0): Promise<CodexServerRequest | undefined> {
    return this.inbound
      .nextMatching((value) => value.kind === 'server_request', timeoutMs)
      .then((value) => value?.message as CodexServerRequest | undefined)
  }

  /**
   * Consume the app-server's original inbound order.
   *
   * Runtime drivers must observe approvals and lifecycle notifications in
   * wire order. Keeping one bounded queue also prevents an unused secondary
   * queue from overflowing while the driver consumes the other view.
   */
  nextInbound(timeoutMs = 0): Promise<CodexInbound | undefined> {
    return this.inbound.next(timeoutMs)
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId })
  }

  diagnostics(): CodexDiagnostics {
    return {
      state: this.state,
      version: this.version.raw,
      pid: this.child.pid ?? null,
      stderrBytes: this.stderrBytes,
      failureCode: this.failureCode,
      exitCode: this.exitCode,
      signal: this.exitSignal,
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeProcess()
    return this.closePromise
  }

  private async closeProcess(): Promise<void> {
    if (this.state === 'closed') return
    if (this.state !== 'failed') this.state = 'closing'
    this.rejectPending(new CodexProcessError('client_closed'))

    try {
      this.child.stdin?.end()
    } catch {
      // The escalation below remains authoritative.
    }

    if (!(await this.waitForExit(this.closeTimeoutMs))) {
      this.child.kill('SIGTERM')
      if (!(await this.waitForExit(this.closeTimeoutMs))) {
        this.child.kill('SIGKILL')
        if (!(await this.waitForExit(this.closeTimeoutMs))) {
          const error = new CodexProcessError('shutdown_timeout')
          this.state = 'failed'
          this.failureCode = error.code
          throw error
        }
      }
    }

    if (this.state !== 'failed') this.state = 'closed'
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.exitSignal !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolveExit) => {
      const onExit = () => {
        clearTimeout(timer)
        resolveExit(true)
      }
      const timer = setTimeout(() => {
        this.child.removeListener('exit', onExit)
        resolveExit(false)
      }, timeoutMs)
      this.child.once('exit', onExit)
    })
  }

  private send(message: unknown): void {
    if (this.child.stdin == null || this.child.stdin.destroyed) {
      throw new CodexProcessError('write_failed')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private acceptStdout(chunk: Buffer): void {
    if (
      this.state === 'failed' ||
      this.state === 'closing' ||
      this.state === 'closed'
    ) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_BYTES && !this.stdoutBuffer.includes(10)) {
      this.fail(new CodexProcessError('message_too_large'))
      return
    }

    let newline = this.stdoutBuffer.indexOf(10)
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (line.length > MAX_STDOUT_LINE_BYTES) {
        this.fail(new CodexProcessError('message_too_large'))
        return
      }
      if (line.length > 0) this.acceptLine(line)
      if (this.failureCode !== null) return
      newline = this.stdoutBuffer.indexOf(10)
    }
  }

  private acceptLine(line: Buffer): void {
    let message: unknown
    try {
      message = JSON.parse(line.toString('utf8'))
    } catch {
      this.fail(new CodexProcessError('malformed_message'))
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      this.fail(new CodexProcessError('invalid_message'))
      return
    }

    const record = message as Record<string, unknown>
    if (record['jsonrpc'] !== undefined && record['jsonrpc'] !== '2.0') {
      this.fail(new CodexProcessError('invalid_message'))
      return
    }
    const id = record['id']
    const method = record['method']
    const hasId = typeof id === 'number' || typeof id === 'string'
    const hasMethod = typeof method === 'string' && method.length > 0
    const hasResult = Object.hasOwn(record, 'result')
    const hasError = Object.hasOwn(record, 'error')

    if (hasId && !hasMethod && hasResult !== hasError) {
      const pending = this.pending.get(this.idKey(id))
      if (pending == null) {
        this.fail(new CodexProcessError('unknown_response_id'))
        return
      }
      this.pending.delete(this.idKey(id))
      clearTimeout(pending.timer)
      if (hasError) {
        const error = record['error']
        const rpcCode = (
          typeof error === 'object' &&
          error !== null &&
          typeof (error as Record<string, unknown>)['code'] === 'number'
        )
          ? (error as { code: number }).code
          : -1
        pending.reject(new CodexAppServerError(pending.method, rpcCode))
      } else {
        pending.resolve(record['result'])
      }
      return
    }

    if (hasId && hasMethod && !hasResult && !hasError) {
      this.inbound.push({
        kind: 'server_request',
        message: {
          id,
          method,
          params: record['params'] ?? {},
        },
      })
      return
    }

    if (!hasId && hasMethod && !hasResult && !hasError) {
      this.inbound.push({
        kind: 'notification',
        message: {
          method,
          params: record['params'] ?? {},
        },
      })
      return
    }

    this.fail(new CodexProcessError('invalid_message'))
  }

  private idKey(id: string | number): string {
    return `${typeof id}:${id}`
  }

  private fail(error: CodexProcessError, terminate = true): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.state = 'failed'
    this.failureCode = error.code
    this.rejectPending(error)
    if (terminate && this.child.exitCode === null) {
      this.child.kill('SIGTERM')
    }
  }

  private rejectPending(error: CodexProcessError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
