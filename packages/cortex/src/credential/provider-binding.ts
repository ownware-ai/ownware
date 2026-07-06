/**
 * Provider ⇄ resolver binding (board: credentials-unification — C24b).
 *
 * Builds an `apiKeyProvider` callback that loom's provider adapters
 * (Anthropic / OpenAI / Google) call once per `stream()` invocation
 * to obtain a fresh API key. The callback runs the full resolver
 * chain — status check, expiry, spend gate, trust gate, audit row —
 * before returning the plaintext value to the SDK constructor.
 *
 * The callback also does post-flight cost true-up via
 * `resolver.recordActualCost(handle, ...)` when the LLM call's
 * actual usage is known. The provider adapter is responsible for
 * passing that number — phase-7-MVP doesn't wire it yet (loom
 * provider adapters don't expose a post-flight cost hook), so the
 * audit log records the estimate only. Hardening follow-up.
 *
 * Why a separate file (vs inlining in server.ts):
 *   - Keeps the resolver-aware wiring testable in isolation. The
 *     test mocks only the resolver/injector and verifies the callback
 *     does the right thing.
 *   - Lets the server pick this up on a per-provider basis when the
 *     LLM provider adapter cutover (C24) lands.
 */

import {
  unsafeCreateHandle,
  type OpaqueCredentialHandle,
  type ResolveContext,
} from '@ownware/loom'
import type { CredentialInjector } from './injector.js'
import type { GatewayCredentialResolver } from './resolver.js'

// ---------------------------------------------------------------------------
// Public binding
// ---------------------------------------------------------------------------

export interface ApiKeyProviderBinding {
  /**
   * The callback to pass into a loom provider's
   * `apiKeyProvider` constructor option. Each call resolves one
   * fresh key and returns it.
   */
  readonly apiKeyProvider: () => Promise<string>
  /**
   * Last handle issued by this binding. Useful for the post-flight
   * cost true-up — caller can pass it to
   * `resolver.recordActualCost(handle, actualUsd)` once the LLM
   * call's real cost is known.
   *
   * `null` until the first successful `apiKeyProvider()` call.
   * Replaced on every subsequent call — this binding is one-shot
   * per LLM call, not multi-shot.
   */
  readonly lastHandle: () => OpaqueCredentialHandle | null
}

export interface MakeApiKeyProviderArgs {
  readonly resolver: GatewayCredentialResolver
  readonly injector: CredentialInjector
  /** Canonical env-var name of the credential to resolve. */
  readonly variableName: string
  /**
   * Per-call context provider. Called once per `apiKeyProvider()`
   * invocation so the audit row carries the live agent / session /
   * thread ids — these change between turns of the same Session.
   *
   * Returning a stable object reference is fine; the resolver
   * doesn't mutate.
   */
  readonly context: () => ResolveContext
}

/**
 * Build the binding. The returned `apiKeyProvider` is the value to
 * pass into `new AnthropicProvider({ apiKeyProvider })` etc.
 *
 * Errors propagate verbatim — `MissingCredentialError`,
 * `CredentialDeniedError`, anything from the injector. The provider
 * adapter's outer `try { } catch { translateError }` wraps them
 * into the SDK's typed error space; the caller (loop) sees a
 * `ProviderError` subclass.
 */
export function makeApiKeyProvider(
  args: MakeApiKeyProviderArgs,
): ApiKeyProviderBinding {
  const { resolver, injector, variableName, context } = args
  // Held in a closed-over variable so the binding can expose the
  // last handle for post-flight true-up. Reset to null between calls
  // briefly so a partial run doesn't surface a stale handle.
  let lastHandle: OpaqueCredentialHandle | null = null

  return {
    apiKeyProvider: async () => {
      lastHandle = null
      const ctx = context()
      const handle = await resolver.resolve(variableName, ctx)
      // Always remember the handle — even if the injector fails
      // below, the caller may want it for diagnostics. We do clear
      // it back to null first so a thrown injector error doesn't
      // leave a misleading "previous handle" exposed.
      lastHandle = handle
      // `runWithCredential` is the canonical "give me the value
      // for one synchronous use" entry. We return the value out of
      // the callback so it can flow into `new Anthropic({ apiKey })`.
      // The injector clears its local reference on return; the SDK
      // client now holds the value for the duration of the LLM call.
      return injector.runWithCredential(handle, value => value)
    },
    lastHandle: () => lastHandle,
  }
}

/**
 * Test fixture — a binding whose `apiKeyProvider` returns the same
 * static value forever. Lets non-resolver tests construct a provider
 * without setting up the full chain.
 *
 * Production code should NEVER use this — it bypasses every safety
 * gate the real resolver enforces.
 */
export function makeStaticApiKeyProvider(value: string): ApiKeyProviderBinding {
  return {
    apiKeyProvider: async () => value,
    lastHandle: () => unsafeCreateHandle('static-test-fixture'),
  }
}
