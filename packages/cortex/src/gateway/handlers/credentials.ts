/**
 * Credential HITL endpoints.
 *
 *   POST /api/v1/threads/:threadId/credential
 *     Body: { requestId: string, value: string }
 *     Response: { credentialId, label }
 *
 *     Stores the value in the vault (encrypted), adds a handle to the
 *     per-thread runtime, and resolves the blocked `credentialHITL.request`
 *     Promise so the session's loop can resume. The plaintext value is
 *     touched only by the vault write — never logged, never persisted
 *     outside the encrypted blob, never returned in the response.
 *
 *   POST /api/v1/threads/:threadId/credential/deny
 *     Body: { requestId: string }
 *     Response: { denied: true, label }
 *
 *     Resolves the HITL Promise with `null`. The session's tool returns
 *     `{ status: "denied" }` and the agent can choose how to react.
 *
 * Both handlers are no-ops when no active HITL is waiting for the given
 * requestId — that can happen on timeout races (the HITL auto-denied
 * before the user's POST arrived), and must not become a crash path.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialHandle } from '@ownware/loom'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'
import {
  credentialVault as defaultCredentialVault,
  type CredentialVault,
} from '../../connector/credentials/vault.js'
import { makeRuntimeCredentialId } from '../../credential/runtime.js'

// ---------------------------------------------------------------------------
// Request + response shapes
// ---------------------------------------------------------------------------

interface CredentialRespondBody {
  readonly requestId: string
  readonly value: string
}

interface CredentialDenyBody {
  readonly requestId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal validation on the inbound body. The rest is handled by the
 * runtime (a bogus requestId returns 404; an inactive thread returns
 * 409). A missing or empty value is rejected early — we must not write
 * an empty credential to the vault.
 */
function validateRespondBody(body: unknown): CredentialRespondBody | { error: string } {
  if (body === null || typeof body !== 'object') {
    return { error: "Request body must be a JSON object." }
  }
  const b = body as Record<string, unknown>
  if (typeof b.requestId !== 'string' || b.requestId.length === 0) {
    return { error: "Field 'requestId' must be a non-empty string." }
  }
  if (typeof b.value !== 'string' || b.value.length === 0) {
    return { error: "Field 'value' must be a non-empty string." }
  }
  return { requestId: b.requestId, value: b.value }
}

function validateDenyBody(body: unknown): CredentialDenyBody | { error: string } {
  if (body === null || typeof body !== 'object') {
    return { error: "Request body must be a JSON object." }
  }
  const b = body as Record<string, unknown>
  if (typeof b.requestId !== 'string' || b.requestId.length === 0) {
    return { error: "Field 'requestId' must be a non-empty string." }
  }
  return { requestId: b.requestId }
}

/**
 * Derive the storage key for a credential value given its placement.
 * Env placement names the key after the shell variable (so future
 * vault reads round-trip cleanly); every other placement stores under
 * a placement-specific synthetic key so there's no collision when the
 * same thread registers multiple non-env credentials.
 */
function storageKeyForPlacement(placement: CredentialHandle['placement']): string {
  switch (placement.type) {
    case 'env': return placement.variableName
    case 'bearer': return 'BEARER_TOKEN'
    case 'header': return `HEADER_${placement.name.replace(/[^A-Za-z0-9_]/g, '_')}`
    case 'cookie': return `COOKIE_${placement.name.replace(/[^A-Za-z0-9_]/g, '_')}`
    case 'body': return `BODY_${placement.fieldPath.replace(/[^A-Za-z0-9_]/g, '_')}`
    case 'query': return `QUERY_${placement.paramName.replace(/[^A-Za-z0-9_]/g, '_')}`
    case 'basic': return 'BASIC_PASSWORD'
  }
}

/**
 * Derive the vault id for a non-env credential. Env placement keeps the
 * `runtime_<threadId>_<varName>` convention so shell auto-injection
 * works; non-env uses the requestId (which is a UUID) for uniqueness.
 */
