import type { CodexInbound } from './app-server-client.js'
import {
  SUPPORTED_CODEX_VERSION_RANGE,
  type CodexDiagnostics,
} from './app-server-client.js'
import {
  CodexAccountService,
  type CodexAccountState,
  type CodexLoginPresentation,
  type CodexModelCatalog,
  type CodexQuotaState,
} from './account.js'

const DEFAULT_LOGIN_WAIT_MS = 20_000
const MAX_LOGIN_WAIT_MS = 25_000
const INBOUND_POLL_MS = 250

export interface CodexControlPlaneClient {
  request(method: string, params?: unknown): Promise<unknown>
  nextInbound(timeoutMs?: number): Promise<CodexInbound | undefined>
  respondError(id: string | number, code: number): Promise<void>
  diagnostics(): CodexDiagnostics
  close(): Promise<void>
}

export interface CodexRuntimeStatus {
  readonly runtime: {
    readonly id: 'openai-codex'
    readonly accessRoute: 'openai-chatgpt-managed'
    readonly support: 'experimental'
    readonly upstreamSupport: 'experimental_unsupported_for_production'
    readonly processState: CodexDiagnostics['state']
    readonly protocolVersion: string
    readonly supportedVersionRange: string
  }
  readonly account: CodexAccountState
  /** Login identity is deliberately omitted; this is inspectable state. */
  readonly login: {
    readonly phase: 'idle' | 'pending' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed'
    readonly reason?: 'provider_rejected'
  }
  readonly quota: CodexQuotaState
}

export interface CodexRuntimeControlPlane {
  /** In-process observation only; never starts Codex or performs an RPC. */
  cachedObservation(): {
    readonly status: CodexRuntimeStatus
    readonly catalog?: CodexModelCatalog
  } | null
  status(): Promise<CodexRuntimeStatus>
  startLogin(kind: 'browser' | 'device'): Promise<CodexLoginPresentation>
  waitForLogin(timeoutMs?: number): Promise<CodexRuntimeStatus>
  cancelLogin(): Promise<CodexRuntimeStatus>
  logout(): Promise<CodexRuntimeStatus>
  models(): Promise<CodexModelCatalog>
  close(): Promise<void>
}

export interface CodexRuntimeControlPlaneOptions {
  readonly startClient: () => Promise<CodexControlPlaneClient>
}

interface StartedControlPlane {
  readonly client: CodexControlPlaneClient
  readonly account: CodexAccountService
}

/**
 * Gateway-owned account control plane for the official Codex route.
 *
 * Codex remains the token custodian. This class consumes only app-server RPC
 * projections and notifications; it never reads or copies Codex auth files.
 * Exactly one inbound pump owns the client queue so account notifications and
 * unexpected server requests cannot race separate HTTP handlers.
 */
export class ManagedCodexRuntimeControlPlane implements CodexRuntimeControlPlane {
  private started: StartedControlPlane | undefined
  private starting: Promise<StartedControlPlane> | undefined
  private closed = false
  private pump: Promise<void> | undefined
  private loginRevision = 0
  private readonly loginWaiters = new Set<() => void>()

  constructor(private readonly options: CodexRuntimeControlPlaneOptions) {}

  cachedObservation(): {
    readonly status: CodexRuntimeStatus
    readonly catalog?: CodexModelCatalog
  } | null {
    const current = this.started
    if (current === undefined) return null
    const catalog = current.account.modelSnapshot()
    return {
      status: this.snapshot(current),
      ...(catalog === undefined ? {} : { catalog }),
    }
  }

  async status(): Promise<CodexRuntimeStatus> {
    const current = await this.ensureStarted()
    const account = await current.account.readAccount({ refreshToken: false })
    if (account.state === 'authenticated') {
      await current.account.readRateLimits()
    }
    return this.snapshot(current)
  }

  async startLogin(kind: 'browser' | 'device'): Promise<CodexLoginPresentation> {
    const current = await this.ensureStarted()
    const presentation = await current.account.startLogin(kind)
    this.signalLoginChange()
    return presentation
  }

