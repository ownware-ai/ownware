import {
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  executeTool,
  type CheckPermissionResult,
  type LoomEvent,
  type Tool,
  type ToolCall,
  type ToolContext,
} from '@ownware/loom'
import type { RuntimeConsequence } from '../port.js'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_MAX_INVOCATIONS = 1_024
const MAX_TOOL_NAME_LENGTH = 128
const TOOL_NAME = /^[A-Za-z0-9_-]+$/
const SAFE_AUTHORITY = /^[A-Za-z0-9_.:/-]{1,160}$/

export type CodexMcpBridgeErrorCode =
  | 'invalid_run'
  | 'invalid_tool'
  | 'duplicate_tool'
  | 'invalid_schema'
  | 'duplicate_run'
  | 'hub_closed'

export class CodexMcpBridgeError extends Error {
  public override readonly name = 'CodexMcpBridgeError'

  constructor(readonly code: CodexMcpBridgeErrorCode) {
    super(`Codex MCP bridge rejected configuration (${code}).`)
  }
}

export interface CodexEffectObservation {
  readonly consequence: RuntimeConsequence
  readonly authority: string
}

export interface CodexMcpInvocationReceipt {
  readonly id: string
  readonly runId: string
  readonly toolName: string
  readonly inputDigest: string
  readonly startedAt: string
  readonly completedAt: string | null
  readonly state:
    | 'running'
    | 'denied'
    | 'completed'
    | 'failed'
    | 'outcome_unknown'
  readonly consequence: RuntimeConsequence
  readonly effectAuthority: string | null
  readonly observerState: 'ok' | 'failed'
  readonly responseState: 'pending' | 'written' | 'lost'
  /**
   * An HTTP server socket write is not client receipt. A later app-server
   * tool-result event may provide correlation; this boundary stays unknown.
   */
  readonly deliveryEvidence: 'unknown' | 'app_server_item_completed'
  readonly appServerOutcome: 'completed' | 'failed' | null
  readonly executionCount: number
  readonly replayCount: number
}

export interface CodexMcpRunRegistration {
  readonly runId: string
  readonly tools: readonly Tool[]
  readonly context: ToolContext
  readonly checkPermission?: (
    tool: ToolCall,
  ) => Promise<'allow' | 'ask' | CheckPermissionResult>
  readonly requestApproval?: (
    tool: ToolCall,
    reason: string,
  ) => Promise<boolean>
  readonly onEvent?: (event: LoomEvent) => void | Promise<void>
  /**
   * Optional authority at the effect boundary. A successful ToolResult is not
   * enough to return `effect_confirmed`.
   */
  readonly confirmEffect?: (input: {
    readonly invocationId: string
    readonly toolName: string
    readonly input: Readonly<Record<string, unknown>>
    readonly isError: boolean
  }) => Promise<CodexEffectObservation>
}

export interface CodexMcpRunHandle {
  readonly runId: string
  readonly endpoint: string
  readonly toolNames: readonly string[]
  /**
   * Secret run capability. It is exposed only so the process supervisor can
   * place it in the configured bearer-token environment variable.
   */
  readonly bearerToken: string
  isActive(): boolean
  receipts(): readonly CodexMcpInvocationReceipt[]
  confirmAppServerDelivery(
    observation: CodexMcpDeliveryObservation,
  ): CodexMcpDeliveryResult
  close(): Promise<void>
}

export interface CodexMcpDeliveryObservation {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly status: 'completed' | 'failed'
  readonly authority: 'item/completed'
}

export type CodexMcpDeliveryResult =
  | {
      readonly status: 'confirmed'
      readonly consequence: RuntimeConsequence
      readonly receiptState: CodexMcpInvocationReceipt['state']
    }
  | { readonly status: 'not_found' | 'ambiguous' }

export interface CodexMcpToolHubOptions {
  readonly maxBodyBytes?: number
  readonly maxInvocationsPerRun?: number
}