function credentialIdFor(
  threadId: string,
  requestId: string,
  placement: CredentialHandle['placement'],
): string {
  if (placement.type === 'env') {
    return makeRuntimeCredentialId(threadId, placement.variableName)
  }
  return makeRuntimeCredentialId(threadId, requestId)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Optional dependency injection. Production callers omit `deps` and
 * fall through to the module-level `credentialVault`. Tests pass in
 * their own isolated vault so they don't read/write the user's real
 * `~/.ownware/credentials/` directory.
 */
export interface CredentialHandlersDeps {
  readonly vault?: CredentialVault
}

export function createCredentialHandlers(
  state: GatewayState,
  deps: CredentialHandlersDeps = {},
) {
  const vault = deps.vault ?? defaultCredentialVault

  async function respond(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const raw = await readJSON<unknown>(req)
    const validated = validateRespondBody(raw)
    if ('error' in validated) {
      sendError(res, 400, validated.error)
      return
    }
    const { requestId, value } = validated

    const companions = state.getSessionCompanions(threadId)
    if (!companions) {
      sendError(res, 404, `No active session for thread "${threadId}".`)
      return
    }

    const pending = companions.credentialHITL.getPending(requestId)
    if (!pending) {
      sendError(res, 404, `No pending credential request "${requestId}".`)
      return
    }

    // Build vault id + storage key from placement. Do the write BEFORE
    // touching the runtime so a vault failure surfaces as a 500 and
    // leaves the HITL request pending (user can retry).
    const credentialId = credentialIdFor(threadId, requestId, pending.placement)
    const storageKey = storageKeyForPlacement(pending.placement)

    try {
      await vault.save(credentialId, { [storageKey]: value })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      sendError(res, 500, `Vault write failed: ${message}`)
      return
    }

    const handle: CredentialHandle = {
      credentialId,
      label: pending.label,
      placement: pending.placement,
      storedAt: Date.now(),
    }

    // Add the handle to the runtime BEFORE resolving the HITL so the
    // loop sees it in listEnvCredentials / resolveCredential immediately
    // on resume. Also prime the cache with the value we already hold so
    // the shell tool's sync resolveValue returns it on the very first
    // spawn post-respond.
    companions.credentialRuntime.addHandle(handle)
    try {
      await companions.credentialRuntime.primeValueCache()
    } catch {
      // primeValueCache re-reads from the vault for every known handle;
      // a failure here means the just-written value isn't in the cache
      // yet. Fall through — the shell tool will get null and the agent
      // can retry the command after a short delay.
    }

    const resolved = companions.credentialHITL.respond(requestId, handle)
    if (!resolved) {
      // A race with timeout / deny. The handle is still saved (retained
      // for a future run) but the current request was already resolved.
      sendJSON(res, 200, {
        credentialId,
        label: pending.label,
        accepted: false,
        reason: 'request was already resolved (likely a timeout)',
      })
      return
    }

    // CRITICAL: never echo the value back. Only id + label.
    sendJSON(res, 200, { credentialId, label: pending.label, accepted: true })
  }

  async function deny(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const raw = await readJSON<unknown>(req)
    const validated = validateDenyBody(raw)
    if ('error' in validated) {
      sendError(res, 400, validated.error)
      return
    }
    const { requestId } = validated

    const companions = state.getSessionCompanions(threadId)
    if (!companions) {
      sendError(res, 404, `No active session for thread "${threadId}".`)
      return
    }

    const pending = companions.credentialHITL.getPending(requestId)
    const label = pending?.label ?? '(unknown)'
    const resolved = companions.credentialHITL.deny(requestId)
    if (!resolved) {
      sendError(res, 404, `No pending credential request "${requestId}".`)
      return
    }
    sendJSON(res, 200, { denied: true, label })
  }

  async function list(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const companions = state.getSessionCompanions(threadId)
    if (!companions) {
      sendError(res, 404, `No active session for thread "${threadId}".`)
      return
    }
    // Diagnostics — metadata only. The list mirrors the client's view of
    // "what is the agent waiting on right now?" and carries no values.
    sendJSON(res, 200, {
      pending: companions.credentialHITL.listPending(),
    })
  }

  return { respond, deny, list }
}
