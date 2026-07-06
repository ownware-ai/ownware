/**
 * Preflight tests — manifest-only preview, no clone, no real network.
 *
 * Every test injects a fake fetcher so we can simulate manifest fetch
 * outcomes (200, 404, 403, oversized, network) without binding ports
 * or hitting GitHub.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPreflight,
  PREFLIGHT_FETCH_MAX_BYTES,
  type PreflightFetcher,
  type PreflightFetchResponse,
} from '../../../src/profile/install/preflight.js'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

const VALID_MANIFEST = {
  schema: 1 as const,
  id: 'acme/finance',
  summary: 'Finance analyst with helpers',
  category: 'Finance',
  models: ['anthropic:claude-sonnet-4-6', 'anthropic:claude-haiku-4-5'],
  connectors: [
    { id: 'sec-edgar', label: 'SEC EDGAR — public filings', auth: 'none', required: true },
    { id: 'fred', label: 'FRED — Fed economic data', auth: 'free-key', required: true, hint: 'https://fred.stlouisfed.org' },
    { id: 'factset', label: 'FactSet', auth: 'paid-key', required: false },
  ],
  capabilities: ['filesystem-rw', 'shell', 'web', 'subagents'],
  profiles: [
    { name: 'finance', path: 'profiles/finance' },
  ],
}

/**
 * Build a fake fetcher from a route table. Each call to the fetcher
 * looks up a response by URL prefix; tests can short-circuit any
 * endpoint to whatever behaviour they want to simulate.
 */
function fakeFetcher(routes: Record<string, PreflightFetchResponse>): PreflightFetcher {
  // Longest-prefix wins so a more-specific route (e.g. "/commits/HEAD") is
  // chosen over a shorter prefix that also matches.
  const sorted = Object.entries(routes).sort(([a], [b]) => b.length - a.length)
  return async (req) => {
    for (const [prefix, response] of sorted) {
      if (req.url.startsWith(prefix)) return response
    }
    return { kind: 'network', reason: `unmocked URL ${req.url}` }
  }
}

function ok(body: unknown): PreflightFetchResponse {
  const str = typeof body === 'string' ? body : JSON.stringify(body)
  return { kind: 'ok', body: str, bytes: Buffer.byteLength(str, 'utf-8') }
}

async function expectInstallError(
  promise: Promise<unknown>,
  code: InstallError['code'],
): Promise<InstallError> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(isInstallError(caught), `expected InstallError, got: ${String(caught)}`).toBe(true)
  expect((caught as InstallError).code).toBe(code)
  return caught as InstallError
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('buildPreflight: happy paths', () => {
  it('builds a Preflight from a valid manifest', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com/acme/finance/HEAD/cortex.profile.json': ok(VALID_MANIFEST),
      'https://api.github.com/repos/acme/finance': ok({ stargazers_count: 142 }),
      'https://api.github.com/repos/acme/finance/commits/HEAD': ok({
        commit: { author: { date: '2026-05-04T12:00:00Z' } },
      }),
    })
    const got = await buildPreflight({
      url: 'https://github.com/acme/finance',
      fetcher,
    })
    expect(got.id).toBe('acme/finance')
    expect(got.author).toBe('acme')
    expect(got.summary).toContain('Finance analyst')
    expect(got.category).toBe('Finance')
    expect(got.stars).toBe(142)
    expect(got.updatedAt).toBe('2026-05-04T12:00:00Z')
    expect(got.models).toHaveLength(2)
    expect(got.connectors).toHaveLength(3)
    expect(got.capabilities).toContain('shell')
    expect(got.bundle).toBeNull()                 // single-profile manifest
    expect(got.ref).toBe('HEAD')
  })

  it('respects the explicit ref override', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com/acme/finance/v1.0.0/cortex.profile.json': ok(VALID_MANIFEST),
      'https://api.github.com/repos/acme/finance': ok({ stargazers_count: 0 }),
      'https://api.github.com/repos/acme/finance/commits/v1.0.0': ok({
        commit: { author: { date: '2026-04-01T00:00:00Z' } },
      }),
    })
    const got = await buildPreflight({
      url: 'https://github.com/acme/finance',
      ref: 'v1.0.0',
      fetcher,
    })
    expect(got.ref).toBe('v1.0.0')
    expect(got.updatedAt).toBe('2026-04-01T00:00:00Z')
  })

  it('renders bundle counter when manifest has multiple profiles', async () => {
    const multi = { ...VALID_MANIFEST, profiles: [
      { name: 'finance', path: 'profiles/finance' },
      { name: 'planner', path: 'profiles/planner' },
      { name: 'coder', path: 'profiles/coder' },
    ] }
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(multi),
      'https://api.github.com': ok({}),
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.bundle).toEqual({ profileCount: 3 })
  })

  it('forwards token in Authorization header', async () => {
    const seenHeaders: Record<string, string>[] = []
    const fetcher: PreflightFetcher = async (req) => {
      seenHeaders.push({ ...req.headers })
      if (req.url.includes('cortex.profile.json')) return ok(VALID_MANIFEST)
      return ok({})
    }
    await buildPreflight({
      url: 'https://github.com/acme/finance',
      auth: { kind: 'pat', token: 'ghp_test' },
      fetcher,
    })
    expect(seenHeaders[0]?.['Authorization']).toBe('Bearer ghp_test')
  })
})

