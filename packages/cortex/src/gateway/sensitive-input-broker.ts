/**
 * Run-bound, in-memory sensitive-input authority.
 *
 * A trusted host registers adapters against the exact final Tool object. Tool
 * names, profile declarations and adapter-private intent are never authority.
 * Values enter through one dedicated HTTP handler, live only in this broker,
 * and cross the captured adapter after a one-use handle is consumed.
 */

import { randomUUID } from 'node:crypto'
import {
  unsafeCreateSensitiveInputHandle,
  type OpaqueSensitiveInputHandle,
  type SensitiveInputBinding,
  type SensitiveInputProvision,
  type SensitiveInputRequest,
  type SensitiveInputRequestStart,
  type SensitiveInputResolution,
  type Tool,
} from '@ownware/loom'
import { SENSITIVE_INPUT_MAX_BYTES } from './types.js'

const DEFAULT_REQUEST_TTL_MS = 5 * 60 * 1000
const DEFAULT_HANDLE_TTL_MS = 30 * 1000
const MAX_LABEL_CHARS = 160
const MAX_USAGE_CHARS = 500
const MAX_ID_CHARS = 240
const MAX_TOOL_NAME_CHARS = 160
const MAX_CONTRACT_REVISION_CHARS = 200

export type SensitiveInputFailureCode =
  | 'sensitive_input_run_inactive'
  | 'sensitive_input_request_duplicate'
  | 'sensitive_input_request_unknown'
  | 'sensitive_input_request_expired'
  | 'sensitive_input_value_invalid'
  | 'sensitive_input_handle_unknown'
  | 'sensitive_input_handle_collision'
  | 'sensitive_input_adapter_unsupported'

export class SensitiveInputBrokerError extends Error {
  constructor(
    readonly code: SensitiveInputFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'SensitiveInputBrokerError'
  }
}

export interface PendingSensitiveInputRequest {
  readonly requestId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly agentId: string | null
  readonly label: string
  readonly usage: string
  readonly adapterRevision: string
  readonly createdAt: number
  readonly expiresAt: number
}

export type SensitiveInputAdapterInjection =
  | { readonly disposition: 'applied' }
  | {
      readonly disposition: 'not-applied'
      readonly reason: Extract<
        SensitiveInputResolution,
        { readonly status: 'failed' }
      >['reason']
    }
  | { readonly disposition: 'indeterminate' }

export interface SensitiveInputPrepareContext {
  readonly runId: string
  readonly toolCallId: string
  readonly agentId: string | null
}

/**
 * Trusted host adapter. `prepare` must synchronously validate, clone and freeze
 * adapter-private intent. `inject` observes the real effect boundary and must
 * return indeterminate whenever it cannot prove whether application occurred.
 */
export interface SensitiveInputAdapter<TPrepared> {
  readonly contractRevision: string
  prepare(
    binding: SensitiveInputBinding,
    context: SensitiveInputPrepareContext,
  ): TPrepared
  inject(target: TPrepared, value: string): Promise<SensitiveInputAdapterInjection>
}

interface ErasedSensitiveInputAdapter {
  readonly contractRevision: string
  prepare(
    binding: SensitiveInputBinding,
    context: SensitiveInputPrepareContext,
  ): unknown
  inject(target: unknown, value: string): Promise<SensitiveInputAdapterInjection>
}

interface PendingEntry {
  readonly request: PendingSensitiveInputRequest
  readonly adapter: ErasedSensitiveInputAdapter
  readonly target: unknown
  readonly resolve: (provision: SensitiveInputProvision) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface HandleEntry {
  readonly request: PendingSensitiveInputRequest
  readonly adapter: ErasedSensitiveInputAdapter
  readonly target: unknown
  readonly value: string
  readonly expiresAt: number
}

export interface SensitiveInputBrokerOptions {
  readonly now?: () => number
  readonly issueToken?: () => string
  readonly requestTtlMs?: number
  readonly handleTtlMs?: number
  readonly maxValueBytes?: number
}

export class SensitiveInputBroker {
  private activeRunId: string | null = null
  private readonly adapters = new WeakMap<Tool, ErasedSensitiveInputAdapter>()
  private readonly pending = new Map<string, PendingEntry>()
  private readonly handles = new Map<string, HandleEntry>()
  private readonly usedRequestIds = new Set<string>()
  // Never reuse a token for this broker, even after consumption or across
  // runs. Otherwise a replayed old handle could address a later value if a
  // faulty/custom issuer repeated a token.
  private readonly issuedHandleTokens = new Set<string>()
  private readonly activeRedactionValues = new Set<string>()
  private readonly now: () => number
  private readonly issueToken: () => string
  private readonly requestTtlMs: number
  private readonly handleTtlMs: number
  private readonly maxValueBytes: number

