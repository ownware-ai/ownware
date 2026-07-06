/**
 * Unified credential-store HTTP handlers (board: credentials-unification —
 * C07, C08).
 *
 * Three endpoints in this file. They REPLACE the legacy
 * `handlers/credentials.ts` `listAll` + `remove` exports (which read /
 * wrote the on-disk file vault directly). The HITL `respond` / `deny` /
 * per-thread `list` exports in that file stay — they belong to the
 * runtime-credential-request flow, not the unified store.
 *
 *   GET    /api/v1/credentials             — list (filtered, masked)
 *   GET    /api/v1/credentials/:id         — single (metadata only)
 *   DELETE /api/v1/credentials/:id         — hard-delete (Phase 3 scope)
 *
 * Wire shape: the response body for list / get is `Credential[]` and
 * `Credential` per `credential/schema.ts` — never the plaintext value,
 * never the encrypted ciphertext, never any field beyond what the
 * schema permits. The store enforces this at every read site; the
 * handler is a thin pass-through.
 *
 * The PATCH / POST / soft-delete-with-?hard=true paths land in C12–C14
 * (Phase 4 of the board). When they do, they extend this file, not a
 * new one — every credentials handler lives here so the surface stays
 * one grep away.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  CredentialAuthTypeSchema,
  CredentialCategorySchema,
  CredentialSourceSchema,
  CredentialStatusSchema,
  CredentialTrustSchema,
  SpendCapSchema,
  isCredentialId,
  type Credential,
} from '../../credential/schema.js'
import type { CredentialAuditLog } from '../../credential/audit.js'
import type {
  CredentialSaveInput,
  CredentialUpdateInput,
} from '../../credential/store/types.js'
import type { CredentialStore } from '../../credential/store/index.js'
import { credentialVault } from '../../connector/credentials/vault.js'
import {
  ApprovalResponseBodySchema,
  type TrustGate,
} from '../../credential/trust-gate.js'
import type { CredentialEventBus } from '../credential-event-bus.js'
import { readJSON, sendError, sendJSON } from '../router.js'

// ---------------------------------------------------------------------------
// File-vault cascade
// ---------------------------------------------------------------------------

/**
 * Keep the legacy file vault in sync after a `category: 'mcp-server'`
 * row is removed from the unified credentials table. Required during
 * the credentials-unification transition (D8 chunks D+E not yet
 * shipped) because:
 *
 *   - The unified table is the user-visible Settings → Credentials surface.
 *   - The file vault is what `connector/registry.ts:checkEnvVars` and
 *     the `mcp.ts` handlers still consult for runtime status, OAuth
 *     bundles, and tool execution.
 *
 * Without this cascade, "Disconnect" in Settings → Credentials deletes
 * the SQL row but leaves the encrypted bundle on disk — the connector
 * still resolves to `'ready'` and tools keep working with the
 * supposedly-deleted credential. The fix until readers/writers fully
 * switch to the unified store: when a single env-var row is removed,
 * remove that var from the on-disk bundle. When the connector's last
 * row is removed, delete the file outright.
 *
 * Failure handling: vault errors are logged and swallowed. The SQL
 * delete already succeeded; refusing to ack the HTTP response because
 * the on-disk cleanup hiccupped would surface a confusing 500 to the
 * user. The next gateway boot's evergreen importer would re-import the
 * orphaned file, putting the system back into a deterministic state.
 */
