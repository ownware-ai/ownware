/**
 * ComposioClient — thin, typed HTTP client for the Composio v3 API.
 *
 * Scope
 * -----
 * Phase 2b.1 ships ALL ten methods the kernel + tool adapter will ever
 * need (listToolkits, getToolkit, listAuthConfigs, getAuthConfig,
 * createConnectionLink, getConnectedAccount, listConnectedAccounts,
 * listTools, getTool, executeTool). Only four are wired this phase
 * (auth configs + connect link + connected-account status for the
 * listener); the remaining six are exercised by unit tests and plugged
 * in by Phase 2b.2 (sync + tool-adapter + execute).
 *
 * Design
 * ------
 * - Zero external deps. Uses the runtime-global `fetch`.
 * - Every response is Zod-validated; mismatch throws
 *   `ConnectorVendorError` with a helpful message, never a silent
 *   `as` cast.
 * - All vendor-facing errors funnel through the typed-error hierarchy
 *   in `../errors.ts` so callers switch on the subclass rather than
 *   reading status codes or strings.
 * - Idempotent GETs retry on network errors and 5xx/429 up to
 *   `maxRetries` (default 3) with exponential backoff (500ms → 1s →
 *   2s → 4s, capped at 8s). POST/PATCH/DELETE never retry — we never
 *   risk double-creating a connection link.
 * - Each call has a 30s per-attempt timeout via AbortController.
 * - The API key is read once at construction and never written to a
 *   log line. `toString()` does NOT expose it.
 *
 * Schema provenance
 * -----------------
 * Every response Zod schema below carries a `// schema source:` comment
 * citing the OpenAPI path it was derived from. Fields the spec marks
 * `required` are required in Zod; everything else is `.optional()`.
 * Objects use `.passthrough()` where the OpenAPI uses
 * `additionalProperties: { nullable: true }` or an open-ended shape,
 * and `// derived:` is added in that case.
 *
 * Source of truth:
 *   https://backend.composio.dev/api/v3/openapi.json
 *   (fetched 2026-04-13 during Phase 2b.1; cached under /tmp/composio-openapi.json)
 */

import { z } from 'zod'
import {
  ConnectorAuthExpiredError,
  ConnectorNetworkError,
  ConnectorNotConfiguredError,
  ConnectorRateLimitedError,
  ConnectorValidationError,
  ConnectorVendorError,
  type ConnectorErrorContext,
} from '../errors.js'

// ---------------------------------------------------------------------------
// Schemas — every response is validated through these
// ---------------------------------------------------------------------------

/* schema source: /api/v3/toolkits GET -> items[].properties (openapi.json) */
const ToolkitMetaSchema = z.object({
  description: z.string().optional(),
  logo: z.string().optional(),
  app_url: z.string().nullable().optional(),
  categories: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough() // derived: spec's `meta` object has additional optional fields we do not read

export const ComposioToolkitSummarySchema = z.object({
  // required per openapi: ["slug","name","is_local_toolkit","deprecated","meta"]
  slug: z.string().min(1),
  name: z.string().min(1),
  auth_schemes: z.array(z.string()).optional(),
  composio_managed_auth_schemes: z.array(z.string()).optional(),
  is_local_toolkit: z.boolean(),
  no_auth: z.boolean().optional(),
  auth_guide_url: z.string().nullable().optional(),
  deprecated: z.unknown(), // derived: DeprecatedToolkitInfo $ref not needed for 2b.1 consumers
  meta: ToolkitMetaSchema,
}).passthrough()

export const ComposioToolkitListSchema = z.object({
  // schema source: /api/v3/toolkits GET .properties (required: none at envelope — derived from items)
  items: z.array(ComposioToolkitSummarySchema),
  next_cursor: z.string().nullable().optional(),
  total_pages: z.number().optional(),
  current_page: z.number().optional(),
  total_items: z.number().optional(),
}).passthrough()

/* schema source: /api/v3/toolkits/{slug} GET responses.200 (required: slug,name,enabled,is_local_toolkit,meta,deprecated) */
export const ComposioToolkitDetailSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  is_local_toolkit: z.boolean(),
  meta: ToolkitMetaSchema,
  deprecated: z.unknown(),
  auth_schemes: z.array(z.string()).optional(),
  composio_managed_auth_schemes: z.array(z.string()).optional(),
  no_auth: z.boolean().optional(),
  auth_guide_url: z.string().nullable().optional(),
}).passthrough()

