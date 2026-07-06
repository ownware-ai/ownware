/**
 * Unit tests for the skill fetcher.
 *
 * Uses an injected fake `fetch` so tests are hermetic — no real network.
 */

import { describe, it, expect } from 'vitest'
import {
  fetchSkill,
  listSkillsInRepo,
  SkillFetchError,
  type SkillFetchErrorCode,
} from '../../../src/profile/skills/fetcher.js'
import type { ResolvedSkillUrl } from '../../../src/profile/skills/url-resolver.js'

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

interface FakeResponse {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string
  /** If set, the fake aborts (simulating timeout) instead of returning. */
  abort?: boolean
  /** Optional script: each call returns the next response in this list. */
  next?: FakeResponse
}

function makeFetcher(scriptByUrl: Record<string, FakeResponse>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const resp = scriptByUrl[url]
    if (!resp) {
      throw new Error(`fake fetch: no response scripted for ${url}`)
    }
    if (resp.abort) {
      // Simulate a timeout — wait until the abort signal fires.
      return await new Promise<Response>((_, reject) => {
        const sig = (init?.signal ?? null) as AbortSignal | null
        if (sig) {
          sig.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string }
            err.name = 'AbortError'
            reject(err)
          })
        }
      })
    }
    const status = resp.status ?? 200
    const statusText = resp.statusText ?? 'OK'
    const headers = new Headers(resp.headers ?? { 'content-type': 'text/markdown' })
    return new Response(resp.body ?? '', { status, statusText, headers })
  }) as typeof fetch
}

const RAW: ResolvedSkillUrl = {
  canonical: 'https://example.com/x.md',
  origin: 'raw',
  displayHint: 'example.com',
}

const GITHUB: ResolvedSkillUrl = {
  canonical: 'https://raw.githubusercontent.com/foo/bar/main/x.md',
  origin: 'github',
  displayHint: 'github.com/foo/bar',
}

function expectFetchError(
  fn: () => Promise<unknown>,
  code: SkillFetchErrorCode,
): Promise<void> {
  return fn().then(
    () => {
      throw new Error('expected SkillFetchError')
    },
    (err) => {
      expect(err).toBeInstanceOf(SkillFetchError)
      expect((err as SkillFetchError).code).toBe(code)
    },
  )
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('fetchSkill — happy path', () => {
  it('fetches a markdown file', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        body: '---\nname: t\ndescription: x\n---\nbody',
      },
    })
    const result = await fetchSkill(RAW, { fetcher })
    expect(result.content).toContain('name: t')
    expect(result.source).toBe(RAW)
  })

  it('accepts text/plain content-type', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'plain markdown',
      },
    })
    const result = await fetchSkill(RAW, { fetcher })
    expect(result.content).toBe('plain markdown')
  })

  it('accepts application/octet-stream (GitHub raw quirk)', async () => {
    const fetcher = makeFetcher({
      'https://raw.githubusercontent.com/foo/bar/main/x.md': {
        headers: { 'content-type': 'application/octet-stream' },
        body: 'works',
      },
    })
    const result = await fetchSkill(GITHUB, { fetcher })
    expect(result.content).toBe('works')
  })

  it('proceeds when content-type is missing', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: {},
        body: 'no ct header',
      },
    })
    const result = await fetchSkill(RAW, { fetcher })
    expect(result.content).toBe('no ct header')
  })
})

// ---------------------------------------------------------------------------
// Errors — content type, size, status
// ---------------------------------------------------------------------------