interface MutableReceipt {
  id: string
  runId: string
  toolName: string
  inputDigest: string
  startedAt: string
  completedAt: string | null
  state: CodexMcpInvocationReceipt['state']
  consequence: RuntimeConsequence
  effectAuthority: string | null
  observerState: CodexMcpInvocationReceipt['observerState']
  responseState: CodexMcpInvocationReceipt['responseState']
  deliveryEvidence: CodexMcpInvocationReceipt['deliveryEvidence']
  appServerOutcome: CodexMcpInvocationReceipt['appServerOutcome']
  executionCount: number
  replayCount: number
}

interface CachedInvocation {
  readonly digest: string
  readonly receipt: MutableReceipt
  readonly promise: Promise<JsonRpcResponse>
}

interface RunScope {
  readonly runId: string
  readonly token: string
  readonly tools: ReadonlyMap<string, Tool>
  readonly context: ToolContext
  readonly checkPermission: NonNullable<CodexMcpRunRegistration['checkPermission']>
  readonly requestApproval: NonNullable<CodexMcpRunRegistration['requestApproval']>
  readonly onEvent?: CodexMcpRunRegistration['onEvent']
  readonly confirmEffect?: CodexMcpRunRegistration['confirmEffect']
  readonly sessions: Set<string>
  readonly invocations: Map<string, CachedInvocation>
  readonly receipts: MutableReceipt[]
  readonly abortController: AbortController
  closed: boolean
}

interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number
  readonly method: string
  readonly params?: unknown
}

interface JsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: {
    readonly code: number
    readonly message: string
  }
}

interface DispatchResult {
  readonly status: number
  readonly body?: JsonRpcResponse
  readonly sessionId?: string
  readonly receipt?: MutableReceipt
}

function cloneReceipt(receipt: MutableReceipt): CodexMcpInvocationReceipt {
  return { ...receipt }
}

function jsonError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}

function jsonResult(
  id: string | number,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = stableValue(value[key])
  }
  return result
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

function idKey(id: string | number): string {
  return `${typeof id}:${String(id)}`
}

function redactToolResult(content: string, context: ToolContext): string {
  let redacted = content
  let credentials: ReturnType<ToolContext['listAllCredentialValues']> = []
  try {
    credentials = context.listAllCredentialValues()
  } catch {
    return '[Tool output could not be safely redacted.]'
  }
  for (const credential of credentials) {
    if (credential.value.length > 0) {
      redacted = redacted.replaceAll(credential.value, '[REDACTED]')
    }
  }
  return redacted
}

const ROOT_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
])
const PROPERTY_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'default',
])
const SUPPORTED_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
])

function validRequired(
  value: unknown,
  properties: Record<string, unknown>,
): value is string[] | undefined {
  return value === undefined || (
    Array.isArray(value)
    && new Set(value).size === value.length
    && value.every((item) => (
      typeof item === 'string'
      && Object.hasOwn(properties, item)
    ))
  )
}

function validatePropertySchema(value: unknown, depth: number): boolean {
  if (depth > 20 || !isRecord(value)) return false
  if (Object.keys(value).some((key) => !PROPERTY_SCHEMA_KEYS.has(key))) {
    return false
  }
  const type = value['type']
  if (typeof type !== 'string' || !SUPPORTED_SCHEMA_TYPES.has(type)) {
    return false
  }
  if (
    value['enum'] !== undefined
    && (
      !Array.isArray(value['enum'])
      || value['enum'].length === 0
      || !value['enum'].every((item) => typeof item === 'string')
    )
  ) return false
  if (
    type === 'array'
    && value['items'] !== undefined
    && !validatePropertySchema(value['items'], depth + 1)
  ) return false
  if (type === 'object') {
    const properties = value['properties'] ?? {}
    if (!isRecord(properties)) return false
    if (!validRequired(value['required'], properties)) return false
    for (const property of Object.values(properties)) {
      if (!validatePropertySchema(property, depth + 1)) return false
    }
  }
  return true
}

function validateRootSchema(value: unknown): value is Tool['inputSchema'] {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => !ROOT_SCHEMA_KEYS.has(key))) return false
  if (value['type'] !== 'object' || !isRecord(value['properties'])) return false
  if (!validRequired(value['required'], value['properties'])) return false
  if (
    value['additionalProperties'] !== undefined
    && typeof value['additionalProperties'] !== 'boolean'
  ) return false
  return Object.values(value['properties']).every((property) =>
    validatePropertySchema(property, 0))
}