/* schema source: /api/v3/auth_configs GET responses.200 items[] */
export const ComposioAuthSchemeSchema = z.enum([
  'OAUTH2',
  'OAUTH1',
  'API_KEY',
  'BASIC',
  'BILLCOM_AUTH',
  'BEARER_TOKEN',
  'GOOGLE_SERVICE_ACCOUNT',
  'NO_AUTH',
  'BASIC_WITH_JWT',
  'CALCOM_AUTH',
  'SERVICE_ACCOUNT',
  'SAML',
  'DCR_OAUTH',
  'S2S_OAUTH2',
])

export const ComposioAuthConfigSchema = z.object({
  id: z.string().min(1),
  uuid: z.string().optional(),
  type: z.enum(['default', 'custom']).optional(),
  toolkit: z.object({
    // required: ["slug","logo"]
    slug: z.string().min(1),
    logo: z.string(),
    auth_guide_url: z.string().nullable().optional(),
    auth_hint_url: z.string().nullable().optional(),
  }).passthrough(),
  name: z.string().optional(),
  auth_scheme: ComposioAuthSchemeSchema.optional(),
  is_composio_managed: z.boolean(),
  status: z.enum(['ENABLED', 'DISABLED']).optional(),
  created_at: z.string().optional(),
  last_updated_at: z.string().optional(),
}).passthrough() // derived: response carries credentials/proxy_config/etc. we never read

export const ComposioAuthConfigListSchema = z.object({
  items: z.array(ComposioAuthConfigSchema),
  next_cursor: z.string().nullable().optional(),
  total_pages: z.number().optional(),
  current_page: z.number().optional(),
  total_items: z.number().optional(),
}).passthrough()

/* schema source: /api/v3/connected_accounts/link POST responses.201
   required: ["link_token","redirect_url","expires_at","connected_account_id"] */
export const ComposioConnectionLinkSchema = z.object({
  link_token: z.string().min(1),
  redirect_url: z.string().min(1),
  expires_at: z.string().min(1),
  connected_account_id: z.string().min(1),
}).passthrough()

/* schema source: /api/v3/connected_accounts/{nanoid} GET responses.200
   status enum per openapi: INITIALIZING | INITIATED | ACTIVE | FAILED | EXPIRED | INACTIVE */
export const ComposioConnectedAccountStatusSchema = z.enum([
  'INITIALIZING',
  'INITIATED',
  'ACTIVE',
  'FAILED',
  'EXPIRED',
  'INACTIVE',
])
export type ComposioConnectedAccountStatus = z.infer<typeof ComposioConnectedAccountStatusSchema>

export const ComposioConnectedAccountSchema = z.object({
  id: z.string().min(1),
  toolkit: z.object({ slug: z.string().min(1) }).passthrough(),
  auth_config: z.object({
    id: z.string().min(1),
    is_composio_managed: z.boolean().optional(),
    is_disabled: z.boolean().optional(),
  }).passthrough(),
  status: ComposioConnectedAccountStatusSchema,
  status_reason: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  user_id: z.string().optional(),
  alias: z.string().nullable().optional(),
}).passthrough() // derived: `state` oneOf spans every auth scheme and 150+ fields; we never read it

export const ComposioConnectedAccountListSchema = z.object({
  items: z.array(ComposioConnectedAccountSchema),
  next_cursor: z.string().nullable().optional(),
  total_pages: z.number().optional(),
  current_page: z.number().optional(),
  total_items: z.number().optional(),
}).passthrough()

/* schema source: /api/v3/auth/session/info GET responses.200
   Only `project.name` + `project.org.name` are consumed — those are the
   URL segments the Composio platform UI uses for workspace routing
   (`https://platform.composio.dev/<org.name>/<project.name>/...`).
   The full response also returns the project email, webhook secret, and
   API key metadata; those are NOT read by Cortex and are swallowed by
   the outer `.passthrough()` without being surfaced in the typed domain. */
export const ComposioSessionInfoSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    org: z.object({
      name: z.string().min(1),
    }).passthrough(),
  }).passthrough(),
}).passthrough()

export type ComposioSessionInfo = z.infer<typeof ComposioSessionInfoSchema>

