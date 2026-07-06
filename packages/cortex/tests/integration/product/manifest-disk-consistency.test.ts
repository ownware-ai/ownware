/**
 * Manifest ↔ disk consistency.
 *
 * The product manifest declares a `defaultProfileId` per product, but the Zod
 * schema cannot reach the filesystem to confirm that profile exists or that it
 * declares the matching `productId`. This test closes that gap: for every
 * product, the default profile must exist on disk AND its `productId` must
 * equal the product's slug. A manifest that names a missing or mismatched
 * default profile fails LOUDLY here instead of at runtime in front of a user.
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRODUCTS } from '../../../src/product/manifest.js'

const PROFILES_ROOT = join(__dirname, '../../../profiles')

describe('product manifest ↔ disk consistency', () => {
  for (const product of PRODUCTS) {
    it(`"${product.slug}" default profile "${product.defaultProfileId}" exists and declares productId="${product.slug}"`, async () => {
      const agentJsonPath = join(
        PROFILES_ROOT,
        product.defaultProfileId,
        'agent.json',
      )

      let raw: string
      try {
        raw = await readFile(agentJsonPath, 'utf8')
      } catch {
        throw new Error(
          `Manifest product "${product.slug}" names defaultProfileId ` +
            `"${product.defaultProfileId}", but no profile exists at ` +
            `${agentJsonPath}`,
        )
      }

      const config = JSON.parse(raw) as { productId?: string }
      // TRANSITIONAL (documented in manifest.ts): the `coder` product
      // deliberately reuses the locked team whose productId is still
      // `ownware-coder` until the legacy `ownware-coder` product is retired.
      const acceptedIds =
        product.slug === 'coder'
          ? ['coder', 'ownware-coder']
          : [product.slug]
      expect(
        acceptedIds,
        `profile "${product.defaultProfileId}" must declare productId="${product.slug}"` +
          (product.slug === 'coder' ? ' (or transitional "ownware-coder")' : ''),
      ).toContain(config.productId)
    })
  }
})
