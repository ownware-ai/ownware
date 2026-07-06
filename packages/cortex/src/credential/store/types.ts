/**
 * Credential backend interface.
 *
 * One interface every credential storage backend implements. The
 * dispatcher routes a category → a backend, then this file is the
 * only contract the rest of the system sees. None of the handlers,
 * the resolver, or the renderer should care which backend served a
 * given id.
 *
 * ### Identity, hint, timestamps — backend's responsibility
 *
 * Callers supply `value` + user-driven metadata. The backend assigns:
 *   - `id` (via `makeCredentialId()`)
 *   - `hint` (via `maskCredentialValue(value)`)
 *   - `createdAt`, `updatedAt` (UTC ISO 8601)
 *
 * This keeps id-generation deterministic across backends and stops a
 * test from accidentally pinning a different format for one backend.
 *
 * ### Failure semantics
 *
 *   - "Not found" returns `null` from `get` / `decrypt` and `false` from
 *     `delete`; `update` returns `null`.
 *   - I/O failure throws — the resolver translates into a typed
 *     `CredentialResolveError` for the wire.
 *   - Concurrent saves to the same id MUST be atomic. SQL backends use
 *     a transaction; file backends use a temp-file + rename(2).
 *
 * ### Plaintext discipline
 *
 *   - `decrypt()` is the ONLY method on this interface that returns
 *     plaintext. It exists for the gateway resolver to call at the OS
 *     boundary — never from a handler, never from a UI request.
 *   - `save()` and `update()` accept plaintext for write only; backends
 *     MUST encrypt before persisting and MUST NOT echo the value back
 *     in the returned `Credential` (the schema's strict mode enforces
 *     this at parse time).
 */

import type {
  Credential,
  CredentialCategory,
  CredentialSource,
  CredentialStatus,
  CredentialTrust,
  SpendCap,
} from '../schema.js'

// ---------------------------------------------------------------------------
// I/O shapes
// ---------------------------------------------------------------------------

/**
 * Plaintext bundle returned by `decrypt()`. Exists ONLY inside the
 * gateway resolver — the resolver hands `value` to one injector site
 * and discards it immediately after the OS-boundary call returns.
 *
 * The `metadata` field is the same `Credential` shape that crosses the
 * `/api/v1/credentials` wire. Returning it alongside `value` gives the
 * resolver everything it needs (status check, trust gate, spend gate)
 * without a second `get()` round-trip.
 */
export interface DecryptedCredential {
  readonly metadata: Credential
  readonly value: string
}

/**
 * `list()` filter. All fields combine with AND. Omitted fields impose
 * no restriction. `includeRevoked` defaults to `false` — soft-deleted
 * rows stay out of every list view unless an admin/audit endpoint
 * explicitly opts in.
 */
export interface CredentialFilter {
  readonly category?: CredentialCategory
  readonly forConnector?: string
  readonly tag?: string
  readonly includeRevoked?: boolean
}

/**
 * Input to `save()`. Backends generate `id`, timestamps, `hint`, and
 * default `status` (`'ready'` after a successful encrypt). Status is
 * not in this shape because a brand-new credential is always `ready`;
 * health degrades only via `update()`.
 *
 * `value` is plaintext for the duration of the save call. Backends
 * MUST encrypt-on-write and MUST NOT log, copy, or persist the
 * plaintext outside the encrypted payload.
 */
export interface CredentialSaveInput {
  readonly name: string
  readonly value: string
  readonly category: CredentialCategory
  readonly authType: Credential['authType']
  readonly variableName?: string
  readonly forConnector?: string
  readonly trust?: CredentialTrust
  readonly spendCap?: SpendCap
  readonly source: CredentialSource
  readonly tags?: readonly string[]
  readonly grantedScopes?: readonly string[]
  readonly expiresAt?: string
}

/**
 * Patch input. Only fields listed are mutable post-create.
 *
 * Three nullability conventions:
 *   - Field absent (`undefined`)  → leave unchanged.
 *   - Field present, value-shaped → set to that value.
 *   - Field present, `null`       → clear / unset (e.g. drop a spend cap).
 *
 * Supplying `value` rotates the credential: backend re-encrypts, updates
 * `hint` + `updatedAt`, and resets `status` to `'ready'` (since a
 * successful re-encrypt implies the new value is provisionally healthy
 * until the next validate call says otherwise).
 *
 * Supplying `status: 'revoked'` is the soft-delete path used by the
 * default `DELETE /credentials/:id` flow.
 */
