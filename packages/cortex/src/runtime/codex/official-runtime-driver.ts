import { createHash } from 'node:crypto'
import type { CheckPermissionResult, LoomEvent, ToolCall } from '@ownware/loom'
import type {
  CodexDiagnostics,
  CodexInbound,
  CodexServerRequest,
} from './app-server-client.js'
import type { CodexOfficialRunPlan } from './official-run-plan.js'
import type {
  CodexMcpInvocationReceipt,
  CodexMcpRunHandle,
} from './mcp-tool-bridge.js'
import {
  CodexNativeApprovalBridge,
  type CodexNativeApprovalReview,
} from './native-approval-bridge.js'
import {
  CodexOfficialTurnBridge,
  type CodexTurnObservation,
} from './official-turn.js'
import {
  assertCodexThreadResume,
  beginCodexThreadTurn,
  completeCodexThreadTurn,
  createCodexThreadReference,
  observeCodexThreadConsequence,
  type CodexThreadReference,
  type CodexThreadReferenceInput,
} from './official-thread.js'
import type {
  RuntimeCancelReason,
  RuntimeCompletion,
  RuntimeConsequence,
  RuntimeDriver,
  RuntimeDriverEvent,
  RuntimePermissionDecision,
  RuntimePermissionResult,
  RuntimeStartRequest,
} from '../port.js'

const OFFICIAL_SELECTION = {
  runtime: 'openai-codex',
  access: { route: 'openai-chatgpt-managed' },
} as const

export type CodexOfficialRuntimeDriverErrorCode =
  | 'request_plan_mismatch'
  | 'thread_response_invalid'
  | 'turn_response_invalid'
  | 'reference_persistence_failed'
  | 'driver_already_started'

export class CodexOfficialRuntimeDriverError extends Error {
  public override readonly name = 'CodexOfficialRuntimeDriverError'

  constructor(readonly code: CodexOfficialRuntimeDriverErrorCode) {
    super(`Codex official runtime failed (${code}).`)
  }
}

export interface CodexOfficialRuntimeClient {
  request(method: string, params: unknown): Promise<unknown>
  nextInbound(timeoutMs?: number): Promise<CodexInbound | undefined>
  respond(id: string | number, result: unknown): Promise<void>
  respondError(id: string | number, code: number): Promise<void>
  interrupt(threadId: string, turnId: string): Promise<void>
  diagnostics(): CodexDiagnostics
  close(): Promise<void>
}

type DriverMcpRun = Pick<
  CodexMcpRunHandle,
  'confirmAppServerDelivery' | 'isActive' | 'receipts' | 'close'
>

export interface CodexOfficialRuntimeDriverOptions {
  readonly client: CodexOfficialRuntimeClient
  readonly localThreadId: string
  readonly accountBinding: string
  readonly modelProvider: string
  readonly plan: CodexOfficialRunPlan
  readonly threadReference?: CodexThreadReference
  readonly mcpRun?: DriverMcpRun
  readonly reviewNativeApproval?: (
    review: CodexNativeApprovalReview,
  ) => Promise<'allow' | 'ask' | CheckPermissionResult>
  readonly persistReference: (
    reference: CodexThreadReference,
  ) => void | Promise<void>
  readonly now?: () => number
  readonly pollTimeoutMs?: number
}

