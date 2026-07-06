/**
 * Unit tests for the skill installer + remover.
 *
 * Uses a real temp directory so the atomic write + collision detection +
 * symlink rejection paths are tested against the actual filesystem.
 * The registry dependency is faked.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installSkill,
  removeSkill,
  SkillInstallError,
  type SkillInstallErrorCode,
  type SkillRegistry,
} from '../../../src/profile/skills/installer.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {})
  }
})

async function makeProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-skill-test-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function fakeRegistry(opts: { failReload?: boolean } = {}): SkillRegistry & {
  reloadCount: number
} {
  const r = {
    reloadCount: 0,
    async reload() {
      r.reloadCount++
      if (opts.failReload) throw new Error('fake reload failure')
    },
  }
  return r
}

const VALID_CONTENT = `---
name: research
description: do research
---
body
`

async function expectInstallError(
  fn: () => Promise<unknown>,
  code: SkillInstallErrorCode,
): Promise<void> {
  await fn().then(
    () => {
      throw new Error('expected SkillInstallError')
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(SkillInstallError)
      expect((err as SkillInstallError).code).toBe(code)
    },
  )
}

// ---------------------------------------------------------------------------
// installSkill — pasted content path
// ---------------------------------------------------------------------------

describe('installSkill — content source', () => {
  it('writes the skill folder + SKILL.md and reloads the profile', async () => {
    const dir = await makeProfileDir()
    const registry = fakeRegistry()
    const result = await installSkill({
      profileId: 'test',
      profileBasePath: dir,
      source: { kind: 'content', content: VALID_CONTENT },
      registry,
    })
    expect(result.slug).toBe('research')
    expect(result.path).toBe(join(dir, 'skills', 'research', 'SKILL.md'))
    expect(registry.reloadCount).toBe(1)

    const written = await readFile(result.path, 'utf-8')
    expect(written).toContain('name: research')
    expect(written).toContain('body')
    expect(written).not.toContain('cortex:source') // pasted, no source URL
  })

  it('records a source URL when sourceUrl is provided', async () => {
    const dir = await makeProfileDir()
    const result = await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: {
        kind: 'content',
        content: VALID_CONTENT,
        sourceUrl: 'https://example.com/x.md',
      },
      registry: fakeRegistry(),
    })
    const written = await readFile(result.path, 'utf-8')
    expect(written).toContain('<!-- cortex:source https://example.com/x.md installed=')
  })

  it('rejects collision on existing slug', async () => {
    const dir = await makeProfileDir()
    const registry = fakeRegistry()
    await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: { kind: 'content', content: VALID_CONTENT },
      registry,
    })
    await expectInstallError(
      () =>
        installSkill({
          profileId: 't',
          profileBasePath: dir,
          source: { kind: 'content', content: VALID_CONTENT },
          registry,
        }),
      'SKILL_EXISTS',
    )
  })

  it('passes through validator errors as install errors', async () => {
    const dir = await makeProfileDir()
    await expectInstallError(
      () =>
        installSkill({
          profileId: 't',
          profileBasePath: dir,
          source: { kind: 'content', content: 'no frontmatter here' },
          registry: fakeRegistry(),
        }),
      'MALFORMED_FRONTMATTER',
    )
  })

  it('rolls back the slug folder when reload fails', async () => {
    const dir = await makeProfileDir()
    const registry = fakeRegistry({ failReload: true })
    await expectInstallError(
      () =>
        installSkill({
          profileId: 't',
          profileBasePath: dir,
          source: { kind: 'content', content: VALID_CONTENT },
          registry,
        }),
      'RELOAD_FAILED',
    )
    const skillsContents = await readdir(join(dir, 'skills'))
    // No surviving slug folder OR file.
    expect(skillsContents).toEqual([])
  })

  it('preserves unknown frontmatter fields on disk', async () => {
    const dir = await makeProfileDir()
    const content = `---
name: tagged
description: a tagged skill
allowed-tools: [a, b]
version: "1.2"
---
body
`
    const result = await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: { kind: 'content', content },
      registry: fakeRegistry(),
    })
    const written = await readFile(result.path, 'utf-8')
    expect(written).toContain('allowed-tools: [a, b]')
    expect(written).toContain('version: "1.2"')
  })
})

// ---------------------------------------------------------------------------
// installSkill — URL source
// ---------------------------------------------------------------------------

describe('installSkill — URL source', () => {
  it('rejects an unsupported URL form', async () => {
    const dir = await makeProfileDir()
    await expectInstallError(
      () =>
        installSkill({
          profileId: 't',
          profileBasePath: dir,
          source: { kind: 'url', url: 'http://example.com/x.md' },
          registry: fakeRegistry(),
        }),
      'UNSUPPORTED_SCHEME',
    )
  })

  it('fetches via the resolver + fetcher and installs', async () => {
    const dir = await makeProfileDir()
    const fakeFetcher: typeof fetch = (async () =>
      new Response(VALID_CONTENT, {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      })) as typeof fetch
    const result = await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: {
        kind: 'url',
        url: 'https://raw.githubusercontent.com/foo/bar/main/x.md',
      },
      registry: fakeRegistry(),
      fetchOptions: { fetcher: fakeFetcher },
    })
    expect(result.slug).toBe('research')
    expect(result.source).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/x.md',
    )
    const written = await readFile(result.path, 'utf-8')
    expect(written).toContain('cortex:source https://raw.githubusercontent.com/foo/bar/main/x.md')
  })

  it('rejects a list-mode URL passed to single-skill install', async () => {
    const dir = await makeProfileDir()
    await expectInstallError(
      () =>
        installSkill({
          profileId: 't',
          profileBasePath: dir,
          source: { kind: 'url', url: 'https://github.com/foo/bar' },
          registry: fakeRegistry(),
        }),
      'UNSUPPORTED_HOST',
    )
  })
})

// ---------------------------------------------------------------------------
// installSkill — github-folder source (used by the browse flow)
// ---------------------------------------------------------------------------

describe('installSkill — github-folder source', () => {
  it('builds the raw URL from owner/repo/ref/path and installs as folder', async () => {
    const dir = await makeProfileDir()
    const fakeFetcher: typeof fetch = (async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : (input as { url: string }).url
      expect(url).toBe(
        'https://raw.githubusercontent.com/foo/bar/main/finance/x/SKILL.md',
      )
      return new Response(VALID_CONTENT, {
        status: 200,
        headers: { 'content-type': 'text/markdown' },
      })
    }) as typeof fetch

    const result = await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: {
        kind: 'github-folder',
        owner: 'foo',
        repo: 'bar',
        ref: 'main',
        path: 'finance/x/SKILL.md',
      },
      registry: fakeRegistry(),
      fetchOptions: { fetcher: fakeFetcher },
    })
    expect(result.slug).toBe('research')
    expect(result.path).toBe(join(dir, 'skills', 'research', 'SKILL.md'))
    expect(result.source).toBe(
      'https://raw.githubusercontent.com/foo/bar/main/finance/x/SKILL.md',
    )
  })
})

// ---------------------------------------------------------------------------
// removeSkill
// ---------------------------------------------------------------------------

describe('removeSkill', () => {
  it('removes an existing skill and reloads', async () => {
    const dir = await makeProfileDir()
    const registry = fakeRegistry()
    const installed = await installSkill({
      profileId: 't',
      profileBasePath: dir,
      source: { kind: 'content', content: VALID_CONTENT },
      registry,
    })
    await removeSkill({
      profileId: 't',
      profileBasePath: dir,
      slug: installed.slug,
      registry,
    })
    expect(registry.reloadCount).toBe(2) // install + remove
    const skills = await readdir(join(dir, 'skills'))
    expect(skills.filter((f) => f.endsWith('.md'))).toEqual([])
  })

  it('returns NOT_FOUND when the skill does not exist', async () => {
    const dir = await makeProfileDir()
    await mkdir(join(dir, 'skills'), { recursive: true })
    await expectInstallError(
      () =>
        removeSkill({
          profileId: 't',
          profileBasePath: dir,
          slug: 'missing',
          registry: fakeRegistry(),
        }),
      'NOT_FOUND',
    )
  })

  it('rejects an invalid slug', async () => {
    const dir = await makeProfileDir()
    await expectInstallError(
      () =>
        removeSkill({
          profileId: 't',
          profileBasePath: dir,
          slug: '../escape',
          registry: fakeRegistry(),
        }),
      'INVALID_SLUG',
    )
  })

  it('removeSkill is a no-op for unrelated stale .tmp files (sweep handles them at startup)', async () => {
    // Sanity: removeSkill should not be tricked into deleting a temp file
    // by a slug that resembles one. The slug regex enforces this.
    const dir = await makeProfileDir()
    await mkdir(join(dir, 'skills'), { recursive: true })
    await writeFile(join(dir, 'skills', '.research.md.tmp'), 'stale')
    await expectInstallError(
      () =>
        removeSkill({
          profileId: 't',
          profileBasePath: dir,
          slug: '.research.md', // not a valid slug
          registry: fakeRegistry(),
        }),
      'INVALID_SLUG',
    )
  })

  it('refuses to delete a symbolic link folder', async () => {
    const dir = await makeProfileDir()
    const skillsDir = join(dir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const targetDir = join(dir, 'outside')
    await mkdir(targetDir)
    await writeFile(join(targetDir, 'sentinel.txt'), 'do not delete me')
    await symlink(targetDir, join(skillsDir, 'evil'))

    await expectInstallError(
      () =>
        removeSkill({
          profileId: 't',
          profileBasePath: dir,
          slug: 'evil',
          registry: fakeRegistry(),
        }),
      'INVALID_SLUG',
    )
    const stillThere = await readFile(join(targetDir, 'sentinel.txt'), 'utf-8')
    expect(stillThere).toBe('do not delete me')
  })

  it('removes a legacy flat skills/<slug>.md file (back-compat)', async () => {
    const dir = await makeProfileDir()
    const skillsDir = join(dir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'legacy.md'), VALID_CONTENT)
    const registry = fakeRegistry()
    await removeSkill({
      profileId: 't',
      profileBasePath: dir,
      slug: 'legacy',
      registry,
    })
    expect(registry.reloadCount).toBe(1)
    const remaining = await readdir(skillsDir)
    expect(remaining).toEqual([])
  })
})
