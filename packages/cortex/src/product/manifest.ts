/**
 * Product manifest — the canonical, validated catalog of Ownware products.
 *
 * THE single source of truth for "what products exist" and their CONTRACT
 * properties. Cortex owns this so that:
 *
 *   • `productId` on a profile or workspace is validated against a real
 *     catalog, not accepted as "any kebab string" — closing the silent-drift
 *     gap where a typo'd slug was accepted and orphaned a profile.
 *   • `profilePolicy` (open/closed) is enforceable at the API boundary, not
 *     merely hidden behind a button in the client UI.
 *   • the default agent for a product is DECLARED here, not guessed by each
 *     client (the desktop client previously hardcoded
 *     `lastProfileId: 'ownware-code'`).
 *
 * PRESENTATION — user-facing name, accent color, glyph, marketing copy — is
 * deliberately NOT here. That lives in each client's own product registry,
 * keyed by the same slug. This file is the CONTRACT; the client layers the
 * look on top. A future cloud / mobile / web client reads this same catalog
 * over the wire (`GET /api/v1/products`).
 *
 * Adding a product is exactly two coordinated edits:
 *   1. One entry in `RAW_PRODUCTS` below.
 *   2. A matching cortex profile whose `productId` equals the slug, and whose
 *      folder name equals the entry's `defaultProfileId`.
 * The client then adds its presentation entry. Nothing else. (This supersedes
 * the old model where the client's registry was the sole "knower" — D-21 /
 * D-36.)
 */

import { z } from 'zod'

/** Shared slug shape for product ids — lowercase kebab, must start a-z. */
export const PRODUCT_SLUG_RE = /^[a-z][a-z0-9-]*$/

/**
 * `'open'`   — hosts many profiles, including user-authored customs (Ownware).
 * `'closed'` — ships a fixed first-party team; the API rejects custom profiles
 *              because the surface is bespoke (Coder IDE, Design canvas).
 */
export const ProductPolicySchema = z.enum(['open', 'closed'])
export type ProductPolicy = z.infer<typeof ProductPolicySchema>

/**
 * `'ready'`       — UI is implemented; users can enter the product.
 * `'coming-soon'` — listed in catalogs but mounts a placeholder shell.
 */
export const ProductStatusSchema = z.enum(['ready', 'coming-soon'])
export type ProductStatus = z.infer<typeof ProductStatusSchema>

/**
 * One product's contract record. `.strict()` so an unknown field is a loud
 * authoring error, never silently ignored.
 */
export const ProductManifestEntrySchema = z
  .object({
    /** Stable product slug. Matches `profile.productId` and `Workspace.activeProducts[]`. */
    slug: z
      .string()
      .min(1)
      .regex(PRODUCT_SLUG_RE, 'product slug must be a lowercase kebab slug'),
    /** Whether user-authored profiles may be created inside this product. */
    profilePolicy: ProductPolicySchema,
    /**
     * Profile id (folder name) of the agent a workspace lands on when this
     * product is opened with no last-used profile. Must be a real profile
     * whose `productId === slug`. Validated at runtime by the registry, not
     * here (the manifest can't see the filesystem).
     */
    defaultProfileId: z.string().min(1),
    /** Availability of the product surface. */
    status: ProductStatusSchema,
  })
  .strict()
export type ProductManifestEntry = z.infer<typeof ProductManifestEntrySchema>

/** The full catalog schema — a non-empty list of unique-slug entries. */
export const ProductManifestSchema = z
  .array(ProductManifestEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>()
    for (const [i, entry] of entries.entries()) {
      if (seen.has(entry.slug)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'slug'],
          message: `duplicate product slug "${entry.slug}"`,
        })
      }
      seen.add(entry.slug)
    }
  })

/**
 * The catalog data. ORDER MATTERS — it is the canonical display order for
 * clients that render products in a list. Each `defaultProfileId` is the
 * folder name of a real profile under `packages/cortex/profiles/`.
 */
