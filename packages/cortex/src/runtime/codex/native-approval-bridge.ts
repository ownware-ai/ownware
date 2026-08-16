import { createHash } from 'node:crypto'
import type {
  CheckPermissionResult,
  LoomEvent,
  ToolCall,
  ToolExecutionAuthorizationContext,
} from '@ownware/loom'
import type { CodexServerRequest } from './app-server-client.js'

const SAFE_AUTHORITY = /^[A-Za-z0-9_.:/-]{1,160}$/

type SupportedApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'

export interface CodexNativeApprovalReview {
  readonly kind: 'command' | 'file_change'
  readonly requestId: string
  readonly tool: ToolCall
  readonly authority:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/started'
}

export interface CodexFileChangeContext {
  readonly input: Record<string, unknown>
  readonly authority: string
}

export interface CodexNativeApprovalBridgeOptions {
  readonly threadId: string
  readonly review: (
    review: CodexNativeApprovalReview,
  ) => Promise<'allow' | 'ask' | CheckPermissionResult>
  readonly requestApproval: (
    tool: ToolCall,
    reason: string,
  ) => Promise<boolean>
  /** Final host authorization before the native approval response is sent. */
  readonly authorizeToolExecution?: (
    tool: ToolCall,
    context: ToolExecutionAuthorizationContext,
  ) => boolean | Promise<boolean>
  readonly permissionPolicyRevision?: string
  readonly onEvent?: (event: LoomEvent) => void | Promise<void>
  /**
   * File approval payloads do not carry the change. Context must come from
   * the matching item lifecycle; without it the bridge denies.
   */
  readonly resolveFileChange?: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly itemId: string
  }) => Promise<CodexFileChangeContext | null>
}

export type CodexNativeApprovalHandleResult =
  | { readonly handled: false }
  | {
      readonly handled: true
      readonly response: unknown
      readonly granted: boolean
      readonly requestId?: string
      readonly code?:
        | 'approval_request_invalid'
        | 'approval_scope_mismatch'
        | 'approval_identity_conflict'
        | 'approval_context_missing'
        | 'approval_channel_failed'
        | 'approval_not_granted'
        | 'permission_expansion_denied'
    }

interface ApprovalBase {
  readonly threadId: string
  readonly turnId: string
  readonly itemId: string
  readonly startedAtMs: number
}

interface CachedApproval {
  readonly digest: string
  readonly promise: Promise<CodexNativeApprovalHandleResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!isRecord(value)) return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) output[key] = stable(value[key])
  return output
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function requestIdentity(
  method: SupportedApprovalMethod,
  base: ApprovalBase,
  approvalId: unknown,
): string {
  const providerIdentity = (
    typeof approvalId === 'string' && approvalId.length > 0
  )
    ? approvalId
    : base.itemId
  return digest({
    method,
    threadId: base.threadId,
    turnId: base.turnId,
    providerIdentity,
  })
}

function parseBase(value: unknown): ApprovalBase | null {
  if (!isRecord(value)) return null
  const threadId = value['threadId']
  const turnId = value['turnId']
  const itemId = value['itemId']
  const startedAtMs = value['startedAtMs']
  if (
    typeof threadId !== 'string'
    || threadId.length === 0
    || typeof turnId !== 'string'
    || turnId.length === 0
    || typeof itemId !== 'string'
    || itemId.length === 0
    || !Number.isSafeInteger(startedAtMs)
    || (startedAtMs as number) < 0
  ) return null
  return {
    threadId,
    turnId,
    itemId,
    startedAtMs: startedAtMs as number,
  }
}

function commandResponse(
  granted: boolean,
  extra: Omit<CodexNativeApprovalHandleResult & { handled: true }, 'handled' | 'response' | 'granted'> = {},
): CodexNativeApprovalHandleResult {
  return {
    handled: true,
    response: { decision: granted ? 'accept' : 'decline' },
    granted,
    ...extra,
  }
}

function fileResponse(
  granted: boolean,
  extra: Omit<CodexNativeApprovalHandleResult & { handled: true }, 'handled' | 'response' | 'granted'> = {},
): CodexNativeApprovalHandleResult {
  return {
    handled: true,
    response: { decision: granted ? 'accept' : 'decline' },
    granted,
    ...extra,
  }
}

function permissionDenied(
  extra: Omit<CodexNativeApprovalHandleResult & { handled: true }, 'handled' | 'response' | 'granted'> = {},
): CodexNativeApprovalHandleResult {
  return {
    handled: true,
    response: {
      permissions: {},
      scope: 'turn',
      strictAutoReview: true,
    },
    granted: false,
    ...extra,
  }
}

function supportedMethod(value: string): value is SupportedApprovalMethod {
  return (
    value === 'item/commandExecution/requestApproval'
    || value === 'item/fileChange/requestApproval'
    || value === 'item/permissions/requestApproval'
  )
}

/**
 * Maps the pinned app-server's native approval callbacks into canonical
 * Ownware permission events. It never emits persistent/session-wide grant
 * decisions and never applies provider-proposed policy amendments.
 */