/* schema source: components.schemas.Tool */
export const ComposioToolSchema = z.object({
  slug: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  toolkit: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    logo: z.string(),
  }).passthrough(),
  input_parameters: z.record(z.unknown()).optional(),
  no_auth: z.boolean().optional(),
  available_versions: z.array(z.string()).optional(),
}).passthrough()

/* schema source: components.schemas.ToolsPaginated
   required: ["items","total_pages","current_page","total_items"] */
export const ComposioToolListSchema = z.object({
  items: z.array(ComposioToolSchema),
  next_cursor: z.string().nullable().optional(),
  total_pages: z.number(),
  current_page: z.number(),
  total_items: z.number(),
}).passthrough()

/* schema source: /api/v3/tools/execute/{tool_slug} POST responses.200
   required: ["data","error","successful"] */
export const ComposioExecuteResponseSchema = z.object({
  data: z.record(z.unknown()),
  error: z.string().nullable(),
  successful: z.boolean(),
  log_id: z.string().optional(),
  session_info: z.unknown().nullable().optional(),
}).passthrough()

// Types

export type ComposioToolkitSummary = z.infer<typeof ComposioToolkitSummarySchema>
export type ComposioToolkitDetail = z.infer<typeof ComposioToolkitDetailSchema>
export type ComposioAuthConfig = z.infer<typeof ComposioAuthConfigSchema>
export type ComposioConnectionLink = z.infer<typeof ComposioConnectionLinkSchema>
export type ComposioConnectedAccount = z.infer<typeof ComposioConnectedAccountSchema>
export type ComposioTool = z.infer<typeof ComposioToolSchema>
export type ComposioExecuteResponse = z.infer<typeof ComposioExecuteResponseSchema>

// ---------------------------------------------------------------------------
// Inputs (method arguments)
// ---------------------------------------------------------------------------

export interface ListToolkitsParams {
  readonly category?: string
  readonly managedBy?: 'composio' | 'all' | 'project'
  readonly limit?: number
  readonly cursor?: string
  /**
   * Free-text search forwarded to Composio's catalog. The Composio SDK
   * exposes the same field on `session.toolkits({ search })`, which
   * translates to a `?search=` query param on `/api/v3/toolkits`.
   * Used by the gateway's paginated `/api/v1/connectors?source=composio&search=`
   * passthrough so the modal doesn't have to load the full 1000-toolkit
   * catalog client-side.
   */
  readonly search?: string
}

export interface ListAuthConfigsParams {
  readonly toolkitSlug?: string
  readonly isComposioManaged?: boolean
  readonly showDisabled?: boolean
  readonly limit?: number
  readonly cursor?: string
}

export interface ListConnectedAccountsParams {
  readonly userId?: string
  readonly authConfigId?: string
  readonly toolkitSlug?: string
  readonly status?: ComposioConnectedAccountStatus
  readonly limit?: number
  readonly cursor?: string
}

export interface CreateConnectionLinkInput {
  readonly authConfigId: string
  readonly userId: string
  readonly callbackUrl?: string
  readonly alias?: string
  readonly connectionData?: Record<string, unknown>
}

export interface ListToolsParams {
  readonly toolkitSlug?: string
  readonly search?: string
  readonly limit?: number
  readonly cursor?: string
}