// ---------------------------------------------------------------------------
// Enrichment is best-effort
// ---------------------------------------------------------------------------

describe('buildPreflight: best-effort enrichment', () => {
  it('returns null stars / updatedAt when GitHub API 5xx', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(VALID_MANIFEST),
      'https://api.github.com': { kind: 'network', reason: '500' },
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.stars).toBeNull()
    expect(got.updatedAt).toBeNull()
  })

  it('returns null stars / updatedAt when GitHub API rate-limits (403)', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(VALID_MANIFEST),
      'https://api.github.com': { kind: 'auth-required' },
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.stars).toBeNull()
    expect(got.updatedAt).toBeNull()
  })

  it('survives malformed enrichment JSON', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(VALID_MANIFEST),
      'https://api.github.com': ok('not json {{{'),
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.stars).toBeNull()
    expect(got.updatedAt).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('buildPreflight: error mapping', () => {
  it('manifest 404 → manifest_not_found', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': { kind: 'not-found' },
    })
    await expectInstallError(
      buildPreflight({ url: 'https://github.com/acme/finance', fetcher }),
      'manifest_not_found',
    )
  })

  it('manifest 403 → auth_required', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': { kind: 'auth-required' },
    })
    await expectInstallError(
      buildPreflight({ url: 'https://github.com/acme/finance', fetcher }),
      'auth_required',
    )
  })

  it('oversized → invalid_manifest', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': { kind: 'oversized', bytes: PREFLIGHT_FETCH_MAX_BYTES + 1 },
    })
    await expectInstallError(
      buildPreflight({ url: 'https://github.com/acme/finance', fetcher }),
      'invalid_manifest',
    )
  })

  it('network failure → network', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': { kind: 'network', reason: 'ENETDOWN' },
    })
    await expectInstallError(
      buildPreflight({ url: 'https://github.com/acme/finance', fetcher }),
      'network',
    )
  })

  it('invalid manifest body → invalid_manifest', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok({ schema: 1, id: 'no-slash' }),
    })
    await expectInstallError(
      buildPreflight({ url: 'https://github.com/acme/finance', fetcher }),
      'invalid_manifest',
    )
  })

  it('rejects bad URL via the URL parser', async () => {
    await expectInstallError(
      buildPreflight({ url: 'http://github.com/x/y' }),
      'invalid_url',
    )
  })
})

// ---------------------------------------------------------------------------
// Warnings (advisory)
// ---------------------------------------------------------------------------

describe('buildPreflight: warnings', () => {
  it('warns about paid-key connectors', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(VALID_MANIFEST), // has factset (paid-key)
      'https://api.github.com': ok({}),
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.warnings.some((w) => w.includes('paid'))).toBe(true)
  })

  it('warns about shell capability', async () => {
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(VALID_MANIFEST),
      'https://api.github.com': ok({}),
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.warnings.some((w) => w.includes('shell'))).toBe(true)
  })

  it('warns about large bundle (>5 profiles)', async () => {
    const big = { ...VALID_MANIFEST, profiles: Array.from({ length: 6 }, (_, i) => ({
      name: `p${i}`, path: `profiles/p${i}`,
    })) }
    const fetcher = fakeFetcher({
      'https://raw.githubusercontent.com': ok(big),
      'https://api.github.com': ok({}),
    })
    const got = await buildPreflight({ url: 'https://github.com/acme/finance', fetcher })
    expect(got.warnings.some((w) => w.includes('top-level profiles'))).toBe(true)
  })
})
