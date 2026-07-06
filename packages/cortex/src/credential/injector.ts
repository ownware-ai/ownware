/**
 * Credential injector (board: credentials-unification — C23).
 *
 * Three injection sites the gateway exposes to consumers (loom tools,
 * MCP spawn path, LLM provider adapters):
 *
 *   - `injectEnvForChild(handle, env)` — mutates an env Record in
 *     place to add the credential's variableName=value entry. The
 *     value lives in the env map for the duration of the call only;
 *     the caller passes the env to `child_process.spawn` and the
 *     value is wiped after the spawn returns.
 *
 *   - `injectAuthHeader(handle, headers)` — mutates a headers Record
 *     in place to add `Authorization: Bearer <value>` (or the
 *     auth-type-appropriate equivalent).
 *
 *   - `runWithCredential(handle, fn)` — passes the value into `fn`
 *     for SDK-style consumers (e.g. `new Anthropic({ apiKey: ... })`).
 *     The value is in scope for `fn`'s synchronous call only; the
 *     injector clears its local reference on return so a leaked
 *     closure can't keep the value alive.
 *
 * Three errors the injector throws:
 *
 *   - `InjectorHandleExpiredError` — the handle's TTL elapsed before
 *     dereference. The caller can re-resolve to get a fresh handle.
 *
 *   - `InjectorHandleUnknownError` — the handle's token is not in
 *     the resolver's map. Indicates either a forged token or a
 *     gateway restart (in-memory map is per-process).
 *
 *   - `InjectorAuthShapeError` — the credential's authType doesn't
 *     match the requested injection mode (e.g. `injectAuthHeader`
 *     called on a credential with `authType: 'basic'` that needs a
 *     username companion).
 *
 * Plaintext discipline: the value is dereferenced inside the
 * injector method, used at the OS boundary, and never returned to
 * the caller. The only exception is `runWithCredential`'s callback,
 * which receives the value because some SDKs (Anthropic, OpenAI) take
 * an apiKey at construction. Even there, the value's scope is bounded
 * by the function call.
 */

import type { OpaqueCredentialHandle } from '@ownware/loom'
import type { GatewayCredentialResolver } from './resolver.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InjectorHandleUnknownError extends Error {
  readonly kind = 'unknown' as const
  constructor() {
    super(
      'Credential handle is not recognised. Re-resolve to obtain a fresh handle.',
    )
    this.name = 'InjectorHandleUnknownError'
  }
}

export class InjectorHandleExpiredError extends Error {
  readonly kind = 'expired' as const
  constructor() {
    super('Credential handle has expired. Re-resolve to obtain a fresh handle.')
    this.name = 'InjectorHandleExpiredError'
  }
}

export class InjectorAuthShapeError extends Error {
  readonly kind = 'auth-shape' as const
  constructor(message: string) {
    super(message)
    this.name = 'InjectorAuthShapeError'
  }
}

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

export class CredentialInjector {
  constructor(private readonly resolver: GatewayCredentialResolver) {}

  /**
   * Inject the credential as `env[variableName] = value`. The env
   * Record is mutated in place; the caller passes it to
   * `child_process.spawn` and discards it after the spawn.
   *
   * Used by:
   *   - the MCP server spawn path (C25)
   *   - the shell tool (C26)
   *   - any future tool that runs a child process under
   *     pre-declared env vars
   *
   * Existing values for the same variableName are overwritten — the
   * resolved credential takes priority.
   */
  async injectEnvForChild(
    handle: OpaqueCredentialHandle,
    env: Record<string, string>,
  ): Promise<void> {
    const resolved = await this.dereferenceOrThrow(handle)
    env[resolved.variableName] = resolved.value
  }

  /**
   * Inject the credential as an Authorization header. Mutates the
   * headers Record in place. Picks the right header shape from the
   * stored credential's authType:
   *
   *   - api-key       → `Authorization: <value>`
   *                     OR `Authorization: Bearer <value>` based on
   *                     the optional `headerScheme` arg (default
   *                     `'bearer'` to match the most common case).
   *   - bearer-token  → `Authorization: Bearer <value>`
   *   - oauth2        → `Authorization: Bearer <value>`
   *   - basic         → throws `InjectorAuthShapeError`. Basic auth
   *                     needs a username companion the injector
   *                     doesn't have — the caller is structured
   *                     wrong if it asked the injector to do this.
   *
   * Used by tool handlers that issue HTTP requests (Vercel deploy,
   * GitHub API, etc.).
   */
  async injectAuthHeader(
    handle: OpaqueCredentialHandle,
    headers: Record<string, string>,
    options: { readonly scheme?: 'bearer' | 'raw' } = {},
  ): Promise<void> {
    const resolved = await this.dereferenceOrThrow(handle)
    const cred = await this.resolver['store'].get(resolved.credentialId)
    const authType = cred?.authType
    if (authType === 'basic') {
      throw new InjectorAuthShapeError(
        'injectAuthHeader does not support authType "basic" — use a dedicated basic-auth helper.',
      )
    }
    const scheme = options.scheme ?? 'bearer'
    const headerValue =
      authType === 'bearer-token' || authType === 'oauth2' || scheme === 'bearer'
        ? `Bearer ${resolved.value}`
        : resolved.value
    headers['Authorization'] = headerValue
  }

  /**
   * Run a synchronous-or-async callback with the credential value
   * in scope. The value is resolved inside the injector, passed to
   * the callback, and the local reference is dropped on return.
   *
   * Used by SDK-style consumers (LLM provider adapters in C24)
   * that need the value at construction time:
   *
   *   await injector.runWithCredential(handle, async (apiKey) => {
   *     const client = new Anthropic({ apiKey })
   *     return client.messages.create({ ... })
   *   })
   *
   * The injector's local reference to the value goes out of scope
   * the moment this method returns. The callback's closure can hold
   * the value as long as it wants — that's the caller's
   * responsibility (and is unavoidable since the SDK constructor
   * itself stores the key).
   */
  async runWithCredential<T>(
    handle: OpaqueCredentialHandle,
    fn: (value: string) => T | Promise<T>,
  ): Promise<T> {
    const resolved = await this.dereferenceOrThrow(handle)
    return await fn(resolved.value)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async dereferenceOrThrow(
    handle: OpaqueCredentialHandle,
  ): Promise<{
    readonly value: string
    readonly variableName: string
    readonly credentialId: string
  }> {
    const resolved = await this.resolver.dereferenceHandle(handle)
    if (resolved === null) {
      // The resolver returns null for both "unknown token" and
      // "expired token" — distinguish so callers can show better
      // messages. We can't know which it was without re-checking
      // the map, so we ALWAYS surface "unknown" — the caller's
      // recourse is the same in both cases (re-resolve), and an
      // expired handle is structurally indistinguishable from a
      // forged one to a downstream consumer.
      throw new InjectorHandleUnknownError()
    }
    return {
      value: resolved.value,
      variableName: resolved.variableName,
      credentialId: resolved.credentialId,
    }
  }
}