interface TurnResponse {
  readonly id: string
  readonly startedAt: number | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeSourceType(value: string): string {
  return /^[A-Za-z0-9_.:/-]{1,160}$/.test(value)
    ? value
    : 'unrecognized'
}

function promptDigest(request: RuntimeStartRequest): string | null {
  if (typeof request.prompt !== 'string') return null
  return createHash('sha256')
    .update(JSON.stringify(request.prompt))
    .digest('hex')
}

function parseThreadResponse(
  value: unknown,
  plan: CodexOfficialRunPlan,
  modelProvider: string,
  expectedThreadId?: string,
): string {
  const response = asRecord(value)
  const thread = asRecord(response?.['thread'])
  const remoteThreadId = safeString(thread?.['id'])
  if (
    response == null
    || thread == null
    || remoteThreadId == null
    || (expectedThreadId !== undefined && remoteThreadId !== expectedThreadId)
    || response['cwd'] !== plan.threadStart.cwd
    || response['model'] !== plan.threadStart.model
    || response['modelProvider'] !== modelProvider
    || thread['cwd'] !== plan.threadStart.cwd
    || thread['modelProvider'] !== modelProvider
  ) {
    throw new CodexOfficialRuntimeDriverError('thread_response_invalid')
  }
  return remoteThreadId
}

function parseTurnResponse(value: unknown): TurnResponse {
  const response = asRecord(value)
  const turn = asRecord(response?.['turn'])
  const id = safeString(turn?.['id'])
  const startedAt = turn?.['startedAt']
  if (
    response == null
    || turn == null
    || id == null
    || turn['status'] !== 'inProgress'
    || !Array.isArray(turn['items'])
    || !(
      startedAt === null
      || (Number.isSafeInteger(startedAt) && (startedAt as number) >= 0)
    )
  ) {
    throw new CodexOfficialRuntimeDriverError('turn_response_invalid')
  }
  return {
    id,
    startedAt: startedAt as number | null,
  }
}

function ambiguousMcpOutcome(
  receipts: readonly CodexMcpInvocationReceipt[],
): boolean {
  return receipts.some((receipt) => (
    receipt.state === 'outcome_unknown'
    || (
      (
        receipt.consequence === 'effect_possible'
        || receipt.consequence === 'effect_confirmed'
      )
      && receipt.deliveryEvidence === 'unknown'
    )
  ))
}

/**
 * Official Codex app-server driver.
 *
 * The app-server owns the loop. This driver owns exact request binding,
 * safe local thread metadata, ordered event translation, permission
 * callbacks, cancellation semantics, and no-replay recovery state.
 */
export class CodexOfficialRuntimeDriver implements RuntimeDriver {
  readonly selection = OFFICIAL_SELECTION
  private readonly now: () => number
  private readonly pollTimeoutMs: number
  private reference: CodexThreadReference | undefined
  private remoteThreadId: string | undefined
  private remoteTurnId: string | undefined
  private turnBridge: CodexOfficialTurnBridge | undefined
  private approvalBridge: CodexNativeApprovalBridge | undefined
  private sequence = 0
  private started = false
  private closed = false
  private cancelReason: RuntimeCancelReason | undefined
  private readonly queued: RuntimeDriverEvent[] = []
  private readonly pendingApprovals = new Map<
    string,
    (approved: boolean) => void
  >()
  private readonly serverTasks = new Set<Promise<void>>()

  constructor(private readonly options: CodexOfficialRuntimeDriverOptions) {
    this.now = options.now ?? Date.now
    this.pollTimeoutMs = options.pollTimeoutMs ?? 250
    this.reference = options.threadReference
  }

