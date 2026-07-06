/**
 * Unified credential schema (board: credentials-unification — C01).
 *
 * Single source of truth for the `Credential` shape carried over the
 * `/api/v1/credentials` wire and stored in every backend. Validated at
 * EVERY API boundary; downstream code (handlers, hooks, store backends)
 * imports the inferred type, never re-declares it.
 *
 * Two invariants this file enforces, and that nothing else may relax:
 *
 *   1. The plaintext value is NOT in this shape. The only field that
 *      reflects the value is `hint` (last 1–8 chars, prefixed `...`).
 *      A backend that accidentally serialises `value` here would be
 *      caught by the `.strict()` parser at the response boundary.
 *   2. `spendCap` only makes sense for LLM provider keys. The schema's
 *      `superRefine` rejects every other category that carries one,
 *      so a UI bug or test mistake fails loudly at parse time, not at
 *      runtime when the cap is silently ignored.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Prefix every credential id carries. `cred_` follows the same convention
 * as `thread_`, `task_`, `usage_` (`gateway/db/database.ts`) — short
 * domain prefix + 12 hex chars, generated from a UUID.
 *
 * The board names ULID for sortability; we deliberately use the existing
 * convention because (a) every other identifier in the codebase uses it,
 * (b) credential count per user is small (<10⁴) so sortability is not
 * load-bearing, (c) introducing a new id format adds a parser surface
 * we'd otherwise need to thread through every store/migration boundary.
 */
export const CREDENTIAL_ID_PREFIX = 'cred_' as const

const CREDENTIAL_ID_REGEX = /^cred_[a-f0-9]{12}$/

const CredentialIdSchema = z.string().regex(CREDENTIAL_ID_REGEX, {
  message: 'credential id must match /^cred_[a-f0-9]{12}$/',
})

// ---------------------------------------------------------------------------
// Enumerations — keep in sync with the board's data-model section
// ---------------------------------------------------------------------------

/** Coarse classification used by the Settings filter chips. */
export const CredentialCategorySchema = z.enum([
  'llm',
  'tool',
  'oauth',
  'mcp-server',
])
export type CredentialCategory = z.infer<typeof CredentialCategorySchema>

/** Auth shape. Drives both the credential card form AND the injector site. */
export const CredentialAuthTypeSchema = z.enum([
  'api-key',
  'oauth2',
  'bearer-token',
  'basic',
])
export type CredentialAuthType = z.infer<typeof CredentialAuthTypeSchema>

/**
 * Trust level — `high` triggers the signed-approval flow on every
 * resolve. `low` and `medium` are advisory today; reserved for
 * gradient policy work after the trust-gate (C30) lands.
 */
export const CredentialTrustSchema = z.enum(['low', 'medium', 'high'])
export type CredentialTrust = z.infer<typeof CredentialTrustSchema>

/** Provenance — which acquisition path produced this credential. */
export const CredentialSourceSchema = z.enum([
  'manual',
  'env-import',
  'oauth-flow',
  'mcp-config',
])
export type CredentialSource = z.infer<typeof CredentialSourceSchema>

/** Health. `expired` and `revoked` block resolve; `error` surfaces in UI. */
export const CredentialStatusSchema = z.enum([
  'ready',
  'expired',
  'error',
  'revoked',
])
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>

// ---------------------------------------------------------------------------
// Spend cap — LLM only
// ---------------------------------------------------------------------------

export const SpendCapPeriodSchema = z.enum(['day', 'month'])
export type SpendCapPeriod = z.infer<typeof SpendCapPeriodSchema>

/**
 * Hard ceiling on LLM cost over a rolling window. Pre-flight estimator
 * rejects requests that would push usage past `amountUsd` for the
 * `period` window; post-flight true-up reconciles tokenizer drift.
 *
 * `amountUsd` upper bound is a sanity check, not a billing constraint —
 * a typo of `5000000` would otherwise silently disable the cap.
 */
export const SpendCapSchema = z
  .object({
    amountUsd: z.number().positive().finite().max(1_000_000),
    period: SpendCapPeriodSchema,
  })
  .strict()
export type SpendCap = z.infer<typeof SpendCapSchema>

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

/**
 * POSIX env-var name. Required for credentials whose `authType` is
 * `api-key` or `bearer-token` (every name we'd inject as `KEY=value`
 * into a child process).
 */
const VariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: 'variableName must match /^[A-Za-z_][A-Za-z0-9_]*$/',
  })

/**
 * User-defined tag. Same character class as docker tags + leading
 * alphanumeric, capped at 64 chars to keep filter chips tight.
 */
const TagSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: 'tag must start with [A-Za-z0-9] and contain only [A-Za-z0-9._-]',
  })