const RAW_PRODUCTS: readonly ProductManifestEntry[] = [
  {
    slug: 'ownware',
    profilePolicy: 'open',
    defaultProfileId: 'ownware',
    status: 'ready',
  },
  {
    // `coder` — the standalone Coder vertical (the opinionated IDE shell:
    // chat · file tree · read/diff · terminal dock · connectors). It is the
    // go-forward home of the engineering team; `ownware-coder` below is the
    // legacy generic-pane IDE, kept running for now and slated for removal.
    //
    // TRANSITIONAL: `coder` deliberately reuses the existing locked team
    // (`ownware-code` lead + the 6 specialists), whose `productId` is still
    // `ownware-coder`. There is no run-time `productId === slug` enforcement
    // (runs bind by `profileId` only; the manifest invariant is documented,
    // not asserted), so the shared team works under both products during the
    // transition. When `ownware-coder` is retired, repoint the 7 team
    // profiles' `productId` from `ownware-coder` → `coder` in one step and
    // this note goes away.
    slug: 'coder',
    profilePolicy: 'closed',
    defaultProfileId: 'ownware-code',
    // Launch gating (2026-06-20): Ownware ships general-only first; the
    // verticals are teased as coming-soon and promoted to 'ready' one at a
    // time as each is verified. `status` is a client presentation gate only —
    // it does NOT block running the profile (runs bind by profileId), so the
    // owner can still build/test Coder behind the gate.
    status: 'coming-soon',
  },
  {
    slug: 'ownware-coder',
    profilePolicy: 'closed',
    defaultProfileId: 'ownware-code',
    status: 'coming-soon',
  },
  {
    slug: 'ownware-design',
    profilePolicy: 'closed',
    defaultProfileId: 'ownware-design',
    status: 'coming-soon',
  },
  {
    slug: 'ownware-marketing',
    profilePolicy: 'closed',
    defaultProfileId: 'ownware-marketing',
    status: 'coming-soon',
  },
]

/**
 * Validated, frozen catalog. Parsed at module load so a malformed manifest
 * fails LOUDLY at boot (Principle 1) rather than shipping a broken catalog.
 */
export const PRODUCTS: readonly ProductManifestEntry[] = Object.freeze(
  ProductManifestSchema.parse(RAW_PRODUCTS),
)

/** Every product, in canonical display order. */
export function listProducts(): readonly ProductManifestEntry[] {
  return PRODUCTS
}

/** All known product slugs, in display order. */
export function listProductSlugs(): readonly string[] {
  return PRODUCTS.map((p) => p.slug)
}

/** Look up a product by slug. `undefined` for unknown slugs. */
export function getProduct(slug: string): ProductManifestEntry | undefined {
  return PRODUCTS.find((p) => p.slug === slug)
}

/** True iff `slug` names a real product in the catalog. */
export function isKnownProduct(slug: string): boolean {
  return PRODUCTS.some((p) => p.slug === slug)
}

/** The profile policy for a product, or `undefined` for an unknown slug. */
export function getProductPolicy(slug: string): ProductPolicy | undefined {
  return getProduct(slug)?.profilePolicy
}

/** The declared default profile id for a product, or `undefined` if unknown. */
export function getDefaultProfileId(slug: string): string | undefined {
  return getProduct(slug)?.defaultProfileId
}

/**
 * Boundary schema for a single product slug — accepts ONLY a slug present in
 * the catalog. Use it to validate `productId` / `activeProducts[]` at the wire
 * edge so an unknown product is rejected loudly with the valid set listed,
 * instead of silently persisted and later orphaned on read. The valid-slug
 * list is resolved once at module load (the catalog is static).
 */
export const productSlugSchema = z
  .string()
  .refine(isKnownProduct, {
    message: `unknown product slug — valid products: ${listProductSlugs().join(', ')}`,
  })