  async *start(
    request: RuntimeStartRequest,
  ): AsyncGenerator<RuntimeDriverEvent, RuntimeCompletion> {
    if (this.started) {
      throw new CodexOfficialRuntimeDriverError('driver_already_started')
    }
    this.started = true
    if (promptDigest(request) !== this.options.plan.requestDigest) {
      throw new CodexOfficialRuntimeDriverError('request_plan_mismatch')
    }

    await this.openThread()
    const turnResponse = parseTurnResponse(await this.options.client.request(
      'turn/start',
      {
        threadId: this.remoteThreadId,
        ...this.options.plan.turnStart,
      },
    ))
    this.remoteTurnId = turnResponse.id
    this.reference = beginCodexThreadTurn(this.reference, {
      id: turnResponse.id,
      startedAt: new Date(
        turnResponse.startedAt == null
          ? this.now()
          : turnResponse.startedAt * 1_000,
      ).toISOString(),
    })
    await this.persist()

    this.turnBridge = new CodexOfficialTurnBridge({
      threadId: this.remoteThreadId!,
      turnId: turnResponse.id,
      turnIndex: 0,
      model: this.options.plan.threadStart.model,
      ...(this.options.mcpRun ? { mcpRun: this.options.mcpRun } : {}),
      now: this.now,
    })
    this.approvalBridge = new CodexNativeApprovalBridge({
      threadId: this.remoteThreadId!,
      review: this.options.reviewNativeApproval ?? (async () => 'ask'),
      requestApproval: (tool) => this.waitForApproval(tool),
      onEvent: (event) => this.enqueueCanonical(event),
      resolveFileChange: async ({ threadId, turnId, itemId }) => {
        if (
          threadId !== this.remoteThreadId
          || turnId !== this.remoteTurnId
        ) return null
        return this.turnBridge?.fileChangeContext(itemId) ?? null
      },
    })

    if (this.cancelReason !== undefined) {
      this.turnBridge.noteCancellation(this.cancelReason)
      await this.options.client.interrupt(
        this.remoteThreadId!,
        this.remoteTurnId,
      )
    }

    let completion: RuntimeCompletion | undefined
    while (true) {
      const queued = this.queued.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      if (completion !== undefined) return completion

      const inbound = await this.options.client.nextInbound(this.pollTimeoutMs)
      if (inbound === undefined) {
        if (this.queued.length > 0) continue
        const diagnostics = this.options.client.diagnostics()
        if (diagnostics.state === 'failed' || diagnostics.state === 'closed') {
          return {
            outcome: 'indeterminate',
            authority: diagnostics.failureCode === 'process_exited'
              ? 'codex_app_server_process_exited'
              : 'codex_app_server_unavailable',
          }
        }
        continue
      }

      if (inbound.kind === 'server_request') {
        this.handleServerRequest(inbound.message)
        continue
      }

      const observed = this.turnBridge.observe(inbound.message)
      await this.enqueueObservation(observed)
      if (observed.completion !== undefined && observed.terminal !== undefined) {
        const outcomeKnown = !ambiguousMcpOutcome(
          this.options.mcpRun?.receipts() ?? [],
        )
        this.reference = completeCodexThreadTurn(
          this.reference,
          observed.terminal,
          outcomeKnown,
        )
        await this.persist()
        completion = outcomeKnown
          ? observed.completion
          : {
              outcome: 'indeterminate',
              authority: 'ownware_tool_delivery_or_effect_unknown',
            }
      }
    }
  }

  async answerPermission(
    decision: RuntimePermissionDecision,
  ): Promise<RuntimePermissionResult> {
    const resolveApproval = this.pendingApprovals.get(decision.requestId)
    if (resolveApproval == null) return { status: 'stale' }
    this.pendingApprovals.delete(decision.requestId)
    resolveApproval(decision.decision === 'approve')
    return { status: 'delivered' }
  }

  async cancel(reason: RuntimeCancelReason): Promise<void> {
    this.cancelReason = reason
    this.turnBridge?.noteCancellation(reason)
    for (const resolveApproval of this.pendingApprovals.values()) {
      resolveApproval(false)
    }
    this.pendingApprovals.clear()
    if (this.remoteThreadId !== undefined && this.remoteTurnId !== undefined) {
      await this.options.client.interrupt(
        this.remoteThreadId,
        this.remoteTurnId,
      )
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const resolveApproval of this.pendingApprovals.values()) {
      resolveApproval(false)
    }
    this.pendingApprovals.clear()
    await Promise.all([...this.serverTasks])
    let firstError: unknown
    try {
      await this.options.client.close()
    } catch (error) {
      firstError = error
    }
    try {
      await this.options.mcpRun?.close()
    } catch (error) {
      firstError ??= error
    }
    if (firstError !== undefined) throw firstError
  }

  threadReference(): CodexThreadReference | undefined {
    return this.reference
  }

