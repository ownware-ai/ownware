/**
 * Opaque sensitive-input contract.
 *
 * A sensitive value never appears in these shapes. The user supplies it to a
 * host-owned channel; Loom receives only an unguessable, short-lived handle
 * and an exact injection binding. The host consumes the handle at the effect
 * boundary and never returns the value to the engine or tool.
 */

/**
 * Adapter-private target intent carried only between a trusted tool and its
 * host registration. Loom never interprets, serializes or persists the extra
 * fields. A new sink can extend this shape without a Loom core catalogue edit.
 */
export interface SensitiveInputBinding {
  readonly kind: string
  readonly revision: string
}

/** Metadata safe to show in a sensitive-input prompt. */
export interface SensitiveInputRequest {
  readonly label: string
  readonly usage: string
  readonly binding: SensitiveInputBinding
}

/** Result of the host-owned prompt before the one-use injection attempt. */
export type SensitiveInputProvision =
  | {
      readonly status: 'provided'
      readonly handle: OpaqueSensitiveInputHandle
    }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' }
  | { readonly status: 'revoked' }
  | { readonly status: 'unavailable' }

/** Result resumed into the requesting first-party tool. */
export type SensitiveInputResolution =
  | { readonly status: 'injected' }
  | { readonly status: 'denied' }
  | { readonly status: 'indeterminate' }
  | {
      readonly status: 'failed'
      readonly reason:
        | 'adapter-unavailable'
        | 'expired'
        | 'revoked'
        | 'binding-mismatch'
        | 'injection-failed'
    }

/**
 * Branded opaque token. Shape validation proves only that a token was
 * supplied; the host remains authoritative for existence, expiry, binding and
 * whether it has already been consumed.
 */
export interface OpaqueSensitiveInputHandle {
  readonly token: string
  readonly __sensitiveInputBrand: never
}

export function isOpaqueSensitiveInputHandle(
  value: unknown,
): value is OpaqueSensitiveInputHandle {
  if (value === null || typeof value !== 'object') return false
  const token = (value as Record<string, unknown>)['token']
  return typeof token === 'string' && token.length > 0
}

/** Host-only construction seam. Tokens must be unguessable. */
export function unsafeCreateSensitiveInputHandle(
  token: string,
): OpaqueSensitiveInputHandle {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('Sensitive-input token must be a non-empty string.')
  }
  return {
    token,
    __sensitiveInputBrand: undefined as unknown as never,
  }
}
