/**
 * Unit tests — which credential kinds each LLM provider may be powered by.
 *
 * `credentialKinds` records only the construction shapes implemented by the
 * gateway provider adapter. It does not encode subscription, billing, or
 * provider-policy conclusions.
 *
 * The behaviour that matters most is the unknown-provider case: a provider id
 * nobody has reviewed must answer "no", never fall through to a permissive
 * default.
 */

import { describe, expect, it } from 'vitest'

import {
  LLM_PROVIDERS,
  supportsCredentialKind,
  VARIABLE_NAME_TO_PROVIDER_ID,
} from '../../../src/gateway/llm-providers.js'

describe('every provider is api-key capable', () => {
  it.each(LLM_PROVIDERS.map(p => p.providerId))('%s allows api-key', providerId => {
    expect(supportsCredentialKind(providerId, 'api-key')).toBe(true)
  })
})

describe('no gateway provider adapter accepts OAuth yet', () => {
  it.each(LLM_PROVIDERS.map(p => p.providerId))('%s does not allow oauth', providerId => {
    expect(supportsCredentialKind(providerId, 'oauth')).toBe(false)
  })
})

describe('unknown provider capabilities are absent, not defaulted', () => {
  it('returns false for a provider id with no descriptor', () => {
    expect(supportsCredentialKind('some-new-gateway', 'oauth')).toBe(false)
    expect(supportsCredentialKind('some-new-gateway', 'api-key')).toBe(false)
  })

  it('returns false for an empty provider id', () => {
    expect(supportsCredentialKind('', 'oauth')).toBe(false)
  })
})

describe('descriptor integrity', () => {
  it('declares at least one credential kind per provider', () => {
    // A provider that permits nothing can never be wired and is almost
    // certainly an editing mistake.
    for (const p of LLM_PROVIDERS) {
      expect(p.credentialKinds.length).toBeGreaterThan(0)
    }
  })

  it('keeps the reverse variableName lookup complete', () => {
    for (const p of LLM_PROVIDERS) {
      expect(VARIABLE_NAME_TO_PROVIDER_ID[p.variableName]).toBe(p.providerId)
    }
  })

  it('has no duplicate provider ids', () => {
    const ids = LLM_PROVIDERS.map(p => p.providerId)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
