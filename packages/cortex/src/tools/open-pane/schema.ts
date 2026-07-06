/**
 * Zod input schema for the `open_pane` tool.
 *
 * The DEFAULT schema below allows every kind in `PaneConfigSchema`
 * (all 22 variants). Slice 3.3's per-session registration narrows
 * the `kind` enum to `profile.panes.allowedKinds` by reconstructing
 * the discriminated union from a filtered subset — the schema
 * helper `narrowPaneConfigSchema(allowedKinds)` lives here too.
 *
 * Tools advertise their input as JSON Schema (Loom's `Tool.inputSchema`
 * is a `JsonSchema`, not a Zod). We keep Zod for runtime validation
 * inside `execute()` and convert to JSON Schema where needed at the
 * tool definition (slice 3.3).
 */

import * as zModule from 'zod'

// Same defensive ESM/CJS shim used elsewhere in cortex (the dual
// package ships `z` as undefined under some test runners; this
// resolves to the real namespace either way).
type ZodNs = typeof zModule
const dual = zModule as unknown as { readonly z?: ZodNs; readonly default?: ZodNs }
const z: ZodNs = dual.z ?? dual.default ?? (zModule as ZodNs)

import { PaneConfigSchema } from '../../gateway/validation/schemas.js'
import type { PaneKind } from '../../gateway/types.js'

const PanePlacementSchema = z.union([
  z.literal('split'),
  z.literal('new-tab'),
  z.object({ in: z.string().min(1) }).strict(),
  z.object({ after: z.string().min(1) }).strict(),
])

/**
 * Default (unrestricted) input schema. Slice 3.3 wraps the actual
 * tool registration with `narrowPaneConfigSchema(allowedKinds)` so
 * each session's tool sees only the kinds the profile allows.
 *
 * The default is exported separately from the narrowed builder so
 * tests + tooling that need the full surface have it without
 * computing it.
 */
export const OpenPaneToolInputSchema = z.object({
  config: PaneConfigSchema,
  title: z.string().min(1).max(200).optional(),
  placement: PanePlacementSchema.optional(),
}).strict()

export type OpenPaneToolInputParsed = zModule.infer<typeof OpenPaneToolInputSchema>

/**
 * Build a per-session input schema where `config.kind` is narrowed
 * to the profile's `allowedKinds`. Validation rejects any kind not
 * in the list with a clean Zod error — caller (the tool's
 * `execute()`) maps that to an `OpenPaneToolFailure` with code
 * `'kind_not_permitted'`.
 *
 * Implementation detail: rather than mutating `PaneConfigSchema`
 * (which would mutate a shared module-level Zod schema and break
 * other consumers), we build a fresh `discriminatedUnion` from the
 * filtered options. The runtime cost is one Zod object construction
 * per session start — negligible.
 *
 * Edge case: if `allowedKinds` is empty, the union has zero options,
 * which Zod rejects at schema-build time. Callers should validate
 * `allowedKinds.length > 0` before calling — slice 3.3 does this in
 * the registration path. We assert it here too with a clear error.
 */
export function narrowPaneConfigSchema(
  allowedKinds: readonly PaneKind[],
): zModule.ZodTypeAny {
  if (allowedKinds.length === 0) {
    throw new Error(
      'narrowPaneConfigSchema: allowedKinds is empty — a profile must permit at least one pane kind',
    )
  }
  // Re-extract the union options from `PaneConfigSchema` and filter
  // to the allowed set. Zod stores discriminated-union options under
  // `.options` after construction.
  const allOptions = (PaneConfigSchema as unknown as {
    readonly options: readonly zModule.ZodObject<{ kind: zModule.ZodLiteral<PaneKind> }>[]
  }).options
  const filtered = allOptions.filter((opt) => {
    // Each option is z.object({ kind: z.literal(...), ... }).strict()
    const kindLiteral = opt.shape.kind as zModule.ZodLiteral<PaneKind>
    return allowedKinds.includes(kindLiteral.value)
  })
  if (filtered.length === 0) {
    throw new Error(
      `narrowPaneConfigSchema: none of allowedKinds [${allowedKinds.join(', ')}] match a known PaneConfig variant`,
    )
  }
  // Discriminated union with a single option is just the option
  // itself (Zod handles this); with two+ it stays a union.
  // Building a fresh discriminatedUnion preserves type narrowing.
  const narrowedConfigSchema = filtered.length === 1
    ? (filtered[0] as zModule.ZodTypeAny)
    : (z.discriminatedUnion(
        'kind',
        filtered as never,
      ) as zModule.ZodTypeAny)

  return z.object({
    config: narrowedConfigSchema,
    title: z.string().min(1).max(200).optional(),
    placement: PanePlacementSchema.optional(),
  }).strict()
}

/**
 * Re-export the canonical kind list + schema so consumers don't
 * have to reach into validation/schemas.ts directly.
 */
export { PaneKindSchema, PANE_KINDS } from '../../gateway/validation/schemas.js'