export interface ExecuteToolInput {
  readonly connectedAccountId?: string
  readonly userId?: string
  readonly arguments?: Record<string, unknown>
  readonly version?: string
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface ComposioClientOptions {
  readonly apiKey: string
  /** Defaults to `https://backend.composio.dev`. Override for tests. */
  readonly baseUrl?: string
  /** Per-attempt timeout ms. Default 30_000. */
  readonly timeoutMs?: number
  /** Max GET retries. Default 3. */
  readonly maxRetries?: number
  /** Test seam: fetch implementation. Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch
  /** Test seam: sleep used between retries. */
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULT_BASE_URL = 'https://backend.composio.dev'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 3

const ERROR_CTX_SOURCE = 'composio'

/**
 * Detect Composio's user-scoped CLI key (`uak_<...>`), which lives in
 * `~/.composio/user_data.json` after a user runs `composio login`.
 *
 * These keys authenticate the user's CLI session — they return 401
 * against the SDK / v3 API endpoints we use. If a user pastes one as
 * `COMPOSIO_API_KEY` thinking it's the project key, every call from
 * sync / connect / executeTool 401s silently (sync's catch returns
 * `null`, hiding the misconfig) and Composio appears broken with no
 * surfaced cause.
 *
 * The fix path: ask the user for the project-scoped `ak_<...>` key
 * minted by `composio dev init` (Composio dashboard → API keys).
 *
 * Returns true for known-bad keys; otherwise false. Conservative on
 * unknown shapes (returns false) so we never reject a valid key whose
 * prefix we don't recognize.
 */
export function isLikelyUserScopedComposioKey(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  return /^uak_[A-Za-z0-9_-]+/.test(value.trim())
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ComposioClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly sleepImpl: (ms: number) => Promise<void>

  constructor(opts: ComposioClientOptions) {
    if (typeof opts.apiKey !== 'string' || opts.apiKey.trim().length === 0) {
      throw new ConnectorNotConfiguredError(
        'Composio API key is required.',
        { source: ERROR_CTX_SOURCE },
      )
    }
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES)
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.sleepImpl =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Never include the API key in logs. */
  toString(): string {
    return `ComposioClient(${this.baseUrl})`
  }

  // ── 1. List toolkits ────────────────────────────────────────────────
  async listToolkits(params: ListToolkitsParams = {}): Promise<z.infer<typeof ComposioToolkitListSchema>> {
    const qs = new URLSearchParams()
    if (params.category) qs.set('category', params.category)
    if (params.managedBy) qs.set('managed_by', params.managedBy)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.search !== undefined && params.search.length > 0) qs.set('search', params.search)
    return this.requestJson('GET', `/api/v3/toolkits${qstr(qs)}`, ComposioToolkitListSchema)
  }

  // ── 2. Get toolkit ──────────────────────────────────────────────────
  async getToolkit(slug: string): Promise<ComposioToolkitDetail> {
    if (!slug) throw new ConnectorValidationError('toolkit slug is required', { source: ERROR_CTX_SOURCE })
    return this.requestJson(
      'GET',
      `/api/v3/toolkits/${encodeURIComponent(slug)}`,
      ComposioToolkitDetailSchema,
    )
  }

  // ── 3. List auth configs ────────────────────────────────────────────
  async listAuthConfigs(params: ListAuthConfigsParams = {}): Promise<z.infer<typeof ComposioAuthConfigListSchema>> {
    const qs = new URLSearchParams()
    if (params.toolkitSlug) qs.set('toolkit_slug', params.toolkitSlug)
    if (params.isComposioManaged !== undefined) qs.set('is_composio_managed', String(params.isComposioManaged))
    if (params.showDisabled !== undefined) qs.set('show_disabled', String(params.showDisabled))
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    return this.requestJson('GET', `/api/v3/auth_configs${qstr(qs)}`, ComposioAuthConfigListSchema)
  }

  // ── 4. Get auth config ──────────────────────────────────────────────
  async getAuthConfig(id: string): Promise<ComposioAuthConfig> {
    if (!id) throw new ConnectorValidationError('auth_config_id is required', { source: ERROR_CTX_SOURCE })
    return this.requestJson(
      'GET',
      `/api/v3/auth_configs/${encodeURIComponent(id)}`,
      ComposioAuthConfigSchema,
    )
  }

  // ── 5. Create connection link (POST — not retried) ──────────────────
  async createConnectionLink(input: CreateConnectionLinkInput): Promise<ComposioConnectionLink> {
    if (!input.authConfigId) {
      throw new ConnectorValidationError('auth_config_id is required', { source: ERROR_CTX_SOURCE })
    }
    if (!input.userId) {
      throw new ConnectorValidationError('user_id is required', { source: ERROR_CTX_SOURCE })
    }
    const body: Record<string, unknown> = {
      auth_config_id: input.authConfigId,
      user_id: input.userId,
    }
    if (input.callbackUrl !== undefined) body.callback_url = input.callbackUrl
    if (input.alias !== undefined) body.alias = input.alias
    if (input.connectionData !== undefined) body.connection_data = input.connectionData
    return this.requestJson(
      'POST',
      '/api/v3/connected_accounts/link',
      ComposioConnectionLinkSchema,
      { body },
    )
  }

  // ── 6. Get connected account ────────────────────────────────────────
  async getConnectedAccount(id: string): Promise<ComposioConnectedAccount> {
    if (!id) throw new ConnectorValidationError('connected_account_id is required', { source: ERROR_CTX_SOURCE })
    return this.requestJson(
      'GET',
      `/api/v3/connected_accounts/${encodeURIComponent(id)}`,
      ComposioConnectedAccountSchema,
    )
  }

  /**
   * Revoke a connected account — Composio deletes its stored token
   * and the downstream service (Gmail, Slack, …) no longer honours
   * it. Used by the in-app Disconnect action so users don't have to
   * open Composio's dashboard.
   *
   * Treated as non-idempotent at the HTTP layer (no retry) because
   * DELETE on `/connected_accounts/:id` can surface different 4xx
   * outcomes that shouldn't be auto-replayed. A 404 is tolerated
   * explicitly — if Composio already lost track of the connection,
   * revoking again is a no-op, not a user-facing error.
   */
  async deleteConnectedAccount(id: string): Promise<void> {
    if (!id) throw new ConnectorValidationError('connected_account_id is required', { source: ERROR_CTX_SOURCE })
    const res = await this.rawRequest(
      'DELETE',
      `/api/v3/connected_accounts/${encodeURIComponent(id)}`,
      undefined,
    )
    if (res.ok) return
    if (res.status === 404) return // already gone — treat as success
    const errorBody = (await safeJson(res).catch(() => null)) as unknown
    const message = extractErrorMessage(errorBody)
      ?? `DELETE /connected_accounts/${id} failed with HTTP ${res.status.toString()}`
    const baseCtx: ConnectorErrorContext = { source: ERROR_CTX_SOURCE }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthExpiredError(message, baseCtx)
    }
    if (res.status >= 400 && res.status < 500) {
      throw new ConnectorValidationError(message, baseCtx)
    }
    throw new ConnectorVendorError(message, { ...baseCtx, statusCode: res.status })
  }