export interface CredentialUpdateInput {
  readonly name?: string
  readonly value?: string
  readonly tags?: readonly string[]
  readonly trust?: CredentialTrust
  readonly spendCap?: SpendCap | null
  readonly expiresAt?: string | null
  readonly status?: CredentialStatus
  readonly statusReason?: string | null
  readonly grantedScopes?: readonly string[] | null
  readonly lastUsedAt?: string
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

/**
 * The contract the credential dispatcher consults. Every method is
 * documented above for failure semantics + plaintext discipline; the
 * dispatcher relies on those guarantees and will not re-validate.
 *
 * Implementations live in:
 *   - `packages/cortex/src/credential/store/db-backend.ts`           (C04)
 *   - `packages/cortex/src/credential/store/file-vault-backend.ts`   (C05)
 *
 * Tests live in `tests/unit/credential/store-contract.test.ts` — every
 * backend MUST pass the shared contract harness exported there. New
 * backends are gated on the harness going green.
 */
export interface CredentialBackend {
  /**
   * Stable diagnostic name. Surfaces in logs + audit rows; MUST be
   * unique across backends mounted in the same dispatcher. Examples:
   * `'sqlite-provider-keys'`, `'file-vault'`.
   */
  readonly name: string

  /**
   * Categories this backend handles. The dispatcher matches a save's
   * `input.category` against `categories` to pick the backend.
   * Read-only — categories are baked in at construction.
   */
  readonly categories: readonly CredentialCategory[]

  /**
   * Insert a new credential. Backend assigns id + timestamps + hint and
   * encrypts `input.value` before persistence. Returns the metadata
   * (no value).
   *
   * Throws on I/O failure. Throws on schema-invalid input — Zod parse
   * runs at the dispatcher boundary, but defense in depth: a backend
   * called directly in tests must still reject malformed input loudly.
   */
  save(input: CredentialSaveInput): Promise<Credential>

  /**
   * Fetch metadata for one credential. Returns `null` when the id is
   * not in this backend.
   *
   * Plaintext is NEVER returned by this method. Use `decrypt()` for
   * value access, and only inside the gateway resolver.
   */
  get(id: string): Promise<Credential | null>

  /**
   * List credentials matching `filter`. Excludes `status: 'revoked'`
   * unless `filter.includeRevoked === true`. Ordering is deterministic:
   * by `createdAt` ascending, ties broken by `id`. The resolver and the
   * UI both assume stable order so a list request twice in a row gives
   * the same array.
   */
  list(filter?: CredentialFilter): Promise<readonly Credential[]>

  /**
   * Apply a patch. Returns the updated credential, or `null` when the
   * id is not found.
   *
   * If `input.value` is supplied, the backend re-encrypts and updates
   * `hint`. `updatedAt` is bumped on every successful update, even when
   * only metadata changed (so the SSE invalidation key tracks any
   * change).
   */
  update(id: string, input: CredentialUpdateInput): Promise<Credential | null>

  /**
   * Hard-delete the credential. Returns `true` if a row was removed,
   * `false` if the id was not found.
   *
   * Soft-delete is `update(id, { status: 'revoked', statusReason: ... })`
   * and is the default exposed at the HTTP layer. This method is the
   * `?hard=true` escape hatch.
   */
  delete(id: string): Promise<boolean>

  /**
   * Decrypt the credential's value. Returns `null` when the id is not
   * found.
   *
   * CRITICAL: this is the ONLY plaintext-returning method. Callers must
   * use the value within the same async tick (typically inside an
   * injector closure) and MUST NOT store it, log it, or serialise it.
   *
   * Implementations MUST NOT cache decrypted values across calls —
   * every call decrypts fresh. The performance cost is bounded by the
   * already-cheap AES-GCM open path.
   */
  decrypt(id: string): Promise<DecryptedCredential | null>
}