  constructor(options: SensitiveInputBrokerOptions = {}) {
    this.now = options.now ?? Date.now
    this.issueToken = options.issueToken ?? randomUUID
    this.requestTtlMs = positiveIntegerOption(
      options.requestTtlMs,
      DEFAULT_REQUEST_TTL_MS,
      'requestTtlMs',
    )
    this.handleTtlMs = positiveIntegerOption(
      options.handleTtlMs,
      DEFAULT_HANDLE_TTL_MS,
      'handleTtlMs',
    )
    this.maxValueBytes = positiveIntegerOption(
      options.maxValueBytes,
      SENSITIVE_INPUT_MAX_BYTES,
      'maxValueBytes',
    )
  }

  /** Register trusted adapter authority before a run begins. */
  register<TPrepared>(tool: Tool, adapter: SensitiveInputAdapter<TPrepared>): void {
    if (this.activeRunId !== null || this.pending.size > 0 || this.handles.size > 0) {
      throw new Error('Sensitive-input adapters cannot change during an active run.')
    }
    validateContractRevision(adapter.contractRevision)
    if (this.adapters.has(tool)) {
      throw new Error('Sensitive-input adapter is already registered for this tool object.')
    }
    this.adapters.set(tool, {
      contractRevision: adapter.contractRevision,
      prepare: (binding, context) => adapter.prepare(binding, context),
      inject: (target, value) => adapter.inject(target as TPrepared, value),
    })
  }

  isRegistered(tool: Tool): boolean {
    return this.adapters.has(tool)
  }