async function cascadeFileVaultDelete(
  removed: Pick<Credential, 'category' | 'forConnector' | 'variableName'>,
  log: (message: string) => void,
): Promise<void> {
  if (
    removed.category !== 'mcp-server' ||
    typeof removed.forConnector !== 'string' ||
    removed.forConnector.length === 0
  ) {
    return
  }
  const connectorId = removed.forConnector
  const variableName = removed.variableName

  try {
    const bundle = await credentialVault.load(connectorId)
    if (bundle === null) return

    if (typeof variableName === 'string' && variableName.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure to drop the deleted var
      const { [variableName]: _dropped, ...remaining } = bundle.env
      if (Object.keys(remaining).length === 0) {
        await credentialVault.delete(connectorId)
      } else {
        await credentialVault.save(connectorId, remaining)
      }
      return
    }

    // Edge case: row missing variableName (shouldn't happen for
    // mcp-server rows in practice). Conservative fallback: nuke the
    // whole file so the file vault doesn't outlive the SQL state.
    await credentialVault.delete(connectorId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`[credentials] file-vault cascade-delete failed for "${connectorId}": ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Query params for the list endpoint. Every field is optional; absent
 * means "no filter on this dimension". `?includeRevoked=true` is the
 * only way to get soft-deleted rows in the response — Settings UI omits
 * it, audit-log UI sets it.
 *
 * `tag` is a free-form string already validated as a `Tag` shape by the
 * schema's regex; we pass it through and rely on the schema's row-level
 * tag check to keep the result tight.
 */
const ListQuerySchema = z
  .object({
    category: CredentialCategorySchema.optional(),
    forConnector: z.string().min(1).max(256).optional(),
    tag: z.string().min(1).max(64).optional(),
    includeRevoked: z
      .union([z.literal('true'), z.literal('false')])
      .transform(v => v === 'true')
      .optional(),
  })
  .strict()
type ListQuery = z.infer<typeof ListQuerySchema>

// ---------------------------------------------------------------------------
// Body schemas — POST + PATCH
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/credentials` body. Mirrors the store's
 * `CredentialSaveInput` shape with HTTP-friendly validation. The
 * `superRefine` on the underlying `CredentialSchema` runs at the
 * STORE boundary; this surface enforces the create-time invariants
 * (api-key authType requires variableName; spendCap is LLM-only) so
 * we send a meaningful 400 instead of a generic schema error from
 * the inner parse.
 */
const CreateBodySchema = z
  .object({
    name: z.string().min(1).max(128),
    value: z.string().min(1),
    category: CredentialCategorySchema,
    authType: CredentialAuthTypeSchema,
    variableName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
        message: 'variableName must match /^[A-Za-z_][A-Za-z0-9_]*$/',
      })
      .optional(),
    forConnector: z.string().min(1).max(256).optional(),
    trust: CredentialTrustSchema.optional(),
    spendCap: SpendCapSchema.optional(),
    source: CredentialSourceSchema.default('manual'),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      )
      .max(32)
      .optional(),
    grantedScopes: z.array(z.string().min(1).max(256)).max(256).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (
      (body.authType === 'api-key' || body.authType === 'bearer-token') &&
      body.variableName === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variableName'],
        message: `variableName is required when authType is "${body.authType}"`,
      })
    }
    if (body.spendCap !== undefined && body.category !== 'llm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spendCap'],
        message: 'spendCap is only valid when category === "llm"',
      })
    }
  })

/**
 * `PATCH /api/v1/credentials/:id` body. Tri-state semantics:
 *
 *   - field absent (`undefined`) → leave unchanged
 *   - field present, value-shaped → set to that value
 *   - field present, `null`        → clear / unset
 *
 * Only fields that are mutable post-create are listed. To rotate the
 * value, pass `value`. To soft-delete via PATCH, pass
 * `status: 'revoked'` with a `statusReason` (the bare DELETE endpoint
 * is the more direct path; this exists for the audit-edit flow).
 */
const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    value: z.string().min(1).optional(),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      )
      .max(32)
      .optional(),
    trust: CredentialTrustSchema.optional(),
    spendCap: SpendCapSchema.nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    status: CredentialStatusSchema.optional(),
    statusReason: z.string().min(1).max(512).nullable().optional(),
    grantedScopes: z.array(z.string().min(1).max(256)).max(256).nullable().optional(),
    lastUsedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine(body => Object.keys(body).length > 0, {
    message: 'At least one field is required for PATCH.',
  })

const RevealBodySchema = z
  .object({
    /**
     * Explicit user confirmation. Set this to `true` from a UI that
     * just showed the user a "Reveal will display the value once" prompt.
     * Reject any payload without it so a CSRF / accidental call cannot
     * exfiltrate the value.
     */
    confirm: z.literal(true),
  })
  .strict()

