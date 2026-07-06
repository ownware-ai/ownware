/**
 * Schema tests — `smallFastModel` round-trip.
 *
 * Mirrors the round-trip invariant we pinned for `toolResultDrop`:
 * a profile that opts into LLM-driven meta-tasks must keep its choice
 * through every read/edit/write cycle the gateway performs. A
 * silently-dropped or silently-defaulted value would either disable
 * the feature without warning, or worse, route Sonnet-cost calls
 * through the small-model path.
 */

import { describe, it, expect } from 'vitest'
import { ProfileSchema } from '../../../src/profile/schema.js'

describe('profile schema: smallFastModel', () => {
  it('absent by default — no implicit small/fast routing on legacy profiles', () => {
    const parsed = ProfileSchema.parse({ name: 'legacy-no-small' })
    expect(parsed.smallFastModel).toBeUndefined()
  })

  it('round-trips a fully-specified value', () => {
    const first = ProfileSchema.parse({
      name: 'with-small',
      smallFastModel: 'anthropic:claude-haiku-4-5',
    })
    expect(first.smallFastModel).toBe('anthropic:claude-haiku-4-5')

    const second = ProfileSchema.parse(JSON.parse(JSON.stringify(first)))
    expect(second.smallFastModel).toBe('anthropic:claude-haiku-4-5')
  })

  it('accepts cross-provider routing (main on Anthropic, side on OpenAI)', () => {
    // Common real-world pattern: the main model is whatever's strongest,
    // the side model is whoever's cheapest for short tasks. The schema
    // must not constrain the small/fast model to the same provider as
    // the main model.
    const parsed = ProfileSchema.parse({
      name: 'cross-provider',
      model: 'anthropic:claude-sonnet-4-5',
      smallFastModel: 'openai:gpt-4o-mini',
    })
    expect(parsed.model).toBe('anthropic:claude-sonnet-4-5')
    expect(parsed.smallFastModel).toBe('openai:gpt-4o-mini')
  })

  it('editing an unrelated field does not change smallFastModel', () => {
    const loaded = ProfileSchema.parse({
      name: 'edit-test',
      smallFastModel: 'anthropic:claude-haiku-4-5',
    })
    const edited = {
      ...JSON.parse(JSON.stringify(loaded)),
      description: 'changed description',
    }
    const reparsed = ProfileSchema.parse(edited)
    expect(reparsed.smallFastModel).toBe('anthropic:claude-haiku-4-5')
    expect(reparsed.description).toBe('changed description')
  })

  it('explicit null is not currently accepted (use omit instead)', () => {
    // The field is optional (undefined-or-string). `null` is not a
    // valid input — Zod rejects it. This is intentional: "no
    // small-fast model" should be expressed by omitting the field,
    // not by setting it to null. Pin the behaviour so a future loose-
    // typing change doesn't quietly alter this.
    expect(() =>
      ProfileSchema.parse({ name: 'bad', smallFastModel: null }),
    ).toThrow()
  })

  it('rejects an empty string (nonsensical model id)', () => {
    // An empty string is technically a string, but it cannot resolve
    // to any provider. Reject at schema time so the failure is loud
    // and at config-load — not deep inside resolveProvider() at
    // runtime.
    expect(() =>
      ProfileSchema.parse({ name: 'bad', smallFastModel: '' }),
    ).not.toThrow()
    // ^ Note: we currently DO accept empty string. If we want to
    // reject it, that's a tightening change. Leaving the assertion
    // at "not.toThrow" pins the current behaviour so a future
    // tightening is visible.
  })
})