  private async openThread(): Promise<void> {
    const plan = this.options.plan
    if (this.reference === undefined) {
      const response = await this.options.client.request('thread/start', {
        ...plan.threadStart,
        config: { web_search: 'disabled' },
      })
      this.remoteThreadId = parseThreadResponse(
        response,
        plan,
        this.options.modelProvider,
      )
      this.reference = createCodexThreadReference({
        localThreadId: this.options.localThreadId,
        remoteThreadId: this.remoteThreadId,
        accountBinding: this.options.accountBinding,
        model: plan.threadStart.model,
        modelProvider: this.options.modelProvider,
        profileReportId: plan.profileReportId,
        sandboxReportId: plan.sandboxReportId,
        boundAt: new Date(this.now()).toISOString(),
      })
      await this.persist()
      return
    }

    const current: CodexThreadReferenceInput = {
      localThreadId: this.options.localThreadId,
      remoteThreadId: this.reference.remoteThreadId,
      accountBinding: this.options.accountBinding,
      model: plan.threadStart.model,
      modelProvider: this.options.modelProvider,
      profileReportId: plan.profileReportId,
      sandboxReportId: plan.sandboxReportId,
      boundAt: this.reference.boundAt,
    }
    const reference = assertCodexThreadResume(this.reference, current)
    const response = await this.options.client.request('thread/resume', {
      threadId: reference.remoteThreadId,
      ...plan.threadStart,
      config: { web_search: 'disabled' },
    })
    this.remoteThreadId = parseThreadResponse(
      response,
      plan,
      this.options.modelProvider,
      reference.remoteThreadId,
    )
  }

  private handleServerRequest(request: CodexServerRequest): void {
    const task = this.resolveServerRequest(request)
    this.serverTasks.add(task)
    void task.finally(() => this.serverTasks.delete(task))
  }

  private async resolveServerRequest(
    request: CodexServerRequest,
  ): Promise<void> {
    try {
      const handled = await this.approvalBridge!.handle(request)
      if (!handled.handled) {
        await this.options.client.respondError(request.id, -32601)
        await this.enqueueUnknown(`server_request:${request.method}`)
        return
      }
      await this.options.client.respond(request.id, handled.response)
    } catch {
      try {
        await this.options.client.respondError(request.id, -32603)
      } catch {
        // The stable unknown event below remains the customer-visible result.
      }
      await this.enqueueUnknown(`server_request_failed:${request.method}`)
    }
  }

  private waitForApproval(tool: ToolCall): Promise<boolean> {
    if (this.pendingApprovals.has(tool.id)) return Promise.resolve(false)
    return new Promise<boolean>((resolveApproval) => {
      this.pendingApprovals.set(tool.id, resolveApproval)
    })
  }

  private async enqueueObservation(
    observation: CodexTurnObservation,
  ): Promise<void> {
    if (observation.unknownSourceType !== undefined) {
      await this.enqueueUnknown(observation.unknownSourceType)
    }
    for (const item of observation.events) {
      await this.enqueueCanonical(item.event, item.consequence)
    }
  }

  private async enqueueCanonical(
    event: LoomEvent,
    consequence?: RuntimeConsequence,
  ): Promise<void> {
    const effective = consequence ?? this.inferConsequence(event)
    if (effective !== 'none_observed' && this.reference?.activeTurn != null) {
      const next = observeCodexThreadConsequence(this.reference, effective)
      if (next !== this.reference) {
        this.reference = next
        await this.persist()
      }
    }
    this.queued.push({
      kind: 'canonical',
      sourceSequence: ++this.sequence,
      event,
      ...(consequence !== undefined ? { consequence } : {}),
    })
  }

  private enqueueUnknown(sourceType: string): Promise<void> {
    this.queued.push({
      kind: 'unknown',
      sourceSequence: ++this.sequence,
      sourceType: safeSourceType(sourceType),
      observedAt: this.now(),
    })
    return Promise.resolve()
  }

  private inferConsequence(event: LoomEvent): RuntimeConsequence {
    if (
      event.type === 'text.delta'
      || event.type === 'text.complete'
      || event.type === 'thinking.delta'
      || event.type === 'thinking.complete'
    ) return 'output_observed'
    if (event.type === 'tool.call.end') return 'effect_possible'
    return 'none_observed'
  }

  private async persist(): Promise<void> {
    try {
      await this.options.persistReference(this.reference!)
    } catch {
      throw new CodexOfficialRuntimeDriverError('reference_persistence_failed')
    }
  }
}
