/**
 * Unit tests for the pure web-search resolver.
 *
 * Covers every precedence path: user → env → default, stale user setting
 * fallthrough, unknown user setting ignored, key-free preferred when no
 * env keys present, paid-order priority.
 */

import { describe, it, expect } from 'vitest'
import { resolveWebSearchProvider } from '../../../src/connector/web-search/resolver.js'
import { DEFAULT_PROVIDER_ID } from '../../../src/connector/web-search/providers.js'

const EMPTY_ENV: Record<string, string | undefined> = {}
const EMPTY_VAULT: Record<string, string | undefined> = {}

describe('resolveWebSearchProvider', () => {
  it('returns the data-declared default when nothing else resolves', () => {
    const r = resolveWebSearchProvider({
      userSetting: null,
      env: EMPTY_ENV,
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(r.providerId).toBe('duckduckgo')
    expect(r.source).toBe('default')
    expect(r.status).toBe('ready')
    expect(r.apiKey).toBeUndefined()
  })

  it('honours a valid user setting for key-free providers', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'duckduckgo',
      env: EMPTY_ENV,
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe('duckduckgo')
    expect(r.source).toBe('user')
  })

  it('honours a valid user setting for api_key provider when key is in vault', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'brave',
      env: EMPTY_ENV,
      vaultKeys: { brave: 'vault-key-abc' },
    })
    expect(r.providerId).toBe('brave')
    expect(r.source).toBe('user')
    expect(r.apiKey).toBe('vault-key-abc')
  })

  it('honours a valid user setting for api_key provider when key is in env', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'tavily',
      env: { TAVILY_API_KEY: 'env-key' },
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe('tavily')
    expect(r.source).toBe('user')
    expect(r.apiKey).toBe('env-key')
  })

  it('falls through from stale user setting (api_key, no key) to env auto-detect', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'brave',
      env: { TAVILY_API_KEY: 'tk' },
      vaultKeys: EMPTY_VAULT,
    })
    // User wanted brave; no brave key; env has tavily → env picks tavily.
    expect(r.providerId).toBe('tavily')
    expect(r.source).toBe('env')
    expect(r.apiKey).toBe('tk')
  })

  it('falls through from stale user setting to default when nothing else resolves', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'brave',
      env: EMPTY_ENV,
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(r.source).toBe('default')
  })

  it('ignores unknown user setting id', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'no-such-provider',
      env: EMPTY_ENV,
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe(DEFAULT_PROVIDER_ID)
    expect(r.source).toBe('default')
  })

  it('env auto-detect prefers brave over tavily (PAID_PROVIDER_ORDER)', () => {
    const r = resolveWebSearchProvider({
      userSetting: null,
      env: { BRAVE_SEARCH_API_KEY: 'bk', TAVILY_API_KEY: 'tk' },
      vaultKeys: EMPTY_VAULT,
    })
    expect(r.providerId).toBe('brave')
    expect(r.source).toBe('env')
    expect(r.apiKey).toBe('bk')
  })

  it('empty api key in vault is treated as missing', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'brave',
      env: EMPTY_ENV,
      vaultKeys: { brave: '' },
    })
    expect(r.providerId).toBe(DEFAULT_PROVIDER_ID)
  })

  it('vault key wins over env key for the same provider', () => {
    const r = resolveWebSearchProvider({
      userSetting: 'brave',
      env: { BRAVE_SEARCH_API_KEY: 'env-brave' },
      vaultKeys: { brave: 'vault-brave' },
    })
    expect(r.apiKey).toBe('vault-brave')
  })

  it('always returns status=ready because default is key-free', () => {
    // Regardless of inputs, default fallback guarantees a ready resolution.
    const scenarios = [
      { userSetting: null, env: EMPTY_ENV, vaultKeys: EMPTY_VAULT },
      { userSetting: 'brave', env: EMPTY_ENV, vaultKeys: EMPTY_VAULT },
      { userSetting: 'unknown', env: EMPTY_ENV, vaultKeys: EMPTY_VAULT },
    ]
    for (const s of scenarios) {
      expect(resolveWebSearchProvider(s).status).toBe('ready')
    }
  })
})
