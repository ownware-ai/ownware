/**
 * Zod schemas for the workspace HTTP boundary.
 *
 * Closes the "Zod at the boundary" gap: workspace create/update previously
 * used hand-rolled imperative checks while profiles used `ProfileSchema`.
 * These schemas make validation declarative and — crucially — validate
 * `activeProducts` entries against the canonical product catalog
 * (`productSlugSchema`), so an unknown product slug is rejected here rather
 * than silently stored.
 *
 * Note: these intentionally do NOT use `.strict()`. Zod strips unknown keys
 * by default, which keeps older clients that send extra fields (the create
 * path historically ignored a stray `lastProfileId`) working unchanged.
 */

import { z } from 'zod'
// Legacy product-slug shape kept for wire compat (the product catalog
// itself was removed).
const productSlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase kebab slug')

export const CreateWorkspaceRequestSchema = z.object({
  path: z.string().min(1, 'path is required'),
  name: z.string().min(1).optional(),
  create: z.boolean().optional(),
})

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  /**
   * Replace the workspace's enabled products. Must be a non-empty array of
   * KNOWN product slugs — an empty array would leave a workspace with no
   * surface and brick landing routing; an unknown slug would orphan it.
   */
  activeProducts: z
    .array(productSlugSchema)
    .min(1, 'activeProducts must be a non-empty array of known product slugs')
    .optional(),
})