  async waitForLogin(timeoutMs = DEFAULT_LOGIN_WAIT_MS): Promise<CodexRuntimeStatus> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_LOGIN_WAIT_MS) {
      throw new CodexControlPlaneInputError('invalid_wait')
    }
    const current = await this.ensureStarted()
    const initial = current.account.loginSnapshot()
    if (initial.phase === 'pending' || initial.phase === 'cancelling') {
      await this.waitForLoginRevision(this.loginRevision, timeoutMs)
    }
    const login = current.account.loginSnapshot()
    if (login.phase === 'succeeded') {
      const account = await current.account.readAccount({ refreshToken: true })
      if (account.state === 'authenticated') {
        await current.account.readRateLimits()
      }
    }
    return this.snapshot(current)
  }

  async cancelLogin(): Promise<CodexRuntimeStatus> {
    const current = await this.ensureStarted()
    await current.account.cancelLogin()
    this.signalLoginChange()
    return this.snapshot(current)
  }

  async logout(): Promise<CodexRuntimeStatus> {
    const current = await this.ensureStarted()
    await current.account.logout()
    return this.snapshot(current)
  }

  async models(): Promise<CodexModelCatalog> {
    const current = await this.ensureStarted()
    await current.account.authorizeTurnAttempt()
    return current.account.listModels()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.signalLoginChange()
    const pending = this.starting
    const started = this.started ?? (pending === undefined
      ? undefined
      : await pending.catch(() => undefined))
    if (started !== undefined) await started.client.close()
    await this.pump?.catch(() => undefined)
  }

  private async ensureStarted(): Promise<StartedControlPlane> {
    if (this.closed) throw new CodexControlPlaneInputError('closed')
    if (this.started !== undefined) return this.started
    this.starting ??= (async () => {
      const client = await this.options.startClient()
      if (this.closed) {
        await client.close()
        throw new CodexControlPlaneInputError('closed')
      }
      const started = {
        client,
        account: new CodexAccountService(client),
      }
      this.started = started
      this.pump = this.pumpInbound(started)
      return started
    })()
    try {
      return await this.starting
    } catch (error) {
      this.starting = undefined
      throw error
    }
  }

  private async pumpInbound(started: StartedControlPlane): Promise<void> {
    while (!this.closed && this.started === started) {
      let inbound: CodexInbound | undefined
      try {
        inbound = await started.client.nextInbound(INBOUND_POLL_MS)
      } catch {
        this.signalLoginChange()
        return
      }
      if (inbound === undefined) {
        const state = started.client.diagnostics().state
        if (state === 'closed' || state === 'failed') {
          this.signalLoginChange()
          return
        }
        continue
      }
      if (inbound.kind === 'server_request') {
        try {
          await started.client.respondError(inbound.message.id, -32601)
        } catch {
          this.signalLoginChange()
          return
        }
        continue
      }
      const observed = started.account.observeNotification(inbound.message)
      if (observed.handled) this.signalLoginChange()
    }
  }

  private snapshot(started: StartedControlPlane): CodexRuntimeStatus {
    const login = started.account.loginSnapshot()
    const publicLogin = login.phase === 'failed'
      ? { phase: login.phase, reason: login.reason }
      : { phase: login.phase }
    const account = started.account.accountSnapshot()
    const quota = account.state === 'authenticated'
      ? started.account.quotaSnapshot()
      : {
          state: 'unknown' as const,
          reason: 'not_read' as const,
          validUntil: null,
        }
    const diagnostics = started.client.diagnostics()
    return {
      runtime: {
        id: 'openai-codex',
        accessRoute: 'openai-chatgpt-managed',
        support: 'experimental',
        upstreamSupport: 'experimental_unsupported_for_production',
        processState: diagnostics.state,
        protocolVersion: diagnostics.version,
        supportedVersionRange: SUPPORTED_CODEX_VERSION_RANGE,
      },
      account,
      login: publicLogin,
      quota,
    }
  }

  private waitForLoginRevision(revision: number, timeoutMs: number): Promise<void> {
    if (this.loginRevision !== revision || timeoutMs === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        this.loginWaiters.delete(finish)
        resolve()
      }
      this.loginWaiters.add(finish)
      timer = setTimeout(finish, timeoutMs)
    })
  }

  private signalLoginChange(): void {
    this.loginRevision += 1
    for (const resolve of [...this.loginWaiters]) resolve()
  }
}

export type CodexControlPlaneInputErrorCode = 'invalid_wait' | 'closed'

export class CodexControlPlaneInputError extends Error {
  public override readonly name = 'CodexControlPlaneInputError'

  constructor(readonly code: CodexControlPlaneInputErrorCode) {
    super(`Codex control plane rejected input (${code}).`)
  }
}
