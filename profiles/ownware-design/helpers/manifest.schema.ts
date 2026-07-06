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

export const DesignSystemCategorySchema = z.enum([
  'starter',
  'editorial',
  'minimal',
  'consumer',
  'tech',
  'experimental',
  'fintech',
  'data',
])
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

  summary: z.string().min(1).max(140),
  swatches: z.array(HexColorSchema).min(3).max(8),

  source: DesignSystemSourceSchema,

  files: z.object({
    design: z.literal('DESIGN.md'),
    tokens: z.literal('tokens.css'),
  }),
})

export type DesignSystemManifest = z.infer<typeof DesignSystemManifestSchema>