  // ── 7. List connected accounts ──────────────────────────────────────
  async listConnectedAccounts(
    params: ListConnectedAccountsParams = {},
  ): Promise<z.infer<typeof ComposioConnectedAccountListSchema>> {
    const qs = new URLSearchParams()
    if (params.userId) qs.set('user_id', params.userId)
    if (params.authConfigId) qs.set('auth_config_ids', params.authConfigId)
    if (params.toolkitSlug) qs.set('toolkit_slugs', params.toolkitSlug)
    if (params.status) qs.set('statuses', params.status)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    return this.requestJson(
      'GET',
      `/api/v3/connected_accounts${qstr(qs)}`,
      ComposioConnectedAccountListSchema,
    )
  }

  // ── 8. List tools ───────────────────────────────────────────────────
  async listTools(params: ListToolsParams = {}): Promise<z.infer<typeof ComposioToolListSchema>> {
    const qs = new URLSearchParams()
    if (params.toolkitSlug) qs.set('toolkit_slug', params.toolkitSlug)
    if (params.search) qs.set('search', params.search)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    if (params.cursor) qs.set('cursor', params.cursor)
    return this.requestJson('GET', `/api/v3/tools${qstr(qs)}`, ComposioToolListSchema)
  }

  // ── 9. Get tool ─────────────────────────────────────────────────────
  async getTool(slug: string): Promise<ComposioTool> {
    if (!slug) throw new ConnectorValidationError('tool slug is required', { source: ERROR_CTX_SOURCE })
    return this.requestJson(
      'GET',
      `/api/v3/tools/${encodeURIComponent(slug)}`,
      ComposioToolSchema,
    )
  }

  // ── 10. Execute tool (POST — not retried) ───────────────────────────
  async executeTool(
    slug: string,
    input: ExecuteToolInput = {},
  ): Promise<ComposioExecuteResponse> {
    if (!slug) throw new ConnectorValidationError('tool slug is required', { source: ERROR_CTX_SOURCE })
    const body: Record<string, unknown> = {}
    if (input.connectedAccountId !== undefined) body.connected_account_id = input.connectedAccountId
    if (input.userId !== undefined) body.user_id = input.userId
    if (input.arguments !== undefined) body.arguments = input.arguments
    if (input.version !== undefined) body.version = input.version
    return this.requestJson(
      'POST',
      `/api/v3/tools/execute/${encodeURIComponent(slug)}`,
      ComposioExecuteResponseSchema,
      { body },
    )
  }

