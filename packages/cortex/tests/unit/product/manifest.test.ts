import { describe, it, expect } from 'vitest'
import {
  PRODUCTS,
  ProductManifestSchema,
  ProductManifestEntrySchema,
  PRODUCT_SLUG_RE,
  listProducts,
  listProductSlugs,
  getProduct,
  isKnownProduct,
  getProductPolicy,
  getDefaultProfileId,
} from '../../../src/product/manifest.js'

describe('product manifest — catalog integrity', () => {
  it('exposes the v1 product set in canonical order', () => {
    expect(listProductSlugs()).toEqual([
      'ownware',
      'coder',
      'ownware-coder',
      'ownware-design',
      'ownware-marketing',
    ])
  })

  it('every entry validates against the strict entry schema', () => {
    for (const entry of PRODUCTS) {
      expect(() => ProductManifestEntrySchema.parse(entry)).not.toThrow()
    }
  })

  it('the whole catalog validates (and is frozen)', () => {
    expect(() => ProductManifestSchema.parse(PRODUCTS)).not.toThrow()
    expect(Object.isFrozen(PRODUCTS)).toBe(true)
  })

  it('all slugs are well-formed kebab slugs', () => {
    for (const p of PRODUCTS) {
      expect(p.slug).toMatch(PRODUCT_SLUG_RE)
    }
  })

  it('declares the correct profile policy per product', () => {
    expect(getProductPolicy('ownware')).toBe('open')
    expect(getProductPolicy('ownware-coder')).toBe('closed')
    expect(getProductPolicy('coder')).toBe('closed')
    expect(getProductPolicy('ownware-design')).toBe('closed')
    expect(getProductPolicy('ownware-marketing')).toBe('closed')
  })

  it('declares a default profile id for every product', () => {
    expect(getDefaultProfileId('ownware')).toBe('ownware')
    expect(getDefaultProfileId('ownware-coder')).toBe('ownware-code')
    expect(getDefaultProfileId('coder')).toBe('ownware-code')
    expect(getDefaultProfileId('ownware-design')).toBe('ownware-design')
    expect(getDefaultProfileId('ownware-marketing')).toBe('ownware-marketing')
  })
})

describe('product manifest — lookups', () => {
  it('getProduct returns the entry for a known slug', () => {
    const coder = getProduct('ownware-coder')
    expect(coder).toMatchObject({
      slug: 'ownware-coder',
      profilePolicy: 'closed',
      defaultProfileId: 'ownware-code',
      // Launch gating (2026-06-20): the verticals ship as coming-soon until
      // each is verified and promoted; only `ownware` is 'ready' at launch.
      status: 'coming-soon',
    })
  })

  it('getProduct returns undefined for an unknown slug', () => {
    expect(getProduct('ownware-trade')).toBeUndefined()
    expect(getProductPolicy('nope')).toBeUndefined()
    expect(getDefaultProfileId('nope')).toBeUndefined()
  })

  it('isKnownProduct discriminates real vs unknown slugs', () => {
    expect(isKnownProduct('ownware')).toBe(true)
    expect(isKnownProduct('ownware-design')).toBe(true)
    expect(isKnownProduct('ownware-trade')).toBe(false)
    expect(isKnownProduct('')).toBe(false)
  })

  it('listProducts returns the same reference as PRODUCTS', () => {
    expect(listProducts()).toBe(PRODUCTS)
  })
})

describe('product manifest — schema rejects malformed catalogs', () => {
  it('rejects an empty catalog', () => {
    expect(() => ProductManifestSchema.parse([])).toThrow()
  })

  it('rejects duplicate slugs', () => {
    const dup = [
      { slug: 'a', profilePolicy: 'open', defaultProfileId: 'a', status: 'ready' },
      { slug: 'a', profilePolicy: 'closed', defaultProfileId: 'a2', status: 'ready' },
    ]
    expect(() => ProductManifestSchema.parse(dup)).toThrow(/duplicate product slug/)
  })

  it('rejects an unknown profile policy', () => {
    expect(() =>
      ProductManifestEntrySchema.parse({
        slug: 'x',
        profilePolicy: 'semi-open',
        defaultProfileId: 'x',
        status: 'ready',
      }),
    ).toThrow()
  })

  it('rejects an unknown field (strict)', () => {
    expect(() =>
      ProductManifestEntrySchema.parse({
        slug: 'x',
        profilePolicy: 'open',
        defaultProfileId: 'x',
        status: 'ready',
        accentColor: 'violet',
      }),
    ).toThrow()
  })

  it('rejects a malformed slug', () => {
    expect(() =>
      ProductManifestEntrySchema.parse({
        slug: 'Ownware Coder',
        profilePolicy: 'open',
        defaultProfileId: 'x',
        status: 'ready',
      }),
    ).toThrow()
  })
})
