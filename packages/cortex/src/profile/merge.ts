/**
 * JSON Merge Patch (RFC 7396) for profile config updates.
 *
 * Used by the `PUT /api/v1/profiles/:id` handler so a client can send a
 * sparse patch (`{ security: { level: "strict" } }`) without clobbering
 * sibling fields (`security.zones`, `security.hitlTimeoutMs`, …).
 *
 * Semantics (match RFC 7396 exactly so the behavior is documentable
 * without inventing something bespoke):
 *
 *   - Both sides are plain objects → keys are merged recursively.
 *   - Patch value is `undefined` → treated as "key not present" → base
 *     value is kept. (Convenience for TS callers where optional fields
 *     arrive as `undefined` rather than missing.)
 *   - Patch value is `null` → the key is REMOVED from the result.
 *   - Patch value is an array → replaces base wholesale (arrays are NOT
 *     element-merged; that behavior is ambiguous and the RFC rejects it).
 *   - Any other primitive or type mismatch → patch wins.
 *
 * The function is pure — inputs are not mutated.
 */

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * Shape the handler passes in — the on-disk JSON and the patch both
 * arrive as opaque `Record<string, unknown>`. We don't re-type to
 * `JsonObject` because zod re-validates downstream and because the
 * merge is structural: it only cares about object-ness and null-ness.
 */
export function deepMergePartial(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }

  for (const key of Object.keys(patch)) {
    const patchValue = patch[key]

    // `undefined` means "not present in the patch" — keep base.
    if (patchValue === undefined) continue

    // `null` deletes per RFC 7396.
    if (patchValue === null) {
      delete out[key]
      continue
    }

    const baseValue = out[key]

    if (isPlainObject(patchValue) && isPlainObject(baseValue)) {
      out[key] = deepMergePartial(baseValue, patchValue)
      continue
    }

    // Arrays, primitives, or type mismatches: patch wins wholesale.
    out[key] = patchValue
  }

  return out
}

/**
 * Narrow to "plain object" — an object literal we can recurse into.
 * Rejects arrays, null, Dates, Maps, class instances, etc. Anything
 * non-plain is treated as an opaque value (replaced, not merged).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