describe('fetchSkill — error paths', () => {
  it('rejects wrong content-type', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'WRONG_CONTENT_TYPE',
    )
  })

  it('rejects oversize via Content-Length', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: {
          'content-type': 'text/markdown',
          'content-length': '999999',
        },
        body: 'doesnt matter',
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher, maxBytes: 1024 }),
      'TOO_LARGE',
    )
  })

  it('rejects oversize discovered while reading', async () => {
    const big = 'x'.repeat(200)
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: { 'content-type': 'text/markdown' },
        body: big,
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher, maxBytes: 100 }),
      'TOO_LARGE',
    )
  })

  it('accepts size exactly at the cap', async () => {
    const exact = 'x'.repeat(64)
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        headers: { 'content-type': 'text/markdown' },
        body: exact,
      },
    })
    const result = await fetchSkill(RAW, { fetcher, maxBytes: 64 })
    expect(result.content).toBe(exact)
  })

  it('rejects non-2xx upstream', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        status: 404,
        statusText: 'Not Found',
        body: 'gone',
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'FETCH_FAILED',
    )
  })

  it('treats network errors as FETCH_FAILED', async () => {
    const fetcher: typeof fetch = (async () => {
      throw new Error('econnrefused')
    }) as typeof fetch
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'FETCH_FAILED',
    )
  })

  it('treats abort as FETCH_FAILED (timeout case)', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': { abort: true },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher, timeoutMs: 10 }),
      'FETCH_FAILED',
    )
  })
})

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe('fetchSkill — redirects', () => {
  it('follows a redirect to a public host', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        status: 301,
        headers: { location: 'https://other-public.com/skill.md' },
      },
      'https://other-public.com/skill.md': {
        headers: { 'content-type': 'text/markdown' },
        body: 'redirected',
      },
    })
    const result = await fetchSkill(RAW, { fetcher })
    expect(result.content).toBe('redirected')
  })

  it('rejects redirect to a private host', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        status: 302,
        headers: { location: 'https://10.0.0.1/skill.md' },
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'PRIVATE_HOST',
    )
  })

  it('rejects redirect missing Location header', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        status: 301,
        headers: {},
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'FETCH_FAILED',
    )
  })

  it('rejects redirect to non-https scheme', async () => {
    const fetcher = makeFetcher({
      'https://example.com/x.md': {
        status: 301,
        headers: { location: 'http://example.com/x.md' },
      },
    })
    await expectFetchError(
      () => fetchSkill(RAW, { fetcher }),
      'INVALID_URL',
    )
  })
})

// ---------------------------------------------------------------------------
// Gist API
// ---------------------------------------------------------------------------

describe('fetchSkill — gist API', () => {
  const GIST: ResolvedSkillUrl = {
    canonical: 'https://api.github.com/gists/abc123',
    origin: 'gist-page',
    displayHint: 'gist.github.com',
    gistId: 'abc123',
  }

  it('returns the only .md file when no hint', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: {
            'README.txt': { filename: 'README.txt', content: 'no', size: 2 },
            'skill.md': { filename: 'skill.md', content: 'yes', size: 3 },
          },
        }),
      },
    })
    const result = await fetchSkill(GIST, { fetcher })
    expect(result.content).toBe('yes')
  })

  it('uses the file hint to disambiguate', async () => {
    const GIST_HINTED: ResolvedSkillUrl = {
      ...GIST,
      gistFileHint: 'second-md',
    }
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: {
            'first.md': { filename: 'first.md', content: 'no', size: 2 },
            'second.md': { filename: 'second.md', content: 'yes', size: 3 },
          },
        }),
      },
    })
    const result = await fetchSkill(GIST_HINTED, { fetcher })
    expect(result.content).toBe('yes')
  })

  it('errors when the gist has no .md file', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: {
            'a.txt': { filename: 'a.txt', content: 'x', size: 1 },
          },
        }),
      },
    })
    await expectFetchError(
      () => fetchSkill(GIST, { fetcher }),
      'GIST_FILE_NOT_FOUND',
    )
  })

  it('errors when the gist file is too large', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: {
            'big.md': { filename: 'big.md', content: 'x'.repeat(2000), size: 2000 },
          },
        }),
      },
    })
    await expectFetchError(
      () => fetchSkill(GIST, { fetcher, maxBytes: 100 }),
      'TOO_LARGE',
    )
  })

  it('errors on invalid JSON from the API', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      },
    })
    await expectFetchError(
      () => fetchSkill(GIST, { fetcher }),
      'FETCH_FAILED',
    )
  })

  it('errors on non-2xx from the API', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/gists/abc123': {
        status: 404,
        statusText: 'Not Found',
        body: '{"message":"Not Found"}',
      },
    })
    await expectFetchError(
      () => fetchSkill(GIST, { fetcher }),
      'FETCH_FAILED',
    )
  })
})