const DeleteQuerySchema = z
  .object({
    hard: z
      .union([z.literal('true'), z.literal('false')])
      .transform(v => v === 'true')
      .optional(),
    /**
     * Optional human-readable reason saved on the soft-deleted row's
     * `statusReason`. Defaults to a generic "user removed" string when
     * absent. Has no effect on hard-delete.
     */
    reason: z.string().min(1).max(512).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// Validate (C15) — provider-specific live check
// ---------------------------------------------------------------------------

const VALIDATE_TIMEOUT_MS = 10_000

/**
 * Real provider call for LLM keys. Mirrors the timeout +
 * 401-distinguishing logic in `handlers/providers.ts` so the legacy
 * Brains validate flow and the new unified validate produce the
 * same verdict for the same key. Other categories return `ok: true`
 * after a successful decrypt — full provider-specific validation for
 * tool/oauth/mcp credentials is out of scope for Phase 4.
 */
async function validateLlmKey(
  variableName: string,
  value: string,
): Promise<{ ok: boolean; error?: string; grantedScopes?: readonly string[] }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
  try {
    if (variableName === 'ANTHROPIC_API_KEY') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': value,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      })
      if (response.status === 401) return { ok: false, error: 'Invalid API key' }
      return { ok: true }
    }
    if (variableName === 'OPENAI_API_KEY') {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${value}` },
      })
      if (response.status === 401) return { ok: false, error: 'Invalid API key' }
      return { ok: true }
    }
    if (variableName === 'GOOGLE_API_KEY' || variableName === 'GEMINI_API_KEY') {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`,
        { method: 'GET', signal: controller.signal },
      )
      if (response.status === 400 || response.status === 403) {
        return { ok: false, error: 'Invalid API key' }
      }
      return { ok: true }
    }
    if (variableName === 'OPENROUTER_API_KEY') {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${value}` },
      })
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'Invalid API key' }
      }
      return { ok: true }
    }
    // Unknown LLM env var — treat as a credential we can't actively
    // validate but whose decrypt succeeded.
    return { ok: true }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Validation timed out' }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Validation failed' }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Composio key validator — `GET /api/v3/auth/session/info` is the
 * lightest authenticated probe Composio exposes. 401/403 → bad key.
 * Same endpoint server.ts uses to resolve the dashboard deep-link,
 * so a green verdict here means every subsequent runtime call will
 * also authenticate.
 *
 * Defensive: a `uak_*` CLI key authenticates against `/auth/session/info`
 * but fails every other SDK call — gateway logic already rejects this
 * shape in `resolveComposioKey()`. Apply the same rejection here so
 * the user sees the same actionable error at paste time.
 */
async function validateComposioKey(
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  if (value.startsWith('uak_')) {
    return {
      ok: false,
      error:
        'Looks like a user-scoped CLI key (uak_…). Composio needs a project-scoped key (ak_… or cs_…) from dashboard.composio.dev → Settings → API Keys.',
    }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
  try {
    const response = await fetch('https://backend.composio.dev/api/v3/auth/session/info', {
      method: 'GET',
      signal: controller.signal,
      headers: { 'x-api-key': value },
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'Composio rejected this key' }
    }
    if (!response.ok) {
      return { ok: false, error: `Composio returned HTTP ${response.status}` }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Composio did not respond within 10s' }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Validation failed' }
  } finally {
    clearTimeout(timeout)
  }
}

async function validateCredentialValue(
  credential: Credential,
  value: string,
): Promise<{ ok: boolean; error?: string; grantedScopes?: readonly string[] }> {
  if (credential.category === 'llm' && credential.variableName !== undefined) {
    return validateLlmKey(credential.variableName, value)
  }
  if (
    credential.category === 'tool' &&
    credential.variableName === 'COMPOSIO_API_KEY'
  ) {
    return validateComposioKey(value)
  }
  // Other non-LLM credentials: a successful decrypt is the only
  // structural check available today. Future per-source validators
  // (OAuth /userinfo probe, MCP handshake, etc.) land here.
  return { ok: true }
}

/**
 * Build a `URLSearchParams` view of the request. URL is parsed once;
 * the helper exists so the handler reads cleanly. Returns `null` if
 * the URL is malformed — the dispatcher above this handler already
 * parses URLs successfully, so this is defense in depth, not a
 * realistic path in production.
 */
function readQuery(req: IncomingMessage): URLSearchParams | null {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams
  } catch {
    return null
  }
}

/**
 * Convert a `URLSearchParams` instance into an object suitable for
 * `ListQuerySchema.safeParse`. Empty-string values are dropped so
 * `?category=` (typo) does not silently filter to "category equals
 * empty string". Only the FIRST occurrence of a duplicated key is
 * honoured — multi-value query semantics aren't part of this API.
 */
function queryToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    if (value.length === 0) continue
    if (key in out) continue
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

type ParamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>
type SimpleHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * Optional dependencies for the unified credential handlers. Phase 4
 * shipped without these; Phase 5 added the audit log + trust gate so
 * the handlers can record audit rows + serve trust-gate approvals.
 *
 * Both fields are optional so existing tests can construct the
 * handler factory without seeding the modules — production wiring
 * passes both. When `audit` is omitted, validate/reveal silently skip
 * the audit write (matches Phase 4 console-only behaviour). When
 * `trustGate` is omitted, the approve handler returns 503 with a
 * "trust gate not configured" message — non-fatal for callers that
 * don't use trust:high.
 */
export interface CredentialStoreHandlerDeps {
  readonly audit?: CredentialAuditLog
  readonly trustGate?: TrustGate
  /**
   * Fan-out bus for credential CRUD events (audit #5 H1, 2026-05-16).
   * When provided, the handlers emit a `credential.changed` event on
   * every successful create / update / delete / validate so SSE
   * subscribers can invalidate their caches without polling.
   *
   * Optional so the dozens of existing unit tests that don't care
   * about live events keep compiling. Production wiring in
   * `server.ts` always passes a real bus.
   */
  readonly eventBus?: CredentialEventBus
}

export function createCredentialStoreHandlers(
  store: CredentialStore,
  deps: CredentialStoreHandlerDeps = {},
): {
  readonly list: SimpleHandler
  readonly getOne: ParamHandler
  readonly create: SimpleHandler
  readonly update: ParamHandler
  readonly remove: ParamHandler
  readonly validate: ParamHandler
  readonly reveal: ParamHandler
  readonly approve: ParamHandler
} {
  const audit = deps.audit
  const trustGate = deps.trustGate
  const eventBus = deps.eventBus
  // -------------------------------------------------------------------------
  // GET /api/v1/credentials
  // -------------------------------------------------------------------------
  async function list(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const search = readQuery(req)
    if (search === null) {
      sendError(res, 400, 'Could not parse request URL.')
      return
    }

    const queryObject = queryToObject(search)
    const parsed = ListQuerySchema.safeParse(queryObject)
    if (!parsed.success) {
      const message = parsed.error.errors
        .map(e => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ')
      sendError(res, 400, `Invalid query: ${message}`)
      return
    }
    const filter: ListQuery = parsed.data

    let credentials
    try {
      credentials = await store.list(filter)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential list failed: ${message}`)
      return
    }

    sendJSON(res, 200, { credentials })
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/credentials/:id
  // -------------------------------------------------------------------------
  async function getOne(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0) {
      sendError(res, 400, 'Path parameter "id" is required.')
      return
    }
    if (!isCredentialId(id)) {
      sendError(res, 400, `Path parameter "id" is not a valid credential id.`)
      return
    }

    let credential
    try {
      credential = await store.get(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential lookup failed: ${message}`)
      return
    }

    if (credential === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return
    }

    sendJSON(res, 200, { credential })
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/credentials                                            (C12)
  // -------------------------------------------------------------------------
  async function create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = await readJSON<unknown>(req)
    } catch {
      sendError(res, 400, 'Could not parse request body as JSON.')
      return
    }
    const parsed = CreateBodySchema.safeParse(body)
    if (!parsed.success) {
      const message = parsed.error.errors
        .map(e => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ')
      sendError(res, 400, `Invalid body: ${message}`)
      return
    }
    const input = parsed.data

    // Conflict check — POST refuses to silently shadow an existing
    // credential that occupies the same (category, variableName) slot.
    // The unified resolver looks up by name; a duplicate would create
    // ordering ambiguity. PATCH is the rotate-the-value path.
    if (input.variableName !== undefined) {
      const conflict = (
        await store.list({ category: input.category, includeRevoked: true })
      ).find(c => c.variableName === input.variableName)
      if (conflict !== undefined) {
        sendError(
          res,
          409,
          `A ${input.category} credential with variableName "${input.variableName}" already exists (id ${conflict.id}). PATCH that row to rotate its value.`,
        )
        return
      }
    }

    const saveInput: CredentialSaveInput = {
      name: input.name,
      value: input.value,
      category: input.category,
      authType: input.authType,
      source: input.source,
      ...(input.variableName !== undefined ? { variableName: input.variableName } : {}),
      ...(input.forConnector !== undefined ? { forConnector: input.forConnector } : {}),
      ...(input.trust !== undefined ? { trust: input.trust } : {}),
      ...(input.spendCap !== undefined ? { spendCap: input.spendCap } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.grantedScopes !== undefined ? { grantedScopes: input.grantedScopes } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    }

    let credential
    try {
      credential = await store.save(saveInput)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential save failed: ${message}`)
      return
    }

    audit?.recordEvent({
      credentialId: credential.id,
      eventType: 'create',
      outcome: 'ok',
      detail: { source: credential.source, category: credential.category },
    })

    // Fan-out hint AFTER the row is durable. Invalidate-only — payload
    // never carries the value. Audit #5 H1, 2026-05-16.
    eventBus?.emit({ credentialId: credential.id, action: 'created' })

    sendJSON(res, 201, { credential })
  }

  // -------------------------------------------------------------------------
  // PATCH /api/v1/credentials/:id                                       (C13)
  // -------------------------------------------------------------------------
  async function update(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, `Path parameter "id" is not a valid credential id.`)
      return
    }
    let body: unknown
    try {
      body = await readJSON<unknown>(req)
    } catch {
      sendError(res, 400, 'Could not parse request body as JSON.')
      return
    }
    const parsed = PatchBodySchema.safeParse(body)
    if (!parsed.success) {
      const message = parsed.error.errors
        .map(e => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ')
      sendError(res, 400, `Invalid body: ${message}`)
      return
    }
    const patch = parsed.data

    // Pass through to the store. The store's `CredentialUpdateInput`
    // already encodes the same tri-state (undefined/null/value), so
    // the mapping is mechanical — but we explicitly construct it
    // rather than spread the parsed body so a future Zod field that
    // doesn't belong in the patch input fails the typecheck here,
    // not silently flows into the SQL UPDATE.
    const updateInput: CredentialUpdateInput = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.value !== undefined ? { value: patch.value } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.trust !== undefined ? { trust: patch.trust } : {}),
      ...(patch.spendCap !== undefined ? { spendCap: patch.spendCap } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.statusReason !== undefined ? { statusReason: patch.statusReason } : {}),
      ...(patch.grantedScopes !== undefined ? { grantedScopes: patch.grantedScopes } : {}),
      ...(patch.lastUsedAt !== undefined ? { lastUsedAt: patch.lastUsedAt } : {}),
    }

    let credential
    try {
      credential = await store.update(id, updateInput)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential update failed: ${message}`)
      return
    }
    if (credential === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return
    }
    audit?.recordEvent({
      credentialId: credential.id,
      eventType: 'update',
      outcome: 'ok',
      detail: {
        rotated: patch.value !== undefined,
        statusChanged: patch.status !== undefined,
      },
    })
    eventBus?.emit({ credentialId: credential.id, action: 'updated' })
    sendJSON(res, 200, { credential })
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/credentials/:id                                      (C14)
  //
  // Default = soft-delete (status: 'revoked'). `?hard=true` purges the
  // row from the table for good. Soft-delete keeps the row visible to
  // `?includeRevoked=true` callers (audit views), so a user can see
  // when something was removed and by what reason.
  // -------------------------------------------------------------------------
  async function remove(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, `Path parameter "id" is not a valid credential id.`)
      return
    }

    const search = readQuery(req)
    if (search === null) {
      sendError(res, 400, 'Could not parse request URL.')
      return
    }
    const queryParsed = DeleteQuerySchema.safeParse(queryToObject(search))
    if (!queryParsed.success) {
      const message = queryParsed.error.errors
        .map(e => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ')
      sendError(res, 400, `Invalid query: ${message}`)
      return
    }
    const hard = queryParsed.data.hard === true
    const reason = queryParsed.data.reason ?? 'user removed'

    // Read the credential BEFORE the delete so the file-vault cascade
    // (below) has access to `category` / `forConnector` / `variableName`
    // — fields the SQL row carries but a 404-style "id gone" wouldn't.
    // Hard-delete wipes the row entirely; soft-delete keeps it but a
    // single .get() up front is cheaper than reasoning about timing.
    const beforeDelete = await store.get(id)

    if (hard) {
      // Audit BEFORE the delete — once the row is gone, the FK cascade
      // also wipes its audit history. Recording the delete event in
      // advance preserves the "this credential was hard-deleted at
      // T" line ONLY if the audit row is recorded against a different
      // entity (we don't have that table yet — Phase 5 records inline
      // and accepts that hard-delete loses the audit trail along with
      // the row).
      audit?.recordEvent({
        credentialId: id,
        eventType: 'delete',
        outcome: 'ok',
        detail: { hard: true, reason },
      })
      let removed: boolean
      try {
        removed = await store.delete(id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendError(res, 500, `Credential delete failed: ${message}`)
        return
      }
      if (!removed) {
        sendError(res, 404, `No credential with id "${id}".`)
        return
      }
      if (beforeDelete !== null) {
        await cascadeFileVaultDelete(beforeDelete, (msg) => console.log(msg))
      }
      eventBus?.emit({ credentialId: id, action: 'deleted' })
      sendJSON(res, 200, { deleted: true, id, hard: true })
      return
    }

    // Soft-delete via update — status: revoked + statusReason. The
    // store's update returns null on unknown id, which is the same
    // 404 the hard path produces.
    let updated
    try {
      updated = await store.update(id, {
        status: 'revoked',
        statusReason: reason,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential soft-delete failed: ${message}`)
      return
    }
    if (updated === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return
    }
    audit?.recordEvent({
      credentialId: id,
      eventType: 'delete',
      outcome: 'ok',
      detail: { hard: false, reason },
    })
    if (beforeDelete !== null) {
      await cascadeFileVaultDelete(beforeDelete, (msg) => console.log(msg))
    }
    eventBus?.emit({ credentialId: id, action: 'deleted' })
    sendJSON(res, 200, { deleted: true, id, hard: false, credential: updated })
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/credentials/:id/validate                               (C15)
  //
  // Decrypts the credential and runs a real validator against the
  // provider. For LLM keys this hits the provider's API; for other
  // categories it confirms the row decrypts cleanly. Updates the
  // credential's `status` / `statusReason` based on the verdict so
  // the UI list reflects the latest health on the next list refetch.
  // -------------------------------------------------------------------------
  async function validate(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, `Path parameter "id" is not a valid credential id.`)
      return
    }

    let decrypted
    try {
      decrypted = await store.decrypt(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential decrypt failed: ${message}`)
      return
    }
    if (decrypted === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return
    }

    const verdict = await validateCredentialValue(decrypted.metadata, decrypted.value)

    // Persist the verdict on the credential so the next list refetch
    // shows the right status chip. Status transitions:
    //   ok  → status: ready, clear statusReason, set lastUsedAt
    //   bad → status: error, statusReason: <message>
    try {
      const nextStatus = verdict.ok ? 'ready' : 'error'
      const updateInput: CredentialUpdateInput = {
        status: nextStatus,
        statusReason: verdict.ok ? null : verdict.error ?? 'validation failed',
        lastUsedAt: new Date().toISOString(),
        ...(verdict.grantedScopes !== undefined
          ? { grantedScopes: verdict.grantedScopes }
          : {}),
      }
      await store.update(id, updateInput)
    } catch {
      // Status persistence is best-effort — the verdict is what the
      // caller needs back. A failed status update will be retried on
      // the next validate call.
    }

    audit?.recordEvent({
      credentialId: id,
      eventType: 'validate',
      outcome: verdict.ok ? 'ok' : 'error',
      detail: {
        ...(verdict.error !== undefined ? { error: verdict.error } : {}),
        ...(verdict.grantedScopes !== undefined ? { scopes: verdict.grantedScopes } : {}),
      },
    })

    // Validate mutates `status` / `statusReason` / `lastUsedAt` on the
    // row; fan-out so subscribers refetch the new health chip.
    eventBus?.emit({ credentialId: id, action: 'validated' })

    sendJSON(res, 200, {
      ok: verdict.ok,
      ...(verdict.error !== undefined ? { error: verdict.error } : {}),
      ...(verdict.grantedScopes !== undefined ? { grantedScopes: verdict.grantedScopes } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/credentials/:id/reveal                                 (C16)
  //
  // Returns the plaintext value ONCE per call. Phase 4 ships a basic
  // version: the body MUST carry `confirm: true` to defeat CSRF /
  // accidental fetch, and every reveal logs a console-audit line.
  // C30 will harden this with main-process HMAC-signed approval and
  // single-use tokens (per D10). Until then this endpoint is only as
  // safe as the localhost gateway boundary itself, which is the same
  // boundary a credential CREATE crosses.
  // -------------------------------------------------------------------------
  async function reveal(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, `Path parameter "id" is not a valid credential id.`)
      return
    }
    let body: unknown
    try {
      body = await readJSON<unknown>(req)
    } catch {
      sendError(res, 400, 'Could not parse request body as JSON.')
      return
    }
    const parsed = RevealBodySchema.safeParse(body)
    if (!parsed.success) {
      sendError(
        res,
        400,
        'Reveal requires { "confirm": true } in the body.',
      )
      return
    }

    let decrypted
    try {
      decrypted = await store.decrypt(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Credential decrypt failed: ${message}`)
      return
    }
    if (decrypted === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return
    }

    // Phase 5: structured audit row replaces the Phase-4 console line.
    // The UA + remote address (best-effort — the gateway binds to
    // 127.0.0.1, so this is the user's own machine) are the
    // correlation handles available without per-session ids; they
    // land in the `detail` JSON column.
    const ua = req.headers['user-agent'] ?? '<no-ua>'
    audit?.recordEvent({
      credentialId: id,
      eventType: 'reveal',
      outcome: 'ok',
      detail: { ua, name: decrypted.metadata.name },
    })

    sendJSON(res, 200, { value: decrypted.value })
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/credentials/:id/approve                                (C30)
  //
  // Renderer round-trips the (requestId, signature) pair from a
  // `credential.approval_required` SSE event. The gate verifies the
  // signature and resolves the blocked Promise on the resolver side.
  // The signature defeats forgery from inside loom — an agent cannot
  // produce a valid HMAC against the gate's per-launch key.
  // -------------------------------------------------------------------------
  async function approve(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    if (trustGate === undefined) {
      sendError(res, 503, 'Trust gate is not configured on this gateway.')
      return
    }
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, 'Path parameter "id" is not a valid credential id.')
      return
    }
    let body: unknown
    try {
      body = await readJSON<unknown>(req)
    } catch {
      sendError(res, 400, 'Could not parse request body as JSON.')
      return
    }
    const parsed = ApprovalResponseBodySchema.safeParse(body)
    if (!parsed.success) {
      const message = parsed.error.errors
        .map(e => `${e.path.join('.') || '<root>'}: ${e.message}`)
        .join('; ')
      sendError(res, 400, `Invalid body: ${message}`)
      return
    }

    const ok = trustGate.respond(parsed.data)
    if (!ok) {
      // The gate returns false for both "no such requestId" and
      // "bad signature" — the renderer should not be able to
      // distinguish (per the trust-gate doc).
      sendError(res, 404, 'Approval request not found or signature invalid.')
      return
    }
    audit?.recordEvent({
      credentialId: id,
      eventType: parsed.data.decision === 'granted' ? 'approval_granted' : 'approval_denied',
      outcome: parsed.data.decision === 'granted' ? 'ok' : 'denied',
      detail: { requestId: parsed.data.requestId },
    })
    sendJSON(res, 200, { ok: true })
  }

  return { list, getOne, create, update, remove, validate, reveal, approve }
}