function matchesPropertySchema(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema['type']
  if (
    Array.isArray(schema['enum'])
    && !schema['enum'].includes(value)
  ) return false
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    case 'array':
      return (
        Array.isArray(value)
        && (
          schema['items'] === undefined
          || (
            isRecord(schema['items'])
            && value.every((item) => matchesPropertySchema(item, schema['items'] as Record<string, unknown>))
          )
        )
      )
    case 'object': {
      if (!isRecord(value)) return false
      const properties = isRecord(schema['properties']) ? schema['properties'] : {}
      const required = Array.isArray(schema['required'])
        ? schema['required'] as string[]
        : []
      if (required.some((key) => !Object.hasOwn(value, key))) return false
      for (const [key, child] of Object.entries(value)) {
        const childSchema = properties[key]
        if (childSchema !== undefined) {
          if (!isRecord(childSchema) || !matchesPropertySchema(child, childSchema)) {
            return false
          }
        }
      }
      return true
    }
    default:
      return false
  }
}

function matchesToolSchema(
  input: Record<string, unknown>,
  schema: Tool['inputSchema'],
): boolean {
  const required = schema.required ?? []
  if (required.some((key) => !Object.hasOwn(input, key))) return false
  if (
    schema.additionalProperties === false
    && Object.keys(input).some((key) => !Object.hasOwn(schema.properties, key))
  ) return false
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key]
    if (
      property !== undefined
      && !matchesPropertySchema(value, property as unknown as Record<string, unknown>)
    ) return false
  }
  return true
}

function cloneTool(source: Tool): Tool {
  let schema: unknown
  try {
    schema = JSON.parse(JSON.stringify(source.inputSchema))
  } catch {
    throw new CodexMcpBridgeError('invalid_schema')
  }
  if (!validateRootSchema(schema)) {
    throw new CodexMcpBridgeError('invalid_schema')
  }
  return {
    ...source,
    inputSchema: schema,
  }
}

function validateTools(tools: readonly Tool[]): ReadonlyMap<string, Tool> {
  const result = new Map<string, Tool>()
  for (const source of tools) {
    if (
      typeof source.name !== 'string'
      || source.name.length === 0
      || source.name.length > MAX_TOOL_NAME_LENGTH
      || !TOOL_NAME.test(source.name)
    ) {
      throw new CodexMcpBridgeError('invalid_tool')
    }
    if (result.has(source.name)) {
      throw new CodexMcpBridgeError('duplicate_tool')
    }
    result.set(source.name, cloneTool(source))
  }
  return result
}

function safeRunId(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
}

/**
 * One loopback Streamable HTTP endpoint shared by a kernel process.
 *
 * Tool authority is still run-scoped: the bearer capability chooses one
 * immutable registration, and no listing or call can cross registrations.
 */
export class CodexMcpToolHub {
  private readonly scopesByToken = new Map<string, RunScope>()
  private readonly tokensByRun = new Map<string, string>()
  private readonly server: Server
  private readonly maxBodyBytes: number
  private readonly maxInvocations: number
  private closed = false
  private closePromise: Promise<void> | undefined
  private endpointValue = ''