  // ── 11. Get session info (current project + org identity) ──────────
  /**
   * Fetches the calling project's identity (org slug + project slug) from
   * `/api/v3/auth/session/info`. Used at boot to build the Composio
   * dashboard deep-link base URL (`platform.composio.dev/<org>/<proj>`).
   *
   * This is the only Composio endpoint that accepts a project API key
   * and returns the org/project `name` fields that the platform UI uses
   * as URL segments. Verified 2026-04-13 via live curl.
   */
  async getSessionInfo(): Promise<ComposioSessionInfo> {
    return this.requestJson(
      'GET',
      '/api/v3/auth/session/info',
      ComposioSessionInfoSchema,
    )
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async requestJson<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: T,
    opts: { body?: unknown } = {},
  ): Promise<z.infer<T>> {
    const isIdempotent = method === 'GET'
    const attempts = isIdempotent ? this.maxRetries + 1 : 1
    let lastErr: unknown

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.rawRequest(method, path, opts.body)
        if (res.ok) {
          const json = (await safeJson(res)) as unknown
          const parsed = schema.safeParse(json)
          if (!parsed.success) {
            throw new ConnectorVendorError(
              `Composio returned an unexpected shape for ${method} ${path}: ${parsed.error.message}`,
              { source: ERROR_CTX_SOURCE, cause: parsed.error },
            )
          }
          return parsed.data as z.infer<T>
        }
        // Non-OK: classify.
        const errorBody = (await safeJson(res).catch(() => null)) as unknown
        const message = extractErrorMessage(errorBody) ?? `${method} ${path} failed with HTTP ${res.status}`
        const baseCtx: ConnectorErrorContext = { source: ERROR_CTX_SOURCE }
        if (res.status === 401 || res.status === 403) {
          throw new ConnectorAuthExpiredError(message, baseCtx)
        }
        if (res.status === 429) {
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
          const rlErr = new ConnectorRateLimitedError(message, {
            ...baseCtx,
            ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
          })
          if (isIdempotent && attempt < attempts - 1) {
            lastErr = rlErr
            await this.sleepImpl(
              retryAfter ?? backoffDelayMs(attempt),
            )
            continue
          }
          throw rlErr
        }
        if (res.status >= 400 && res.status < 500) {
          throw new ConnectorValidationError(message, baseCtx)
        }
        // 5xx
        const vendorErr = new ConnectorVendorError(message, {
          ...baseCtx,
          statusCode: res.status,
        })
        if (isIdempotent && attempt < attempts - 1) {
          lastErr = vendorErr
          await this.sleepImpl(backoffDelayMs(attempt))
          continue
        }
        throw vendorErr
      } catch (err) {
        if (
          err instanceof ConnectorAuthExpiredError ||
          err instanceof ConnectorValidationError
        ) {
          throw err
        }
        if (err instanceof ConnectorRateLimitedError) {
          // Already handled above — only falls through on non-idempotent.
          throw err
        }
        if (err instanceof ConnectorVendorError) {
          // Already handled above — falls through on non-idempotent or
          // Zod-shape mismatch (which we never retry).
          throw err
        }
        // Network / abort / fetch throw.
        const netMessage = err instanceof Error ? err.message : String(err)
        const netErr = new ConnectorNetworkError(
          `Composio network error on ${method} ${path}: ${netMessage}`,
          { source: ERROR_CTX_SOURCE, cause: err },
        )
        if (isIdempotent && attempt < attempts - 1) {
          lastErr = netErr
          await this.sleepImpl(backoffDelayMs(attempt))
          continue
        }
        throw netErr
      }
    }
    // Should never reach — loop always returns or throws. Safety net:
    throw lastErr instanceof Error
      ? lastErr
      : new ConnectorNetworkError(
          `Composio request exhausted retries for ${method} ${path}`,
          { source: ERROR_CTX_SOURCE },
        )
  }

  private async rawRequest(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const init: RequestInit = {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: controller.signal,
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      return await this.fetchImpl(url, init)
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qstr(qs: URLSearchParams): string {
  const s = qs.toString()
  return s.length === 0 ? '' : `?${s}`
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

function extractErrorMessage(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const bag = body as Record<string, unknown>
  const candidates = [bag.message, bag.error, bag.detail]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
    if (c && typeof c === 'object') {
      const nested = (c as Record<string, unknown>).message
      if (typeof nested === 'string' && nested.length > 0) return nested
    }
  }
  return null
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const dateMs = Date.parse(header)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now()
    return delta > 0 ? delta : 0
  }
  return undefined
}

function backoffDelayMs(attempt: number): number {
  const base = 500 * Math.pow(2, attempt)
  return Math.min(base, 8_000)
}
