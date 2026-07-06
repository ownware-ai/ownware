/**
 * Wire schema for design-system manifests.
 *
 * The profile-local `design-systems/_schema/README.md` is the human-readable
 * contract for content authors; this file is the runtime enforcement
 * boundary. A `manifest.json` that fails Zod parsing here is skipped by
 * the scanner with a one-line warning — never silently coerced.
 *
 * Schema version: `ownware-design-system/v1`. Breaking changes bump the
 * version literal and the scanner gains a migration branch; additive
 * changes (new optional fields) keep the v1 literal.
 */

import { z } from 'zod'

/**
 * Design-system category — a lowercase-kebab label.
 *
 * Was a closed `z.enum([...])` of 8 dev-flavored words, which silently
 * dropped 13 of the 16 shipped systems whose authors used design-flavored
 * categories the enum didn't list (`marketing`, `ambient`, `premium`,
 * `futuristic`, `crafted`, `friendly`, `typographic`, `retro`, `warm`,
 * `utility`) — see CT-9. A closed enum is the wrong shape for a catalog
 * meant to grow: every new system with a fresh vibe word would vanish
 * from the picker + the `list_design_systems` tool.
 *
 * Now a free lowercase-kebab string: validated for SHAPE (no spaces, no
 * uppercase, no junk) so a typo'd manifest still fails loudly, but OPEN to
 * any vocabulary the catalog authors choose. The gateway picker handler was
 * already lenient (no Zod) — this aligns the strict tool path with it so
 * all 16 systems surface everywhere, not just in the UI.
 */
export const DesignSystemCategorySchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'category must be a lowercase-kebab label (e.g. "minimal", "marketing")',
  )
export type DesignSystemCategory = z.infer<typeof DesignSystemCategorySchema>

export const DesignSystemSurfaceSchema = z.enum(['web', 'mobile', 'print', 'deck'])
export type DesignSystemSurface = z.infer<typeof DesignSystemSurfaceSchema>

export const DesignSystemSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('starter'),
    author: z.literal('ownware'),
  }),
  z.object({
    type: z.literal('imported'),
    upstream: z.string().url(),
    license: z.string().min(1),
    modified: z.boolean(),
  }),
  z.object({
    type: z.literal('community'),
    contributor: z.string().min(1),
    license: z.string().min(1),
  }),
])
export type DesignSystemSource = z.infer<typeof DesignSystemSourceSchema>

const HexColorSchema = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    'must be a hex color: #rgb, #rrggbb, or #rrggbbaa',
  )

export const DesignSystemManifestSchema = z.object({
  schemaVersion: z.literal('ownware-design-system/v1'),

  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case'),
  name: z.string().min(1),

  category: DesignSystemCategorySchema,
  surface: DesignSystemSurfaceSchema.default('web'),

  // CT-9: the cap was 140, but 13 of the 16 shipped systems wrote
  // ~200-char summaries (max 213) — the de-facto authored standard. A
  // 140 cap silently dropped them from the catalog. Raised to 280 (still
  // bounded — the summary is baked into the lightweight prompt context, so
  // it can't be unbounded) with headroom over the longest real summary.
  summary: z.string().min(1).max(280),
  swatches: z.array(HexColorSchema).min(3).max(8),

  source: DesignSystemSourceSchema,

  files: z.object({
    design: z.literal('DESIGN.md'),
    tokens: z.literal('tokens.css'),
  }),
})

export type DesignSystemManifest = z.infer<typeof DesignSystemManifestSchema>
