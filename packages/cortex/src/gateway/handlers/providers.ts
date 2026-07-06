/**
 * Provider API key management handlers.
 *
 * GET /providers — list configured providers with masked keys
 * POST /providers — store an encrypted API key
 * POST /providers/validate — test a key with a real API call
 * DELETE /providers/:provider — remove a stored key
 * GET /providers/:provider/key — get full decrypted key (sensitive)
 *
 * Storage is the unified `credentials` table (`category='llm'`). Each
 * provider maps 1:1 to a `variableName` (the env var the SDK adapter
 * looks up at resolve time) so the same row backs both the Settings UI
 * and the runtime resolver.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { unregisterProvider } from '@ownware/loom'
import { sendJSON, sendError, readJSON } from '../router.js'
import { SaveProviderSchema, ValidateProviderSchema } from '../validation/schemas.js'
import type { CredentialStore } from '../../credential/store/index.js'
import { LLM_PROVIDERS, llmProviderById } from '../llm-providers.js'
import {
  bootstrapProvidersFromUnifiedStore,
  isProviderAdapterAvailable,
} from '../../credential/bootstrap-providers.js'
import type { GatewayCredentialResolver } from '../../credential/resolver.js'
import type { CredentialInjector } from '../../credential/injector.js'

const KNOWN_PROVIDERS = LLM_PROVIDERS.map((d) => d.providerId)

// Validation timeout for `POST /providers/validate`
const VALIDATE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface ProviderHandlerDeps {
  readonly store: CredentialStore
  readonly resolver: GatewayCredentialResolver
  readonly injector: CredentialInjector
}

export function createProviderHandlers(deps: ProviderHandlerDeps) {
  const { store, resolver, injector } = deps

  /**
   * Re-bind every LLM provider's apiKeyProvider closure to the unified
   * resolver after a save / update / delete. Callers MUST go through
   * this path instead of constructing static-key adapters directly —
   * a static-key provider would survive deletion in process memory and
   * keep working until restart, masking the user's "remove" intent and
   * bypassing the resolver chain (audit log + spend gate).
   */
  async function refreshProviderRegistry(): Promise<void> {
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
  }

  // GET /api/v1/providers
  //
  // Returns ONE row per known LLM provider in the cortex catalogue
  // (`LLM_PROVIDERS`), not one per saved credential. Every row carries:
  //   - `available`: true when this build ships the Loom adapter for
  //     this provider. The client uses this to grey out cards for adapters
  //     that aren't compiled in (e.g. a future BYO-cloud build that
  //     drops Google support).
  //   - `configured`: true when the user has saved a credential. The
  //     three credential-bound fields (`keyHint`, `createdAt`,
  //     `updatedAt`) are populated iff `configured: true`, omitted
  //     otherwise.
  // Pre-rebuild the response was [{ provider, keyHint, createdAt,
  // updatedAt }] one row per saved credential — the client's old hardcoded
  // `available: true` map masked the wire silence. This rebuild makes
  // availability authoritative server-side; see accuracy-audit BUG #22.
  async function listProviders(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credentials = await store.list({ category: 'llm' })
    const byVariable = new Map(credentials.map((c) => [c.variableName, c]))
    const providers = LLM_PROVIDERS.map((descriptor) => {
      const cred = byVariable.get(descriptor.variableName)
      const available = isProviderAdapterAvailable(descriptor.providerId)
      if (cred) {
        return {
          provider: descriptor.providerId,
          available,
          configured: true as const,
          keyHint: cred.hint,
          createdAt: cred.createdAt,
          updatedAt: cred.updatedAt,
        }
      }
      return {
        provider: descriptor.providerId,
        available,
        configured: false as const,
      }
    })
    sendJSON(res, 200, providers)
  }

  // POST /api/v1/providers
  async function saveProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = SaveProviderSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    const { provider, key } = parsed.data
    const descriptor = llmProviderById(provider)
    if (!descriptor) {
      sendError(res, 400, `Unknown provider "${provider}". Supported: ${KNOWN_PROVIDERS.join(', ')}`)
      return
    }

    const llmCredentials = await store.list({ category: 'llm' })
    const existing = llmCredentials.find((c) => c.variableName === descriptor.variableName)
    const saved = existing
      ? await store.update(existing.id, { value: key })
      : await store.save({
          name: descriptor.name,
          value: key,
          category: 'llm',
          authType: 'api-key',
          variableName: descriptor.variableName,
          source: 'manual',
        })

    if (!saved) {
      sendError(res, 500, `Failed to save credential for "${provider}"`)
      return
    }

    // Rebuild the resolver-backed loom registration so the next chat
    // call resolves THIS new credential. The closure re-resolves on
    // every call, so a later DELETE actually disconnects.
    await refreshProviderRegistry()
    sendJSON(res, 200, { provider: descriptor.providerId, keyHint: saved.hint })
  }

  // POST /api/v1/providers/validate
  async function validateProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    const parsed = ValidateProviderSchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      return
    }

    const { provider, key } = parsed.data
    const result = await testProviderKey(provider, key)
    sendJSON(res, 200, result)
  }

  // DELETE /api/v1/providers/:provider
  async function deleteProvider(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const provider = params['provider']!
    const descriptor = llmProviderById(provider)
    if (!descriptor) {
      sendError(res, 404, `Unknown provider "${provider}"`)
      return
    }
    const llmCredentials = await store.list({ category: 'llm' })
    const existing = llmCredentials.find((c) => c.variableName === descriptor.variableName)
    if (!existing) {
      sendError(res, 404, `Provider "${provider}" not found`)
      return
    }
    await store.delete(existing.id)
    // Drop the in-memory loom registration so the next chat call sees
    // an unknown provider instead of a cached static-key adapter.
    unregisterProvider(descriptor.providerId)
    res.writeHead(204)
    res.end()
  }

  // GET /api/v1/providers/:provider/key
  async function getProviderKeyFull(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const provider = params['provider']!
    const descriptor = llmProviderById(provider)
    if (!descriptor) {
      sendError(res, 404, `Unknown provider "${provider}"`)
      return
    }
    const llmCredentials = await store.list({ category: 'llm' })
    const existing = llmCredentials.find((c) => c.variableName === descriptor.variableName)
    if (!existing) {
      sendError(res, 404, `Provider "${provider}" not found`)
      return
    }
    const decrypted = await store.decrypt(existing.id)
    if (decrypted === null) {
      sendError(res, 500, `Failed to decrypt credential for "${provider}"`)
      return
    }
    sendJSON(res, 200, { provider, key: decrypted.value })
  }

  return {
    listProviders,
    saveProvider,
    validateProvider,
    deleteProvider,
    getProviderKeyFull,
  }
}

