/**
 * Unit tests for the skill activate/deactivate toggle.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setSkillActive } from '../../../src/profile/skills/activate.js'
import {
  SkillInstallError,
  type SkillInstallErrorCode,
  type SkillRegistry,
} from '../../../src/profile/skills/installer.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn().catch(() => {})
})

async function makeProfileDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-skill-activate-'))
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

async function expectActivateError(
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

async function makeNestedSkill(profileDir: string, slug: string): Promise<void> {
  const skillsDir = join(profileDir, 'skills', slug)
  await mkdir(skillsDir, { recursive: true })
  await writeFile(
    join(skillsDir, 'SKILL.md'),
    '---\nname: ' + slug + '\ndescription: d\n---\nbody\n',
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setSkillActive', () => {
  it('disables an active skill by writing .disabled marker and reloads', async () => {
    const dir = await makeProfileDir()
    await makeNestedSkill(dir, 'research')
    const reg = fakeRegistry()
    await setSkillActive({
      profileId: 't',
      profileBasePath: dir,
      slug: 'research',
      active: false,
      registry: reg,
    })
    expect(reg.reloadCount).toBe(1)
    const markerStat = await stat(join(dir, 'skills', 'research', '.disabled'))
    expect(markerStat.isFile()).toBe(true)
  })

  it('re-enables a disabled skill by removing the marker and reloads', async () => {
    const dir = await makeProfileDir()
    await makeNestedSkill(dir, 'research')
    await writeFile(join(dir, 'skills', 'research', '.disabled'), '')
    const reg = fakeRegistry()
    await setSkillActive({
      profileId: 't',
      profileBasePath: dir,
      slug: 'research',
      active: true,
      registry: reg,
    })
    const entries = await readdir(join(dir, 'skills', 'research'))
    expect(entries).not.toContain('.disabled')
    expect(reg.reloadCount).toBe(1)
  })

  it('is idempotent — disabling twice still leaves a single marker', async () => {
    const dir = await makeProfileDir()
    await makeNestedSkill(dir, 'research')
    const reg = fakeRegistry()
    await setSkillActive({
      profileId: 't',
      profileBasePath: dir,
      slug: 'research',
      active: false,
      registry: reg,
    })
    await setSkillActive({
      profileId: 't',
      profileBasePath: dir,
      slug: 'research',
      active: false,
      registry: reg,
    })
    const entries = await readdir(join(dir, 'skills', 'research'))
    const markers = entries.filter((e) => e === '.disabled')
    expect(markers).toHaveLength(1)
  })

  it('is idempotent — enabling an already-active skill is a no-op', async () => {
    const dir = await makeProfileDir()
    await makeNestedSkill(dir, 'research')
    const reg = fakeRegistry()
    await setSkillActive({
      profileId: 't',
      profileBasePath: dir,
      slug: 'research',
      active: true,
      registry: reg,
    })
    expect(reg.reloadCount).toBe(1)
  })

  it('rejects an invalid slug', async () => {
    const dir = await makeProfileDir()
    await expectActivateError(
      () =>
        setSkillActive({
          profileId: 't',
          profileBasePath: dir,
          slug: '../escape',
          active: false,
          registry: fakeRegistry(),
        }),
      'INVALID_SLUG',
    )
  })

  it('returns NOT_FOUND when the slug folder does not exist', async () => {
    const dir = await makeProfileDir()
    await mkdir(join(dir, 'skills'), { recursive: true })
    await expectActivateError(
      () =>
        setSkillActive({
          profileId: 't',
          profileBasePath: dir,
          slug: 'missing',
          active: false,
          registry: fakeRegistry(),
        }),
      'NOT_FOUND',
    )
  })

  it('refuses a slug folder that is a symlink', async () => {
    const dir = await makeProfileDir()
    const skillsDir = join(dir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const target = join(dir, 'outside')
    await mkdir(target)
    await symlink(target, join(skillsDir, 'evil'))
    await expectActivateError(
      () =>
        setSkillActive({
          profileId: 't',
          profileBasePath: dir,
          slug: 'evil',
          active: false,
          registry: fakeRegistry(),
        }),
      'INVALID_SLUG',
    )
  })

  it('returns NOT_FOUND for legacy flat skills (no folder to mark)', async () => {
    const dir = await makeProfileDir()
    const skillsDir = join(dir, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(
      join(skillsDir, 'legacy.md'),
      '---\nname: legacy\ndescription: d\n---\nbody\n',
    )
    await expectActivateError(
      () =>
        setSkillActive({
          profileId: 't',
          profileBasePath: dir,
          slug: 'legacy',
          active: false,
          registry: fakeRegistry(),
        }),
      'NOT_FOUND',
    )
  })

  it('reports RELOAD_FAILED when the reload throws', async () => {
    const dir = await makeProfileDir()
    await makeNestedSkill(dir, 'research')
    await expectActivateError(
      () =>
        setSkillActive({
          profileId: 't',
          profileBasePath: dir,
          slug: 'research',
          active: false,
          registry: fakeRegistry({ failReload: true }),
        }),
      'RELOAD_FAILED',
    )
  })
})
