/**
 * Unit tests for context helpers.
 */

import { describe, it, expect } from 'vitest'
import { getOsContext, getDateContext, getGitContext, getProjectContext, tryReadFile } from '../../../src/profile/context.js'
import { createTempProfile } from '../../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// getOsContext
// ---------------------------------------------------------------------------

describe('getOsContext', () => {
  it('includes platform', () => {
    expect(getOsContext()).toContain(process.platform)
  })

  it('includes architecture', () => {
    expect(getOsContext()).toContain(process.arch)
  })

  it('includes node version', () => {
    expect(getOsContext()).toContain(process.version)
  })

  it('returns a multi-line string', () => {
    expect(getOsContext()).toContain('\n')
  })
})

// ---------------------------------------------------------------------------
// getDateContext
//
// These tests lock in prompt-cache stability. Anthropic's prompt cache
// does exact-prefix matching, so anything sub-day in the timestamp
// would invalidate the cache every turn and force a cache-write at
// 1.25× the input rate. If one of these tests fails because someone
// re-introduced the time portion, the fix is to revert — not to update
// the test.
// ---------------------------------------------------------------------------

describe('getDateContext', () => {
  it('includes "Current date:"', () => {
    expect(getDateContext()).toContain('Current date:')
  })

  it('includes current year', () => {
    expect(getDateContext()).toContain(new Date().getFullYear().toString())
  })

  it('returns YYYY-MM-DD (date only, no time component)', () => {
    const ctx = getDateContext()
    // Date in YYYY-MM-DD form is present.
    expect(ctx).toMatch(/\d{4}-\d{2}-\d{2}/)
    // Time component must NOT be present — any of `T`, `Z`, colons in the
    // time, or a sub-second fraction would bust the prompt cache.
    expect(ctx).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(ctx).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(ctx).not.toMatch(/\.\d{3}Z/)
  })

  it('is stable across consecutive calls (prompt-cache safety)', () => {
    // Two calls in the same millisecond — if the function were still
    // embedding a sub-day timestamp, this could still flake on a
    // day-boundary tick; in practice it's deterministic.
    const a = getDateContext()
    const b = getDateContext()
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// getGitContext
//
// Working-tree status is intentionally excluded from the fragment — it
// would change on every file edit and invalidate the prompt cache
// mid-session. The branch name is stable enough: checking out a new
// branch is a rare, session-ending event.
// ---------------------------------------------------------------------------

describe('getGitContext', () => {
  it('returns non-empty string in a git repo', async () => {
    // This test runs inside the Cortex repo, which is a git repo
    const ctx = await getGitContext()
    expect(ctx.length).toBeGreaterThan(0)
  })

  it('includes branch info', async () => {
    const ctx = await getGitContext()
    expect(ctx).toContain('Git branch:')
  })

  it('does NOT include working-tree status (prompt-cache safety)', async () => {
    const ctx = await getGitContext()
    expect(ctx).not.toContain('Git status:')
    expect(ctx).not.toContain('modified')
    expect(ctx).not.toContain('untracked')
  })

  it('is stable across consecutive calls even when files change', async () => {
    // We can't actually mutate the working tree from inside this test
    // without risking side effects on the dev's checkout, so we settle
    // for the weaker invariant that two calls with no intervening git
    // operations produce the same string. The test's real value is as a
    // guard against someone re-adding `git status` to the fragment —
    // that change would immediately break `does NOT include working-
    // tree status` above.
    const a = await getGitContext()
    const b = await getGitContext()
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// getProjectContext
// ---------------------------------------------------------------------------

describe('getProjectContext', () => {
  it('returns null for directory without OWNWARE.md', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': '{}',
    })
    try {
      const ctx = await getProjectContext(dir)
      expect(ctx).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('loads OWNWARE.md from root', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': '{}',
      'OWNWARE.md': '# Project Config\n\nImportant rules.',
    })
    try {
      const ctx = await getProjectContext(dir)
      expect(ctx).toContain('Project Config')
    } finally {
      await cleanup()
    }
  })

  it('prefers .ownware/OWNWARE.md over root', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': '{}',
      'OWNWARE.md': 'root version',
      '.ownware/OWNWARE.md': 'dotdir version',
    })
    try {
      const ctx = await getProjectContext(dir)
      expect(ctx).toContain('dotdir version')
    } finally {
      await cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// tryReadFile
// ---------------------------------------------------------------------------

describe('tryReadFile', () => {
  it('returns content for existing file', async () => {
    const { dir, cleanup } = await createTempProfile({
      'test.txt': 'hello world',
    })
    try {
      const content = await tryReadFile(`${dir}/test.txt`)
      expect(content).toBe('hello world')
    } finally {
      await cleanup()
    }
  })

  it('returns null for missing file', async () => {
    const content = await tryReadFile('/nonexistent/path/file.txt')
    expect(content).toBeNull()
  })
})
