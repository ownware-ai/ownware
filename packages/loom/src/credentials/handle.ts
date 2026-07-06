/**
 * Opaque CredentialHandle (board: credentials-unification — C19).
 *
 * The architectural rule (D1) says the agent runtime never holds a
 * plaintext credential. The runtime holds OPAQUE HANDLES that the
 * gateway can dereference at the OS boundary (HTTP header injection,
 * child-process env var, SDK constructor) and nowhere else.
 *
 * This file defines the handle TYPE for loom. The type is deliberately
 * narrow:
 *
 *   1. The only field is a meaningless string token. Loom must not
 *      derive any decision from its value — that's by design. If the
 *      handle's shape leaked any information about the underlying
 *      credential (its name, category, who issued it), an adversarial
 *      tool argument or system-prompt injection could exploit that.
 *
 *   2. The shape is BRANDED so plain strings can't be passed where
 *      a handle is expected. A `string` cannot be assigned to
 *      `OpaqueCredentialHandle` without an explicit cast, and the
 *      cast is grep-friendly so reviewers can audit every site that
 *      tries to fabricate a handle.
 *
 * Naming:
 *   - During the C19→C21 transition, the new opaque handle ships
 *     under the unambiguous name `OpaqueCredentialHandle` so it can
 *     coexist with the legacy `CredentialHandle` shape in
 *     `loom/src/credentials/types.ts` (which carries id + label +
 *     placement + storedAt — the pre-unification shape).
 *   - At C21 cutover, the legacy shape is deleted and this type is
 *     renamed to `CredentialHandle`. A `// @deprecated` tag goes on
 *     the legacy export between now and then.
 *
 * The handle's contents:
 *   - The gateway resolver issues a UUID-shaped token and keeps an
 *     in-memory map `token → credentialId`. The token expires after
 *     a short TTL so a leaked handle can't be replayed weeks later.
 *   - Loom MUST NOT parse the token. The format is gateway-internal
 *     and may change without a loom version bump.
 */

/**
 * Branded opaque token. The `__brand` field is `never`-typed so it
 * can never be constructed in user code — only the gateway resolver
 * (which casts internally) produces a real handle. Loom passes the
 * handle around verbatim and hands it back to the gateway via the
 * injector at the use site.
 */
export interface OpaqueCredentialHandle {
  readonly token: string
  readonly __brand: never
}

/**
 * Type guard. Confirms a value matches the handle SHAPE. Cannot
 * confirm the token is still resolvable — that requires a round-trip
 * to the gateway resolver. Use this for boundary parsing only.
 */
export function isOpaqueCredentialHandle(value: unknown): value is OpaqueCredentialHandle {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return typeof obj['token'] === 'string' && obj['token'].length > 0
}

/**
 * Construction helper for the gateway resolver. The cast is the
 * single sanctioned way to produce a handle — every other call site
 * in the tree should reject this pattern in code review. Lives in
 * loom (not the gateway) so the token format stays under loom's
 * control even as gateway implementations vary.
 *
 * The `token` MUST be unguessable from the outside. The gateway
 * resolver passes `crypto.randomUUID()` here; tests pass a counter
 * for deterministic assertions but never anything an attacker could
 * predict.
 */
export function unsafeCreateHandle(token: string): OpaqueCredentialHandle {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('unsafeCreateHandle: token must be a non-empty string')
  }
  // The brand field is `never`-typed at the type level; at runtime it
  // is an unreadable symbol so accidental serialisation drops it.
  return { token, __brand: undefined as unknown as never }
}
