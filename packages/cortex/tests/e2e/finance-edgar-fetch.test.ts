/**
 * E2E (Slice 11c): Loom's web_fetch can retrieve SEC EDGAR data
 * end-to-end using the default User-Agent the tool ships with.
 *
 * This is the load-bearing assumption underneath every finance flow
 * that cites a 10-K, 10-Q, 8-K, proxy, or registration statement: the
 * filings-explorer helper uses web_fetch under the hood, and SEC
 * EDGAR is the canonical free source. Handover Open Q2 flagged this
 * as unverified at the runtime level — the integration smoke only
 * checked profile loading, not actual EDGAR retrieval.
 *
 * Two scenarios pinned down here:
 *
 *  1. Small structured endpoint — the XBRL company-concept feed
 *     (`/api/xbrl/companyconcept/CIK.../us-gaap/Revenues.json`,
 *     ~2KB) returns valid JSON that parses cleanly. Proves the wire
 *     end-to-end including JSON.parse.
 *
 *  2. Large structured endpoint — the company submissions feed
 *     (~165KB for Apple) returns successfully but is truncated by
 *     Loom's 100K head-tail content limit. The truncated head still
 *     carries enough identifying fields (cik, name, tickers) for an
 *     agent to cite. Failure to JSON.parse the truncated body is
 *     EXPECTED here — the test asserts substring presence instead.
 *     This second scenario also documents the truncation-breaks-
 *     structured-data ergonomic issue (logged as a smell in the
 *     work folder's BUGS.md so a future cortex/loom revision can
 *     prefer JSON-aware truncation or a content-type-keyed limit).
 *
 * No LLM. No helper invocation. No assertions about agent behaviour.
 * Just the wire from Loom's web_fetch tool to SEC EDGAR's data layer
 * — deterministic and free.
 *
 * Slice 11b (helper invocation) and a future LLM-driven test will
 * exercise the agent's choice of URL; this test pins down that the
 * URL the agent eventually picks WILL retrieve a usable response.
 *
 * Run:
 *   npm run test:e2e -- tests/e2e/finance-edgar-fetch.test.ts
 */

import { describe, it, expect } from 'vitest'
import { webFetch, createDefaultConfig } from '@ownware/loom'
import type { ToolContext } from '@ownware/loom'

function stubContext(): ToolContext {
  // Minimal ToolContext — webFetch only reads `signal` and `config`,
  // so the rest can be inert. Mirror loom/credential.test.ts's pattern.
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'finance-edgar-fetch-test',
    agentId: null,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: createDefaultConfig('anthropic:claude-sonnet-4-6'),
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

const APPLE_REVENUES_URL =
  'https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/Revenues.json'
const APPLE_SUBMISSIONS_URL = 'https://data.sec.gov/submissions/CIK0000320193.json'

describe('e2e: web_fetch against SEC EDGAR', () => {
  it('fetches a small XBRL endpoint and parses to the expected shape (no truncation)', async () => {
    const ctx = stubContext()
    const result = await webFetch.execute({ url: APPLE_REVENUES_URL }, ctx)

    // Tool must NOT report an error. A 403 from SEC's UA blocker
    // would surface as `isError: true` with `metadata.status: 403`.
    expect(
      result.isError,
      `web_fetch reported error against SEC EDGAR XBRL: ${result.content?.slice(0, 400)}`,
    ).toBe(false)

    const meta = result.metadata as Record<string, unknown> | undefined
    expect(meta).toBeDefined()
    expect(meta!['contentType']).toEqual(expect.stringContaining('application/json'))

    // Small enough that Loom's 100K head-tail truncate does not fire.
    expect(meta!['truncated']).toBe(false)

    // JSON.parse round-trips cleanly.
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    expect(parsed['cik']).toBe(320193)
    expect(parsed['entityName']).toBe('Apple Inc.')
    expect(parsed['taxonomy']).toBe('us-gaap')
    expect(parsed['tag']).toBe('Revenues')

    // The XBRL feed exposes per-period units. Confirm the structure
    // the filings-explorer helper will mine: parsed.units.USD is an
    // array of period observations.
    const units = parsed['units'] as Record<string, unknown> | undefined
    expect(units).toBeDefined()
    const usd = units!['USD']
    expect(Array.isArray(usd)).toBe(true)
    expect((usd as unknown[]).length).toBeGreaterThan(0)
    const first = (usd as Array<Record<string, unknown>>)[0]!
    // Each observation carries the canonical XBRL fields.
    for (const key of ['end', 'val', 'accn', 'form', 'fy', 'fp']) {
      expect(first[key]).toBeDefined()
    }
  }, 60_000)

  it('fetches the large submissions endpoint with truncation, head still carries identifiers', async () => {
    const ctx = stubContext()
    const result = await webFetch.execute({ url: APPLE_SUBMISSIONS_URL }, ctx)

    expect(
      result.isError,
      `web_fetch reported error against SEC EDGAR submissions: ${result.content?.slice(0, 400)}`,
    ).toBe(false)

    const meta = result.metadata as Record<string, unknown> | undefined
    expect(meta).toBeDefined()
    expect(meta!['contentType']).toEqual(expect.stringContaining('application/json'))

    // The Apple submissions JSON is ~165KB; Loom's 100K head-tail
    // limit fires. Document this — a JSON-aware truncation strategy
    // would be more useful for finance, but that's an out-of-scope
    // improvement (logged as a smell in the work folder's BUGS.md).
    expect(meta!['truncated']).toBe(true)

    // The truncated head must still carry the canonical identifiers
    // — that's what an agent uses to cite the filing source.
    expect(result.content).toContain('"cik":"0000320193"')
    expect(result.content).toContain('"name":"Apple Inc."')
    expect(result.content).toContain('AAPL')

    // It should also contain at least one material filing form,
    // because forms appear early in `filings.recent.form[]`.
    const hasMaterialFiling =
      result.content.includes('10-K') ||
      result.content.includes('10-Q') ||
      result.content.includes('8-K')
    expect(hasMaterialFiling).toBe(true)
  }, 60_000)
})
