/**
 * validate-tree.ts unit tests — the security gates that walk a cloned
 * profile dir.
 *
 * Every gate has at least: an accept case, a reject case, a clear-error case.
 * Fixture trees are built per-test in temp dirs and torn down in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateTree } from '../../../src/profile/install/validate-tree.js'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-validate-tree-'))
  cleanups.push(async () => {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* */ }
  })
  return dir
}

async function writeFileTree(root: string, layout: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(layout)) {
    const abs = join(root, relPath)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
}

async function expectInstallError(
  promise: Promise<unknown>,
  code: InstallError['code'],
): Promise<InstallError> {
  let caught: unknown
  try { await promise } catch (err) { caught = err }
  expect(isInstallError(caught)).toBe(true)
  expect((caught as InstallError).code).toBe(code)
  return caught as InstallError
}

describe('validateTree: happy paths', () => {
  it('accepts a minimal profile (just agent.json)', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, { 'agent.json': '{"name":"x"}' })
    const stats = await validateTree({ profileDir: dir })
    expect(stats.fileCount).toBe(1)
    expect(stats.totalBytes).toBeGreaterThan(0)
  })

  it('accepts SOUL.md, AGENTS.md, skills/, helpers/', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'SOUL.md': '# soul',
      'AGENTS.md': '# memory',
      'skills/dcf/SKILL.md': '---\nname: dcf\n---\nbody',
      'helpers/explore/agent.json': '{"name":"explore","kind":"helper"}',
      'helpers/explore/SOUL.md': '# explore soul',
    })
    const stats = await validateTree({ profileDir: dir })
    expect(stats.fileCount).toBe(6)
  })

  it('drops a stray .git directory without error', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      '.git/config': '[core]',
      '.git/HEAD': 'ref: refs/heads/main',
    })
    const stats = await validateTree({ profileDir: dir })
    expect(stats.fileCount).toBe(1) // .git excluded
  })
})

describe('validateTree: forbidden custom code', () => {
  it('rejects tools/foo.ts at top level', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'tools/foo.ts': 'export const x = 1',
    })
    const err = await expectInstallError(
      validateTree({ profileDir: dir }),
      'forbidden_custom_code',
    )
    expect((err.detail as { files: string[] }).files).toContain('tools/foo.ts')
  })

  it('rejects every forbidden extension', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'tools/a.ts': 'x',
      'tools/b.tsx': 'x',
      'tools/c.js': 'x',
      'tools/d.jsx': 'x',
      'tools/e.mjs': 'x',
      'tools/f.cjs': 'x',
    })
    const err = await expectInstallError(
      validateTree({ profileDir: dir }),
      'forbidden_custom_code',
    )
    const files = (err.detail as { files: string[] }).files
    expect(files).toHaveLength(6)
  })

  it('rejects tools/ nested under a top-level profile in a multi-profile repo', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'cortex.profile.json': '{}',
      'profiles/coder/agent.json': '{"name":"coder"}',
      'profiles/coder/tools/inject.ts': 'evil',
    })
    await expectInstallError(
      validateTree({ profileDir: dir }),
      'forbidden_custom_code',
    )
  })

  it('does NOT reject markdown or json inside tools/', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'tools/README.md': '# docs',
      'tools/config.json': '{}',
    })
    const stats = await validateTree({ profileDir: dir })
    expect(stats.fileCount).toBe(3)
  })

  it('allowCustomCode: true skips the gate (builtin pipeline)', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'tools/foo.ts': 'export const x = 1',
    })
    const stats = await validateTree({ profileDir: dir, allowCustomCode: true })
    expect(stats.fileCount).toBe(2)
  })
})

describe('validateTree: path escape', () => {
  it('rejects symlink pointing outside the profile dir', async () => {
    const outside = await makeTempDir()
    await writeFile(join(outside, 'secret'), 'sensitive')
    const dir = await makeTempDir()
    await writeFileTree(dir, { 'agent.json': '{"name":"x"}' })
    await symlink(join(outside, 'secret'), join(dir, 'leak'))
    const err = await expectInstallError(
      validateTree({ profileDir: dir }),
      'path_escape',
    )
    expect((err.detail as { files: string[] }).files).toContain('leak')
  })

  it('accepts symlink pointing inside the profile dir', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'real/file.md': 'inside',
    })
    await symlink(join(dir, 'real/file.md'), join(dir, 'alias'))
    const stats = await validateTree({ profileDir: dir })
    // 1 agent.json + 1 real file + 1 symlink = 3
    expect(stats.fileCount).toBe(3)
  })

  it('rejects symlink with .. target that escapes', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, { 'agent.json': '{"name":"x"}' })
    await symlink('../../../etc/passwd', join(dir, 'evil'))
    await expectInstallError(validateTree({ profileDir: dir }), 'path_escape')
  })

  it('rejects a chained symlink whose lexical target is inside but real target escapes', async () => {
    const outside = await makeTempDir()
    await writeFile(join(outside, 'secret'), 'sensitive')
    const dir = await makeTempDir()
    await writeFileTree(dir, { 'agent.json': '{"name":"x"}' })
    await symlink(join(outside, 'secret'), join(dir, 'second'))
    await symlink(join(dir, 'second'), join(dir, 'first'))

    const err = await expectInstallError(validateTree({ profileDir: dir }), 'path_escape')
    expect((err.detail as { files: string[] }).files).toEqual(
      expect.arrayContaining(['first', 'second']),
    )
  })
})

describe('validateTree: file count + size caps', () => {
  it('rejects above the file-count cap', async () => {
    const dir = await makeTempDir()
    const layout: Record<string, string> = { 'agent.json': '{"name":"x"}' }
    for (let i = 0; i < 5; i++) layout[`f-${i}.md`] = 'x'
    await writeFileTree(dir, layout)
    await expectInstallError(
      validateTree({ profileDir: dir, maxFiles: 3 }),
      'oversized',
    )
  })

  it('rejects above the byte cap', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'big.md': 'x'.repeat(2000),
    })
    await expectInstallError(
      validateTree({ profileDir: dir, maxBytes: 1500 }),
      'oversized',
    )
  })

  it('returns stats summary when under all caps', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'a.md': 'a',
      'b.md': 'bb',
    })
    const stats = await validateTree({ profileDir: dir })
    expect(stats.fileCount).toBe(3)
    expect(stats.totalBytes).toBe(12 + 1 + 2)
  })
})

describe('validateTree: reports all violations together', () => {
  it('lists every forbidden custom-code file in one error', async () => {
    const dir = await makeTempDir()
    await writeFileTree(dir, {
      'agent.json': '{"name":"x"}',
      'tools/a.ts': 'x',
      'tools/b.js': 'y',
      'tools/sub/c.mjs': 'z',
    })
    const err = await expectInstallError(
      validateTree({ profileDir: dir }),
      'forbidden_custom_code',
    )
    const files = (err.detail as { files: string[] }).files
    expect(files.sort()).toEqual(['tools/a.ts', 'tools/b.js', 'tools/sub/c.mjs'].sort())
  })
})