  /** Install the exact active run. Starting another run revokes stale state. */
  beginRun(runId: string): void {
    if (runId.length === 0 || runId.length > MAX_ID_CHARS) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_run_inactive',
        'A bounded non-empty run identity is required.',
      )
    }
    if (this.activeRunId !== runId) this.clearEphemeralState('revoked')
    this.activeRunId = runId
  }

  /** Revoke every pending/issued value for one terminal run. */
  endRun(runId: string): void {
    if (this.activeRunId !== runId) return
    this.clearEphemeralState('revoked')
    this.activeRunId = null
  }

  /**
   * Register one request synchronously, then return its pending provision.
   * This ordering lets Loom publish the request event only after the public
   * response endpoint can already resolve it.
   */
  request(input: {
    readonly requestId: string
    readonly toolCallId: string
    readonly toolName: string
    readonly agentId: string | null
    readonly tool: Tool
    readonly request: SensitiveInputRequest
  }): SensitiveInputRequestStart {
    const runId = this.activeRunId
    if (runId === null) return { status: 'unavailable' }
    if (this.usedRequestIds.has(input.requestId)) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_request_duplicate',
        'Sensitive-input request identity was already used in this run.',
      )
    }
    const adapter = this.adapters.get(input.tool)
    if (adapter === undefined) return { status: 'unavailable' }

    const now = this.now()
    const request = validateRequest({
      requestId: input.requestId,
      runId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      agentId: input.agentId,
      label: input.request.label,
      usage: input.request.usage,
      adapterRevision: adapter.contractRevision,
      createdAt: now,
      expiresAt: now + this.requestTtlMs,
    })
    let target: unknown
    try {
      target = adapter.prepare(input.request.binding, {
        runId,
        toolCallId: input.toolCallId,
        agentId: input.agentId,
      })
    } catch {
      return { status: 'unavailable' }
    }

    this.usedRequestIds.add(request.requestId)
    const provision = new Promise<SensitiveInputProvision>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(request.requestId)
        if (entry === undefined) return
        this.pending.delete(request.requestId)
        entry.resolve({ status: 'expired' })
      }, this.requestTtlMs)
      timer.unref?.()
      this.pending.set(request.requestId, {
        request,
        adapter,
        target,
        resolve,
        timer,
      })
    })
    return {
      status: 'pending',
      adapterRevision: adapter.contractRevision,
      provision,
    }
  }

  /** Accept a value for one exact active-run request without echoing it. */
  respond(
    runId: string,
    requestId: string,
    value: string,
  ): PendingSensitiveInputRequest {
    const entry = this.exactPending(runId, requestId)
    const now = this.now()
    if (now >= entry.request.expiresAt) {
      clearTimeout(entry.timer)
      this.pending.delete(requestId)
      entry.resolve({ status: 'expired' })
      throw new SensitiveInputBrokerError(
        'sensitive_input_request_expired',
        'The sensitive-input request has expired.',
      )
    }
    if (value.length === 0 || Buffer.byteLength(value, 'utf8') > this.maxValueBytes) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_value_invalid',
        'Sensitive input must be non-empty and within the supported size limit.',
      )
    }

    const token = this.issueToken()
    if (
      typeof token !== 'string'
      || token.length === 0
      || this.issuedHandleTokens.has(token)
    ) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_handle_collision',
        'A unique sensitive-input handle could not be issued.',
      )
    }
    const handle = unsafeCreateSensitiveInputHandle(token)
    this.issuedHandleTokens.add(token)

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    this.activeRedactionValues.add(value)
    this.handles.set(handle.token, {
      request: entry.request,
      adapter: entry.adapter,
      target: entry.target,
      value,
      expiresAt: now + this.handleTtlMs,
    })
    entry.resolve({ status: 'provided', handle })
    return entry.request
  }

  deny(runId: string, requestId: string): boolean {
    const entry = this.pending.get(requestId)
    if (entry === undefined || entry.request.runId !== runId || this.activeRunId !== runId) {
      return false
    }
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve({ status: 'denied' })
    return true
  }

  /** Consume before injection; adapter errors after entry are indeterminate. */
  async consume(handle: OpaqueSensitiveInputHandle): Promise<SensitiveInputResolution> {
    const entry = this.handles.get(handle.token)
    if (entry === undefined) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_handle_unknown',
        'Sensitive-input handle is unknown or already consumed.',
      )
    }
    this.handles.delete(handle.token)
    if (this.now() >= entry.expiresAt) {
      return { status: 'failed', reason: 'expired' }
    }
    if (this.activeRunId !== entry.request.runId) {
      return { status: 'failed', reason: 'revoked' }
    }

    let outcome: SensitiveInputAdapterInjection
    try {
      outcome = await entry.adapter.inject(entry.target, entry.value)
    } catch {
      return { status: 'indeterminate' }
    }
    switch (outcome.disposition) {
      case 'applied': return { status: 'injected' }
      case 'not-applied': return { status: 'failed', reason: outcome.reason }
      case 'indeterminate': return { status: 'indeterminate' }
    }
  }

  revoke(handle: OpaqueSensitiveInputHandle): boolean {
    return this.handles.delete(handle.token)
  }

  /** Exact-value replacement is defense in depth, never secret detection. */
  redact(text: string): string {
    let redacted = text
    for (const value of this.activeRedactionValues) {
      redacted = replaceAllLiteral(redacted, value, '[REDACTED:SENSITIVE_INPUT]')
      const jsonEscaped = JSON.stringify(value).slice(1, -1)
      if (jsonEscaped !== value) {
        redacted = replaceAllLiteral(
          redacted,
          jsonEscaped,
          '[REDACTED:SENSITIVE_INPUT]',
        )
      }
    }
    return redacted
  }

  getPending(runId: string, requestId: string): PendingSensitiveInputRequest | undefined {
    const request = this.pending.get(requestId)?.request
    return request?.runId === runId ? request : undefined
  }

  listPending(runId?: string): readonly PendingSensitiveInputRequest[] {
    return [...this.pending.values()]
      .map(entry => entry.request)
      .filter(request => runId === undefined || request.runId === runId)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get issuedHandleCount(): number {
    return this.handles.size
  }

  denyAll(): number {
    const count = this.pending.size
    this.clearEphemeralState('revoked')
    return count
  }

  dispose(): void {
    this.clearEphemeralState('revoked')
    this.activeRunId = null
  }

  private exactPending(runId: string, requestId: string): PendingEntry {
    const entry = this.pending.get(requestId)
    if (
      entry === undefined
      || entry.request.runId !== runId
      || this.activeRunId !== runId
    ) {
      throw new SensitiveInputBrokerError(
        'sensitive_input_request_unknown',
        'No matching sensitive-input request is pending for this active run.',
      )
    }
    return entry
  }

  private clearEphemeralState(status: 'revoked' | 'expired'): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ status })
    }
    this.pending.clear()
    this.handles.clear()
    this.usedRequestIds.clear()
    this.activeRedactionValues.clear()
  }
}

function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`)
  }
  return value
}

function validateContractRevision(value: string): void {
  if (value.length === 0 || value.length > MAX_CONTRACT_REVISION_CHARS) {
    throw new TypeError('Sensitive-input adapter revision is outside supported bounds.')
  }
}

function validateRequest(
  request: PendingSensitiveInputRequest,
): PendingSensitiveInputRequest {
  if (
    request.requestId.length === 0
    || request.requestId.length > MAX_ID_CHARS
    || request.toolCallId.length === 0
    || request.toolCallId.length > MAX_ID_CHARS
    || request.toolName.length === 0
    || request.toolName.length > MAX_TOOL_NAME_CHARS
    || request.label.length === 0
    || request.label.length > MAX_LABEL_CHARS
    || request.usage.length > MAX_USAGE_CHARS
  ) {
    throw new SensitiveInputBrokerError(
      'sensitive_input_value_invalid',
      'Sensitive-input request metadata is malformed or outside supported bounds.',
    )
  }
  return Object.freeze({ ...request })
}

function replaceAllLiteral(text: string, value: string, replacement: string): string {
  return value.length === 0 ? text : text.split(value).join(replacement)
}