export class CodexNativeApprovalBridge {
  private readonly cached = new Map<string, CachedApproval>()

  constructor(private readonly options: CodexNativeApprovalBridgeOptions) {}

  handle(
    request: CodexServerRequest,
  ): Promise<CodexNativeApprovalHandleResult> {
    if (!supportedMethod(request.method)) {
      return Promise.resolve({ handled: false })
    }
    const base = parseBase(request.params)
    if (base == null) {
      return Promise.resolve(this.invalidFor(request.method, 'approval_request_invalid'))
    }
    if (base.threadId !== this.options.threadId) {
      return Promise.resolve(this.invalidFor(request.method, 'approval_scope_mismatch'))
    }

    const params = request.params as Record<string, unknown>
    const identity = requestIdentity(
      request.method,
      base,
      params['approvalId'],
    )
    const materialDigest = digest({ method: request.method, params })
    const prior = this.cached.get(identity)
    if (prior != null) {
      if (prior.digest !== materialDigest) {
        return Promise.resolve(this.invalidFor(
          request.method,
          'approval_identity_conflict',
        ))
      }
      return prior.promise
    }

    const promise = this.handleKnown(request.method, base, params, identity)
    this.cached.set(identity, { digest: materialDigest, promise })
    return promise
  }

  private handleKnown(
    method: SupportedApprovalMethod,
    base: ApprovalBase,
    params: Record<string, unknown>,
    identity: string,
  ): Promise<CodexNativeApprovalHandleResult> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.handleCommand(params, identity)
      case 'item/fileChange/requestApproval':
        return this.handleFileChange(base, identity)
      case 'item/permissions/requestApproval':
        return this.handlePermissionExpansion(params, identity)
    }
  }

  private async handleCommand(
    params: Record<string, unknown>,
    identity: string,
  ): Promise<CodexNativeApprovalHandleResult> {
    const command = params['command']
    const cwd = params['cwd']
    const network = params['networkApprovalContext']
    if (
      typeof command !== 'string'
      || command.length === 0
      || !(cwd === null || cwd === undefined || typeof cwd === 'string')
      || !this.validNetworkContext(network)
    ) {
      return commandResponse(false, {
        code: 'approval_request_invalid',
      })
    }
    const input: Record<string, unknown> = {
      command,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(isRecord(network)
        ? {
            network: {
              host: network['host'],
              protocol: network['protocol'],
            },
          }
        : {}),
    }
    const tool: ToolCall = {
      id: `codex_native_${identity}`,
      name: 'codex_native_command',
      input,
    }
    const flow = await this.reviewAndAsk({
      kind: 'command',
      requestId: tool.id,
      tool,
      authority: 'item/commandExecution/requestApproval',
    }, 'Codex requests permission to run this native command.')
    return commandResponse(flow.granted, {
      requestId: tool.id,
      ...(flow.code !== undefined ? { code: flow.code } : {}),
    })
  }

  private async handleFileChange(
    base: ApprovalBase,
    identity: string,
  ): Promise<CodexNativeApprovalHandleResult> {
    let context: CodexFileChangeContext | null = null
    try {
      context = await this.options.resolveFileChange?.({
        threadId: base.threadId,
        turnId: base.turnId,
        itemId: base.itemId,
      }) ?? null
    } catch {
      context = null
    }
    if (
      context == null
      || !isRecord(context.input)
      || !SAFE_AUTHORITY.test(context.authority)
    ) {
      return fileResponse(false, { code: 'approval_context_missing' })
    }
    const tool: ToolCall = {
      id: `codex_native_${identity}`,
      name: 'codex_native_file_change',
      input: context.input,
    }
    const flow = await this.reviewAndAsk({
      kind: 'file_change',
      requestId: tool.id,
      tool,
      authority: 'item/fileChange/started',
    }, 'Codex requests permission to apply these native file changes.')
    return fileResponse(flow.granted, {
      requestId: tool.id,
      ...(flow.code !== undefined ? { code: flow.code } : {}),
    })
  }

  private async handlePermissionExpansion(
    params: Record<string, unknown>,
    identity: string,
  ): Promise<CodexNativeApprovalHandleResult> {
    const permissions = params['permissions']
    if (!isRecord(permissions)) {
      return permissionDenied({ code: 'approval_request_invalid' })
    }
    const tool: ToolCall = {
      id: `codex_native_${identity}`,
      name: 'codex_native_permission_request',
      input: {
        requestedFilesystem: permissions['fileSystem'] != null,
        requestedNetwork: permissions['network'] != null,
      },
    }
    const requestObserved = await this.emit({
      type: 'permission.request',
      requestId: tool.id,
      toolName: tool.name,
      input: tool.input,
      reason: 'Runtime permission expansion is outside this run envelope.',
      turnIndex: 0,
      severityTag: 'critical',
      severityReason: 'permission-expansion',
    })
    if (requestObserved) {
      await this.emit({
        type: 'permission.response',
        requestId: tool.id,
        granted: false,
        turnIndex: 0,
        reason: {
          type: 'user-denied',
          toolName: tool.name,
          toolInput: tool.input,
        },
      })
    }
    return permissionDenied({
      requestId: tool.id,
      code: 'permission_expansion_denied',
    })
  }

  private async reviewAndAsk(
    review: CodexNativeApprovalReview,
    reason: string,
  ): Promise<{
    readonly granted: boolean
    readonly code?: 'approval_channel_failed' | 'approval_not_granted'
  }> {
    let decision: 'allow' | 'ask' | CheckPermissionResult
    try {
      decision = await this.options.review(review)
    } catch {
      decision = {
        decision: 'ask',
        explanation: 'Permission classification failed; explicit approval is required.',
        severityTag: 'critical',
        severityReason: 'classifier-error',
      }
    }
    const verdict = typeof decision === 'string' ? decision : decision.decision
    const metadata = typeof decision === 'string' ? null : decision
    const visibleReason = metadata?.explanation ?? reason
    const policyRevision = metadata?.policyRevision
      ?? this.options.permissionPolicyRevision
    if (
      this.options.permissionPolicyRevision !== undefined
      && policyRevision !== this.options.permissionPolicyRevision
    ) {
      return { granted: false, code: 'approval_channel_failed' }
    }

    // A provider-native approval callback is itself the last Ownware boundary
    // before the app-server may perform the effect. No callback means this
    // adapter cannot honestly claim an exact permission binding, so it denies.
    const authorizeFinal = async (approvalRequested: boolean): Promise<boolean> => {
      try {
        return await this.options.authorizeToolExecution?.(review.tool, {
          requestId: review.requestId,
          agentId: null,
          approvalRequested,
          ...(policyRevision === undefined ? {} : { policyRevision }),
        }) === true
      } catch {
        return false
      }
    }

    if (verdict === 'allow') {
      return await authorizeFinal(false)
        ? { granted: true }
        : { granted: false, code: 'approval_channel_failed' }
    }

    if (!(await this.emit({
      type: 'permission.request',
      requestId: review.requestId,
      toolName: review.tool.name,
      input: review.tool.input,
      reason: visibleReason,
      turnIndex: 0,
      ...(metadata?.zoneLevel !== undefined
        ? { zoneLevel: metadata.zoneLevel }
        : {}),
      ...(metadata?.zoneName !== undefined
        ? { zoneName: metadata.zoneName }
        : {}),
      ...(metadata?.explanation !== undefined
        ? { explanation: metadata.explanation }
        : {}),
      ...(metadata?.severityTag !== undefined
        ? { severityTag: metadata.severityTag }
        : {}),
      ...(metadata?.severityReason !== undefined
        ? { severityReason: metadata.severityReason }
        : {}),
      ...(policyRevision === undefined ? {} : { policyRevision }),
    }))) {
      return { granted: false, code: 'approval_channel_failed' }
    }

    let granted = false
    try {
      granted = await this.options.requestApproval(review.tool, visibleReason)
    } catch {
      return { granted: false, code: 'approval_channel_failed' }
    }
    if (granted && !await authorizeFinal(true)) {
      granted = false
      await this.emit({
        type: 'security.block',
        toolName: review.tool.name,
        level: 'permission-binding',
        reason: 'permission-binding-invalid',
        turnIndex: 0,
      })
    }
    const responseObserved = await this.emit(granted
      ? {
          type: 'permission.response',
          requestId: review.requestId,
          granted: true,
          turnIndex: 0,
        }
      : {
          type: 'permission.response',
          requestId: review.requestId,
          granted: false,
          turnIndex: 0,
          reason: {
            type: 'user-denied',
            toolName: review.tool.name,
            toolInput: review.tool.input,
          },
        })
    if (!responseObserved) {
      return { granted: false, code: 'approval_channel_failed' }
    }
    return granted
      ? { granted: true }
      : { granted: false, code: 'approval_not_granted' }
  }

  private async emit(event: LoomEvent): Promise<boolean> {
    if (this.options.onEvent == null) return true
    try {
      await this.options.onEvent(event)
      return true
    } catch {
      return false
    }
  }

  private validNetworkContext(value: unknown): boolean {
    if (value == null) return true
    if (!isRecord(value)) return false
    return (
      typeof value['host'] === 'string'
      && value['host'].length > 0
      && (
        value['protocol'] === 'http'
        || value['protocol'] === 'https'
        || value['protocol'] === 'socks5Tcp'
        || value['protocol'] === 'socks5Udp'
      )
    )
  }

  private invalidFor(
    method: SupportedApprovalMethod,
    code:
      | 'approval_request_invalid'
      | 'approval_scope_mismatch'
      | 'approval_identity_conflict',
  ): CodexNativeApprovalHandleResult {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return commandResponse(false, { code })
      case 'item/fileChange/requestApproval':
        return fileResponse(false, { code })
      case 'item/permissions/requestApproval':
        return permissionDenied({ code })
    }
  }
}