/**
 * Render-safe hint — `...XXXX` where XXXX is the value's last 1–8
 * characters. The 1–8 range covers short tokens (e.g. PINs from BLE
 * pairing flows) up to long-tail OAuth IDs, while still restricting
 * the maximum information leakage.
 *
 * Character class allows:
 *   - base64url + `=` padding (OAuth tokens hint to `...HM8A=`)
 *   - `.` so URL/email-shaped credentials hint to e.g. `....com`
 *     or `...host` cleanly. The `\.{3}` prefix is the exact-3-dot
 *     literal; the trailing `.` lives inside the value-mask class
 *     and is unambiguous because the prefix length is fixed.
 */
const HintSchema = z.string().regex(/^\.{3}[A-Za-z0-9+/=_.-]{1,8}$/, {
  message: 'hint must be in form "...XXXX" with last 1–8 chars of the value',
})

/** ISO 8601 with optional timezone offset. */
const Iso8601Schema = z.string().datetime({ offset: true })

// ---------------------------------------------------------------------------
// Credential — the wire shape
// ---------------------------------------------------------------------------

export const CredentialSchema = z
  .object({
    // identity
    id: CredentialIdSchema,
    name: z.string().min(1).max(128),
    variableName: VariableNameSchema.optional(),

    // classification
    category: CredentialCategorySchema,
    forConnector: z.string().min(1).max(256).optional(),
    authType: CredentialAuthTypeSchema,

    // value (NEVER plaintext over the wire)
    hint: HintSchema,

    // capabilities
    grantedScopes: z.array(z.string().min(1).max(256)).max(256).optional(),
    trust: CredentialTrustSchema,
    spendCap: SpendCapSchema.optional(),

    // provenance
    source: CredentialSourceSchema,
    createdAt: Iso8601Schema,
    updatedAt: Iso8601Schema,
    lastUsedAt: Iso8601Schema.optional(),

    // lifecycle / health
    status: CredentialStatusSchema,
    statusReason: z.string().min(1).max(512).optional(),
    expiresAt: Iso8601Schema.optional(),

    // grouping
    tags: z.array(TagSchema).max(32).optional(),
  })
  .strict()
  .superRefine((cred, ctx) => {
    // spendCap is LLM-only. The runtime spend tracker never inspects
    // non-LLM categories; permitting a cap there would give a false sense
    // of safety.
    if (cred.spendCap !== undefined && cred.category !== 'llm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spendCap'],
        message: 'spendCap is only valid when category === "llm"',
      })
    }

    // updatedAt must not predate createdAt — would corrupt sort + sync.
    if (Date.parse(cred.updatedAt) < Date.parse(cred.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'updatedAt cannot be earlier than createdAt',
      })
    }

    // statusReason is required when status is non-ready, otherwise the
    // UI cannot tell the user WHY the credential is broken.
    if (
      (cred.status === 'expired' || cred.status === 'error' || cred.status === 'revoked') &&
      cred.statusReason === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['statusReason'],
        message: `statusReason is required when status is "${cred.status}"`,
      })
    }

    // api-key / bearer-token credentials must declare a variableName so
    // the env injector + missing-card flow can find them by name.
    if (
      (cred.authType === 'api-key' || cred.authType === 'bearer-token') &&
      cred.variableName === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variableName'],
        message: `variableName is required when authType is "${cred.authType}"`,
      })
    }
  })

export type Credential = z.infer<typeof CredentialSchema>

/** Array form for list endpoints. */
export const CredentialListSchema = z.array(CredentialSchema)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fresh credential id. Format `cred_<12-hex>` matches the
 * codebase's existing id convention (`thread_`, `task_`, `usage_`).
 *
 * 48 bits of randomness → ~16M ids before the birthday-collision
 * probability hits 1%. Per-user cap is 10⁴ in practice; collisions are
 * a non-event.
 */
export function makeCredentialId(): string {
  const hex = randomUUID().replace(/-/g, '').slice(0, 12)
  return `${CREDENTIAL_ID_PREFIX}${hex}`
}

/**
 * Render-safe mask of a plaintext value. Returns `...XXXX` (last 4
 * chars) for normal-length tokens; values shorter than 4 chars use the
 * full length. Throws on empty input — an empty hint would mask
 * nothing, and the upstream caller must have already rejected the value.
 *
 * NEVER call this with a plaintext value outside the gateway resolver's
 * write path. The hint is the ONLY piece of the value that lives in
 * the on-disk metadata.
 */
export function maskCredentialValue(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('maskCredentialValue: value must be a non-empty string')
  }
  const tailLen = Math.min(4, value.length)
  return `...${value.slice(-tailLen)}`
}

/**
 * Type guard for a string that looks like a credential id. Cheap; useful
 * at request-validation sites that have a path param and want to reject
 * obvious garbage before hitting the store.
 */
export function isCredentialId(value: string): boolean {
  return CREDENTIAL_ID_REGEX.test(value)
}