// ---------------------------------------------------------------------------
// Provider key validation — POST /providers/validate hits a free or
// minimal-cost endpoint per provider so the UI can confirm a pasted key
// works before saving.
// ---------------------------------------------------------------------------

async function testProviderKey(
  provider: string,
  key: string,
): Promise<{ provider: string; isValid: boolean; error?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)

  try {
    switch (provider) {
      case 'anthropic': {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        if (response.status === 401) return { provider, isValid: false, error: 'Invalid API key' }
        return { provider, isValid: true }
      }

      case 'openai': {
        const response = await fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}` },
        })
        if (response.status === 401) return { provider, isValid: false, error: 'Invalid API key' }
        return { provider, isValid: true }
      }

      case 'google': {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          { method: 'GET', signal: controller.signal },
        )
        if (response.status === 400 || response.status === 403) {
          return { provider, isValid: false, error: 'Invalid API key' }
        }
        return { provider, isValid: true }
      }

      case 'openrouter': {
        const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
          method: 'GET',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${key}` },
        })
        if (response.status === 401 || response.status === 403) {
          return { provider, isValid: false, error: 'Invalid API key' }
        }
        return { provider, isValid: true }
      }

      default:
        return {
          provider,
          isValid: false,
          error: `Unknown provider: ${provider}. Supported: ${KNOWN_PROVIDERS.join(', ')}`,
        }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { provider, isValid: false, error: 'Validation timed out' }
    }
    return { provider, isValid: false, error: err instanceof Error ? err.message : 'Validation failed' }
  } finally {
    clearTimeout(timeout)
  }
}