// ---------------------------------------------------------------------------
// listSkillsInRepo — tree-too-large
// ---------------------------------------------------------------------------

describe('listSkillsInRepo — TREE_TOO_LARGE', () => {
  const REPO: ResolvedSkillUrl = {
    canonical: 'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1',
    origin: 'github-repo',
    displayHint: 'github.com/foo/bar',
    owner: 'foo',
    repo: 'bar',
    ref: 'HEAD',
  }

  it('throws TREE_TOO_LARGE when the tree response exceeds the cap', async () => {
    // Build a body big enough to trip the 2 MB cap during streaming.
    // We use Content-Length to short-circuit the read so the test
    // runs fast.
    const fetcher = makeFetcher({
      'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1': {
        headers: {
          'content-type': 'application/json',
          'content-length': String(3 * 1024 * 1024),
        },
        body: '{}',
      },
    })
    await expectFetchError(
      () => listSkillsInRepo(REPO, { fetcher }),
      'TREE_TOO_LARGE',
    )
  })
})

// ---------------------------------------------------------------------------
// listSkillsInRepo (browse mode)
// ---------------------------------------------------------------------------

describe('listSkillsInRepo', () => {
  const REPO: ResolvedSkillUrl = {
    canonical: 'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1',
    origin: 'github-repo',
    displayHint: 'github.com/foo/bar',
    owner: 'foo',
    repo: 'bar',
    ref: 'HEAD',
  }

  const TREE = (paths: string[]): string =>
    JSON.stringify({
      tree: paths.map((p) => ({ path: p, type: 'blob' })),
    })

  function makeRepoFetcher(
    treeBody: string,
    skills: Record<string, string>,
  ): typeof fetch {
    const map: Record<string, FakeResponse> = {
      'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1': {
        headers: { 'content-type': 'application/json' },
        body: treeBody,
      },
    }
    for (const [path, body] of Object.entries(skills)) {
      map[`https://raw.githubusercontent.com/foo/bar/HEAD/${path}`] = {
        headers: { 'content-type': 'text/markdown' },
        body,
      }
    }
    return makeFetcher(map)
  }

  it('returns one entry per SKILL.md found', async () => {
    const fetcher = makeRepoFetcher(
      TREE([
        'finance/x/SKILL.md',
        'finance/x/README.md',
        'marketing/y/SKILL.md',
        'unrelated.md',
      ]),
      {
        'finance/x/SKILL.md': '---\nname: X\ndescription: x desc\n---\nx body',
        'marketing/y/SKILL.md': '---\nname: Y\ndescription: y desc\n---\ny body',
      },
    )
    const result = await listSkillsInRepo(REPO, { fetcher })
    expect(result).toHaveLength(2)
    const slugs = result.map((s) => s.slug).sort()
    expect(slugs).toEqual(['x', 'y'])
    // Body is included so the UI can preview without a re-fetch.
    const x = result.find((s) => s.slug === 'x')
    expect(x?.body).toBe('x body')
  })

  it('captures category from the parent folder', async () => {
    const fetcher = makeRepoFetcher(
      TREE(['finance/investment/SKILL.md', 'marketing/seo/SKILL.md']),
      {
        'finance/investment/SKILL.md': '---\nname: I\ndescription: d\n---\nbody',
        'marketing/seo/SKILL.md': '---\nname: S\ndescription: d\n---\nbody',
      },
    )
    const result = await listSkillsInRepo(REPO, { fetcher })
    const cats = result.map((s) => s.category).sort()
    expect(cats).toEqual(['finance', 'marketing'])
  })

  it('respects subpath filter on github-tree', async () => {
    const TREE_RESOLVED: ResolvedSkillUrl = {
      ...REPO,
      origin: 'github-tree',
      subpath: 'finance',
    }
    const fetcher = makeRepoFetcher(
      TREE([
        'finance/x/SKILL.md',
        'marketing/y/SKILL.md',
      ]),
      {
        'finance/x/SKILL.md': '---\nname: X\ndescription: d\n---\nbody',
      },
    )
    const result = await listSkillsInRepo(TREE_RESOLVED, { fetcher })
    expect(result.map((s) => s.slug)).toEqual(['x'])
  })

  it('handles a top-level SKILL.md inside the subpath (slug = subpath name)', async () => {
    // Mirrors the real-world claude-skills/finance layout: there's a
    // finance/SKILL.md at the top, plus per-skill subfolders.
    const TREE_RESOLVED: ResolvedSkillUrl = {
      ...REPO,
      origin: 'github-tree',
      subpath: 'finance',
    }
    const fetcher = makeRepoFetcher(
      TREE([
        'finance/SKILL.md',
        'finance/business-investment-advisor/SKILL.md',
        'finance/financial-analyst/SKILL.md',
      ]),
      {
        'finance/SKILL.md': '---\nname: Finance\ndescription: top\n---\nbody',
        'finance/business-investment-advisor/SKILL.md':
          '---\nname: BIA\ndescription: x\n---\nbody',
        'finance/financial-analyst/SKILL.md':
          '---\nname: FA\ndescription: y\n---\nbody',
      },
    )
    const result = await listSkillsInRepo(TREE_RESOLVED, { fetcher })
    const slugs = result.map((s) => s.slug).sort()
    expect(slugs).toEqual([
      'business-investment-advisor',
      'finance',
      'financial-analyst',
    ])
    // None should have an empty slug.
    expect(result.every((s) => s.slug.length > 0)).toBe(true)
  })

  it('groups deeper-nested skills by category', async () => {
    const TREE_RESOLVED: ResolvedSkillUrl = {
      ...REPO,
      origin: 'github-tree',
      subpath: 'finance',
    }
    const fetcher = makeRepoFetcher(
      TREE([
        'finance/sub-cat/skill-a/SKILL.md',
        'finance/skill-b/SKILL.md',
      ]),
      {
        'finance/sub-cat/skill-a/SKILL.md':
          '---\nname: A\ndescription: x\n---\nbody',
        'finance/skill-b/SKILL.md':
          '---\nname: B\ndescription: y\n---\nbody',
      },
    )
    const result = await listSkillsInRepo(TREE_RESOLVED, { fetcher })
    const byCat = Object.fromEntries(result.map((s) => [s.slug, s.category]))
    expect(byCat['skill-a']).toBe('sub-cat')
    expect(byCat['skill-b']).toBe('')
  })

  it('skips files that fail to fetch and returns the rest', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1': {
        headers: { 'content-type': 'application/json' },
        body: TREE(['ok/SKILL.md', 'broken/SKILL.md']),
      },
      'https://raw.githubusercontent.com/foo/bar/HEAD/ok/SKILL.md': {
        headers: { 'content-type': 'text/markdown' },
        body: '---\nname: OK\ndescription: d\n---\nbody',
      },
      'https://raw.githubusercontent.com/foo/bar/HEAD/broken/SKILL.md': {
        status: 500,
        statusText: 'Boom',
        body: 'oops',
      },
    })
    const result = await listSkillsInRepo(REPO, { fetcher })
    expect(result.map((s) => s.slug)).toEqual(['ok'])
  })

  it('falls back to slug when frontmatter has no name', async () => {
    const fetcher = makeRepoFetcher(
      TREE(['plain/SKILL.md']),
      {
        'plain/SKILL.md': 'no frontmatter at all\n',
      },
    )
    const result = await listSkillsInRepo(REPO, { fetcher })
    expect(result[0]!.slug).toBe('plain')
    expect(result[0]!.name).toBe('plain')
    expect(result[0]!.description).toBe('')
  })

  it('errors when called with a non-list origin', async () => {
    await expectFetchError(
      () => listSkillsInRepo(RAW, {}),
      'FETCH_FAILED',
    )
  })

  it('errors when the tree API returns non-2xx', async () => {
    const fetcher = makeFetcher({
      'https://api.github.com/repos/foo/bar/git/trees/HEAD?recursive=1': {
        status: 404,
        statusText: 'Not Found',
        body: '{}',
      },
    })
    await expectFetchError(
      () => listSkillsInRepo(REPO, { fetcher }),
      'FETCH_FAILED',
    )
  })
})

// Re-export the FakeResponse type for use in this same file (helper).
// (declared inline above; this comment is just a marker)