// ---------------------------------------------------------------------------
// Audit / cost / usage handlers (C31-C33)
//
// Live in their own factory so existing tests that don't construct an
// audit module continue to compile. Production wiring constructs both
// factories and registers the routes side by side.
// ---------------------------------------------------------------------------

/**
 * Page params for `GET /credentials/:id/audit`. `limit` is bounded
 * server-side to 200; `offset` defaults to 0.
 */
const AuditQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(v => Number.parseInt(v, 10))
      .optional(),
    offset: z
      .string()
      .regex(/^\d+$/)
      .transform(v => Number.parseInt(v, 10))
      .optional(),
  })
  .strict()

const TimeRangeQuerySchema = z
  .object({
    /**
     * Window start as ISO 8601. Omit for "all time". The handler
     * parses to a Date and rejects malformed input with 400.
     */
    since: z.string().datetime({ offset: true }).optional(),
  })
  .strict()

export function createCredentialAuditHandlers(
  store: CredentialStore,
  audit: CredentialAuditLog,
): {
  readonly listAudit: ParamHandler
  readonly cost: ParamHandler
  readonly usage: ParamHandler
} {
  async function ensureCredentialExists(
    res: ServerResponse,
    id: string,
  ): Promise<boolean> {
    const cred = await store.get(id)
    if (cred === null) {
      sendError(res, 404, `No credential with id "${id}".`)
      return false
    }
    return true
  }

  async function listAudit(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, 'Path parameter "id" is not a valid credential id.')
      return
    }
    if (!(await ensureCredentialExists(res, id))) return

    const search = readQuery(req)
    if (search === null) {
      sendError(res, 400, 'Could not parse request URL.')
      return
    }
    const parsed = AuditQuerySchema.safeParse(queryToObject(search))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid pagination params (limit, offset must be integers).')
      return
    }

    try {
      const result = audit.listEventsForCredential(id, {
        ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
        ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
      })
      sendJSON(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Audit query failed: ${message}`)
    }
  }

  async function cost(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, 'Path parameter "id" is not a valid credential id.')
      return
    }
    if (!(await ensureCredentialExists(res, id))) return

    const search = readQuery(req)
    if (search === null) {
      sendError(res, 400, 'Could not parse request URL.')
      return
    }
    const parsed = TimeRangeQuerySchema.safeParse(queryToObject(search))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid query (since must be ISO 8601 with offset).')
      return
    }

    try {
      const result = audit.aggregateCost(id, {
        ...(parsed.data.since !== undefined ? { sinceIso: parsed.data.since } : {}),
      })
      sendJSON(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Cost aggregation failed: ${message}`)
    }
  }

  async function usage(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0 || !isCredentialId(id)) {
      sendError(res, 400, 'Path parameter "id" is not a valid credential id.')
      return
    }
    if (!(await ensureCredentialExists(res, id))) return

    const search = readQuery(req)
    if (search === null) {
      sendError(res, 400, 'Could not parse request URL.')
      return
    }
    const parsed = TimeRangeQuerySchema.safeParse(queryToObject(search))
    if (!parsed.success) {
      sendError(res, 400, 'Invalid query (since must be ISO 8601 with offset).')
      return
    }

    try {
      const result = audit.aggregateUsage(id, {
        ...(parsed.data.since !== undefined ? { sinceIso: parsed.data.since } : {}),
      })
      sendJSON(res, 200, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Usage aggregation failed: ${message}`)
    }
  }

  return { listAudit, cost, usage }
}