  private constructor(options: CodexMcpToolHubOptions) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.maxInvocations = options.maxInvocationsPerRun ?? DEFAULT_MAX_INVOCATIONS
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) {
          this.writeJson(response, 500, jsonError(null, -32603, 'Bridge request failed.'))
        } else {
          response.destroy()
        }
      })
    })
  }

  static async start(options: CodexMcpToolHubOptions = {}): Promise<CodexMcpToolHub> {
    const hub = new CodexMcpToolHub(options)
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = () => rejectListen(new Error('Codex MCP bridge could not listen.'))
      hub.server.once('error', onError)
      hub.server.listen(0, '127.0.0.1', () => {
        hub.server.removeListener('error', onError)
        const address = hub.server.address()
        if (address == null || typeof address === 'string') {
          rejectListen(new Error('Codex MCP bridge did not receive a loopback port.'))
          return
        }
        hub.endpointValue = `http://127.0.0.1:${address.port}/mcp`
        resolveListen()
      })
    })
    return hub
  }

  registerRun(registration: CodexMcpRunRegistration): CodexMcpRunHandle {
    if (this.closed) throw new CodexMcpBridgeError('hub_closed')
    if (!safeRunId(registration.runId)) {
      throw new CodexMcpBridgeError('invalid_run')
    }
    if (this.tokensByRun.has(registration.runId)) {
      throw new CodexMcpBridgeError('duplicate_run')
    }

    const token = randomBytes(32).toString('base64url')
    const scope: RunScope = {
      runId: registration.runId,
      token,
      tools: validateTools(registration.tools),
      context: registration.context,
      checkPermission: registration.checkPermission ?? (async () => 'ask'),
      requestApproval: registration.requestApproval ?? (async () => false),
      ...(registration.onEvent ? { onEvent: registration.onEvent } : {}),
      ...(registration.confirmEffect
        ? { confirmEffect: registration.confirmEffect }
        : {}),
      sessions: new Set(),
      invocations: new Map(),
      receipts: [],
      abortController: new AbortController(),
      closed: false,
    }
    this.scopesByToken.set(token, scope)
    this.tokensByRun.set(scope.runId, token)

    return {
      runId: scope.runId,
      endpoint: this.endpointValue,
      toolNames: Object.freeze([...scope.tools.keys()].sort()),
      bearerToken: token,
      isActive: () => !scope.closed,
      receipts: () => scope.receipts.map(cloneReceipt),
      confirmAppServerDelivery: (observation) =>
        this.confirmAppServerDelivery(scope, observation),
      close: async () => {
        this.revoke(scope)
      },
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce()
    return this.closePromise
  }

  private async closeOnce(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const scope of this.scopesByToken.values()) this.revoke(scope)
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose())
      this.server.closeAllConnections?.()
    })
  }

  private revoke(scope: RunScope): void {
    if (scope.closed) return
    scope.closed = true
    scope.abortController.abort()
    scope.sessions.clear()
    this.scopesByToken.delete(scope.token)
    this.tokensByRun.delete(scope.runId)
  }

  private authenticate(request: IncomingMessage): RunScope | null {
    const authorization = request.headers.authorization
    if (
      typeof authorization !== 'string'
      || !authorization.startsWith('Bearer ')
    ) return null
    const token = authorization.slice('Bearer '.length)
    const scope = this.scopesByToken.get(token)
    return scope != null && !scope.closed ? scope : null
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url !== '/mcp') {
      this.writeJson(response, 404, jsonError(null, -32601, 'Not found.'))
      return
    }
    const scope = this.authenticate(request)
    if (scope == null) {
      response.setHeader('www-authenticate', 'Bearer')
      this.writeJson(response, 401, jsonError(null, -32001, 'Unauthorized.'))
      return
    }

    if (request.method === 'DELETE') {
      const sessionId = request.headers['mcp-session-id']
      if (typeof sessionId !== 'string' || !scope.sessions.delete(sessionId)) {
        this.writeJson(response, 404, jsonError(null, -32002, 'Session not found.'))
        return
      }
      response.statusCode = 204
      response.end()
      return
    }
    if (request.method === 'GET') {
      response.setHeader('allow', 'POST, DELETE')
      this.writeJson(response, 405, jsonError(null, -32601, 'Streaming is not enabled.'))
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST, DELETE')
      this.writeJson(response, 405, jsonError(null, -32601, 'Method not allowed.'))
      return
    }

    let requestBody: unknown
    try {
      requestBody = JSON.parse(await this.readBody(request))
    } catch {
      this.writeJson(response, 400, jsonError(null, -32700, 'Invalid JSON.'))
      return
    }
    if (!isRecord(requestBody) || Array.isArray(requestBody)) {
      this.writeJson(response, 400, jsonError(null, -32600, 'Invalid request.'))
      return
    }
    const rpc = requestBody as Partial<JsonRpcRequest>
    if (
      rpc.jsonrpc !== '2.0'
      || typeof rpc.method !== 'string'
      || rpc.method.length === 0
      || (
        rpc.id !== undefined
        && typeof rpc.id !== 'string'
        && typeof rpc.id !== 'number'
      )
    ) {
      this.writeJson(response, 400, jsonError(null, -32600, 'Invalid request.'))
      return
    }

    const result = await this.dispatch(
      scope,
      rpc as JsonRpcRequest,
      request.headers['mcp-session-id'],
    )
    if (result.sessionId) {
      response.setHeader('mcp-session-id', result.sessionId)
    }
    if (result.body == null) {
      response.statusCode = result.status
      response.end()
      return
    }
    this.writeJson(response, result.status, result.body, result.receipt)
  }

  private async dispatch(
    scope: RunScope,
    request: JsonRpcRequest,
    sessionHeader: string | string[] | undefined,
  ): Promise<DispatchResult> {
    if (request.method === 'initialize') {
      if (request.id === undefined || !isRecord(request.params)) {
        return {
          status: 400,
          body: jsonError(request.id ?? null, -32602, 'Invalid initialize parameters.'),
        }
      }
      const sessionId = randomUUID()
      scope.sessions.add(sessionId)
      return {
        status: 200,
        sessionId,
        body: jsonResult(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ownware', version: '1' },
        }),
      }
    }

    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : null
    if (sessionId == null || !scope.sessions.has(sessionId)) {
      return {
        status: 404,
        body: jsonError(request.id ?? null, -32002, 'Session not found.'),
      }
    }
    if (request.id === undefined) {
      return { status: 202 }
    }
    if (request.method === 'ping') {
      return { status: 200, body: jsonResult(request.id, {}) }
    }
    if (request.method === 'tools/list') {
      const tools = [...scope.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.isReadOnly === true,
          destructiveHint: tool.isReadOnly !== true,
        },
      }))
      return {
        status: 200,
        body: jsonResult(request.id, { tools }),
      }
    }
    if (request.method !== 'tools/call') {
      return {
        status: 404,
        body: jsonError(request.id, -32601, 'Method not supported.'),
      }
    }
    if (!isRecord(request.params)) {
      return {
        status: 400,
        body: jsonError(request.id, -32602, 'Invalid tool call parameters.'),
      }
    }
    const name = request.params['name']
    const args = request.params['arguments'] ?? {}
    if (typeof name !== 'string') {
      return {
        status: 200,
        body: jsonResult(request.id, this.toolError('Tool name is invalid.')),
      }
    }
    if (!isRecord(args)) {
      return {
        status: 200,
        body: jsonResult(request.id, this.toolError('Tool arguments must be an object.')),
      }
    }
    const selected = scope.tools.get(name)
    if (selected == null) {
      return {
        status: 200,
        body: jsonResult(
          request.id,
          this.toolError('Requested tool is not available in this Ownware run.'),
        ),
      }
    }
    if (!matchesToolSchema(args, selected.inputSchema)) {
      return {
        status: 200,
        body: jsonResult(
          request.id,
          this.toolError(`Tool "${name}" arguments do not match its declared schema.`),
        ),
      }
    }

    const key = `${sessionId}:${idKey(request.id)}`
    const materialDigest = digest({ name, arguments: args })
    const cached = scope.invocations.get(key)
    if (cached != null) {
      if (cached.digest !== materialDigest) {
        return {
          status: 409,
          body: jsonError(request.id, -32600, 'Request id was reused with different input.'),
        }
      }
      cached.receipt.replayCount += 1
      return {
        status: 200,
        body: await cached.promise,
        receipt: cached.receipt,
      }
    }
    if (scope.invocations.size >= this.maxInvocations) {
      return {
        status: 429,
        body: jsonError(request.id, -32003, 'Run invocation limit reached.'),
      }
    }

    const receipt: MutableReceipt = {
      id: randomUUID(),
      runId: scope.runId,
      toolName: selected.name,
      inputDigest: materialDigest,
      startedAt: new Date().toISOString(),
      completedAt: null,
      state: 'running',
      consequence: 'none_observed',
      effectAuthority: null,
      observerState: 'ok',
      responseState: 'pending',
      deliveryEvidence: 'unknown',
      appServerOutcome: null,
      executionCount: 1,
      replayCount: 0,
    }
    scope.receipts.push(receipt)
    const promise = this.executeInvocation(
      scope,
      selected,
      request.id,
      args,
      receipt,
    )
    scope.invocations.set(key, { digest: materialDigest, receipt, promise })
    return {
      status: 200,
      body: await promise,
      receipt,
    }
  }

  private async executeInvocation(
    scope: RunScope,
    tool: Tool,
    requestId: string | number,
    input: Record<string, unknown>,
    receipt: MutableReceipt,
  ): Promise<JsonRpcResponse> {
    const toolCallId = `codex_mcp_${receipt.id}`
    const toolCall: ToolCall = {
      id: toolCallId,
      name: tool.name,
      input,
    }
    const started = Date.now()

    if (!(await this.emit(scope, receipt, {
      type: 'tool.call.start',
      toolCallId,
      toolName: tool.name,
      input,
      turnIndex: 0,
    }))) {
      return this.finishBeforeExecution(
        scope,
        requestId,
        toolCallId,
        tool.name,
        receipt,
        'Tool was not executed because its activity could not be presented safely.',
        started,
      )
    }

    if (tool.requiresPermission) {
      const allowed = await this.authorize(scope, receipt, toolCall)
      if (!allowed) {
        const denied = `Permission denied for tool "${tool.name}".`
        receipt.state = 'denied'
        receipt.completedAt = new Date().toISOString()
        await this.emitBestEffort(scope, receipt, {
          type: 'tool.call.end',
          toolCallId,
          toolName: tool.name,
          result: denied,
          isError: true,
          durationMs: Date.now() - started,
          turnIndex: 0,
        })
        return jsonResult(requestId, this.toolError(denied))
      }
    }

    if (tool.isReadOnly !== true) {
      receipt.consequence = 'effect_possible'
    }

    const executable: Tool = { ...tool, requiresPermission: false }
    const executionContext: ToolContext = {
      ...scope.context,
      signal: AbortSignal.any([
        scope.context.signal,
        scope.abortController.signal,
      ]),
      requestPermission: async (action, detail) => {
        const nested: ToolCall = {
          id: `${toolCallId}_nested_${randomUUID()}`,
          name: action,
          input: { detail },
        }
        return this.authorize(scope, receipt, nested)
      },
    }
    const result = await executeTool({
      tool: executable,
      toolCall,
      context: executionContext,
      onProgress: (progress) => {
        void this.emit(scope, receipt, {
          type: 'tool.call.progress',
          toolCallId,
          progress: progress.message,
          turnIndex: 0,
        })
      },
    })
    const content = redactToolResult(result.result.content, scope.context)

    if (scope.confirmEffect && tool.isReadOnly !== true) {
      try {
        const observed = await scope.confirmEffect({
          invocationId: receipt.id,
          toolName: tool.name,
          input,
          isError: result.result.isError,
        })
        if (
          SAFE_AUTHORITY.test(observed.authority)
          && (
            observed.consequence === 'effect_possible'
            || observed.consequence === 'effect_confirmed'
            || observed.consequence === 'none_observed'
          )
        ) {
          receipt.consequence = observed.consequence
          receipt.effectAuthority = observed.authority
        } else {
          receipt.observerState = 'failed'
        }
      } catch {
        receipt.observerState = 'failed'
      }
    }

    const eventObserved = await this.emit(scope, receipt, {
      type: 'tool.call.end',
      toolCallId,
      toolName: tool.name,
      result: content,
      isError: result.result.isError,
      durationMs: result.durationMs,
      turnIndex: 0,
    })
    receipt.completedAt = new Date().toISOString()

    if (!eventObserved || receipt.observerState === 'failed') {
      receipt.state = 'outcome_unknown'
      receipt.observerState = 'failed'
      return jsonResult(
        requestId,
        this.toolError(
          'The tool handler returned, but effect or visibility evidence failed; the outcome is uncertain. Do not retry automatically.',
        ),
      )
    }

    receipt.state = result.result.isError ? 'failed' : 'completed'
    return jsonResult(requestId, {
      content: [{ type: 'text', text: content }],
      isError: result.result.isError,
    })
  }

  private async authorize(
    scope: RunScope,
    receipt: MutableReceipt,
    toolCall: ToolCall,
  ): Promise<boolean> {
    let decision: 'allow' | 'ask' | CheckPermissionResult
    try {
      decision = await scope.checkPermission(toolCall)
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
    if (verdict === 'allow') return true

    const reason = metadata?.explanation ?? 'Tool requires explicit approval'
    const requestEvent: LoomEvent = {
      type: 'permission.request',
      requestId: toolCall.id,
      toolName: toolCall.name,
      input: toolCall.input,
      reason,
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
    }
    if (!(await this.emit(scope, receipt, requestEvent))) return false

    let approved = false
    try {
      approved = await scope.requestApproval(toolCall, reason)
    } catch {
      approved = false
    }
    await this.emitBestEffort(scope, receipt, approved
      ? {
          type: 'permission.response',
          requestId: toolCall.id,
          granted: true,
          turnIndex: 0,
        }
      : {
          type: 'permission.response',
          requestId: toolCall.id,
          granted: false,
          turnIndex: 0,
          reason: {
            type: 'user-denied',
            toolName: toolCall.name,
            toolInput: toolCall.input,
          },
        })
    return approved
  }

  private async finishBeforeExecution(
    scope: RunScope,
    requestId: string | number,
    toolCallId: string,
    toolName: string,
    receipt: MutableReceipt,
    message: string,
    started: number,
  ): Promise<JsonRpcResponse> {
    receipt.state = 'failed'
    receipt.completedAt = new Date().toISOString()
    await this.emitBestEffort(scope, receipt, {
      type: 'tool.call.end',
      toolCallId,
      toolName,
      result: message,
      isError: true,
      durationMs: Date.now() - started,
      turnIndex: 0,
    })
    return jsonResult(requestId, this.toolError(message))
  }

  private async emit(
    scope: RunScope,
    receipt: MutableReceipt,
    event: LoomEvent,
  ): Promise<boolean> {
    if (scope.onEvent == null) return true
    try {
      await scope.onEvent(event)
      return true
    } catch {
      receipt.observerState = 'failed'
      return false
    }
  }

  private async emitBestEffort(
    scope: RunScope,
    receipt: MutableReceipt,
    event: LoomEvent,
  ): Promise<void> {
    await this.emit(scope, receipt, event)
  }

  private toolError(message: string): {
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
    readonly isError: true
  } {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    }
  }

  private confirmAppServerDelivery(
    scope: RunScope,
    observation: CodexMcpDeliveryObservation,
  ): CodexMcpDeliveryResult {
    const inputDigest = digest({
      name: observation.toolName,
      arguments: observation.input,
    })
    const candidates = scope.receipts.filter((receipt) => (
      receipt.toolName === observation.toolName
      && receipt.inputDigest === inputDigest
      && receipt.deliveryEvidence === 'unknown'
    ))
    if (candidates.length === 0) return { status: 'not_found' }
    if (candidates.length !== 1) return { status: 'ambiguous' }

    const receipt = candidates[0]!
    receipt.deliveryEvidence = 'app_server_item_completed'
    receipt.appServerOutcome = observation.status
    if (receipt.state === 'outcome_unknown' && receipt.observerState === 'ok') {
      receipt.state = observation.status
    }
    return {
      status: 'confirmed',
      consequence: receipt.consequence,
      receiptState: receipt.state,
    }
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = []
      let bytes = 0
      request.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        bytes += buffer.length
        if (bytes > this.maxBodyBytes) {
          rejectBody(new Error('body_limit'))
          request.destroy()
          return
        }
        chunks.push(buffer)
      })
      request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      request.on('error', rejectBody)
    })
  }

  private writeJson(
    response: ServerResponse,
    status: number,
    body: JsonRpcResponse,
    receipt?: MutableReceipt,
  ): void {
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    if (receipt) {
      let finished = false
      response.once('finish', () => {
        finished = true
        receipt.responseState = 'written'
      })
      response.once('close', () => {
        if (finished) return
        receipt.responseState = 'lost'
        if (
          receipt.state === 'running'
          || receipt.consequence === 'effect_possible'
        ) {
          receipt.state = 'outcome_unknown'
        }
      })
    }
    response.end(JSON.stringify(body))
  }
}
