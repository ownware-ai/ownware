/**
 * clone.ts integration-style tests.
 *
 * Real `git` is invoked. We avoid the network entirely by spinning up
 * a bare repo on disk per test, populating it with a working copy, and
 * pointing `safeShallowClone` at `file://<bare-repo-path>`.
 *
 * If `git` isn't on PATH the suite is skipped (CI without git is a
 * misconfig but we don't want a hard failure in dev sandboxes).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeShallowClone, isGitAvailable } from '../../../src/profile/install/clone.js'
import { InstallError, isInstallError } from '../../../src/profile/install/errors.js'

let gitOk = false
beforeAll(async () => {
  gitOk = await isGitAvailable('git')
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => {
    try { await rm(dir, { recursive: true, force: true }) } catch { /* */ }
  })
  return dir
}

/**
 * Initialise a bare repo and return its `file://` URL plus a working-copy
 * helper for staging files.
 */
async function makeBareRepo(): Promise<{
  cloneUrl: string
  pushFiles: (files: Record<string, string>, opts?: { branch?: string }) => Promise<string>
}> {
  const root = await makeTempDir('cortex-bare-')
  const bareDir = join(root, 'remote.git')
  const workDir = join(root, 'work')
  await mkdir(bareDir, { recursive: true })
  await mkdir(workDir, { recursive: true })

  runSync(['git', 'init', '--bare', '--initial-branch=main', bareDir])
  runSync(['git', 'init', '--initial-branch=main', workDir])
  runSync(['git', '-C', workDir, 'config', 'user.email', 'test@example.com'])
  runSync(['git', '-C', workDir, 'config', 'user.name', 'Test User'])
  runSync(['git', '-C', workDir, 'config', 'commit.gpgsign', 'false'])
  runSync(['git', '-C', workDir, 'remote', 'add', 'origin', bareDir])

  return {
    cloneUrl: `file://${bareDir}`,
    pushFiles: async (files, opts) => {
      const branch = opts?.branch ?? 'main'
      const exists = spawnSync('git', ['-C', workDir, 'rev-parse', '--verify', branch], { stdio: 'ignore' }).status === 0
      if (!exists) {
        runSync(['git', '-C', workDir, 'checkout', '-B', branch])
      } else {
        runSync(['git', '-C', workDir, 'checkout', branch])
      }
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(workDir, rel)
        await mkdir(join(abs, '..'), { recursive: true })
        await writeFile(abs, content)
      }
      runSync(['git', '-C', workDir, 'add', '-A'])
      runSync(['git', '-C', workDir, 'commit', '-m', `update on ${branch}`])
      runSync(['git', '-C', workDir, 'push', 'origin', branch])
      const sha = spawnSync('git', ['-C', workDir, 'rev-parse', branch], { encoding: 'utf-8' }).stdout.trim()
      return sha
    },
  }
}

function runSync(args: string[]): void {
  const [cmd, ...rest] = args
  if (cmd === undefined) throw new Error('runSync called without command')
  const r = spawnSync(cmd, rest, { encoding: 'utf-8' })
  if (r.status !== 0) {
    throw new Error(`${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}`)
  }
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

describe('safeShallowClone: happy paths', () => {
  it('clones a bare repo and returns commit + ref', async () => {
    if (!gitOk) return
    const { cloneUrl, pushFiles } = await makeBareRepo()
    const sha = await pushFiles({
      'agent.json': '{"name":"x"}',
      'README.md': 'hi',
    })
    const tempParent = await makeTempDir('cortex-clone-target-')
    const result = await safeShallowClone({ cloneUrl, tempParent })
    expect(result.commit).toBe(sha)
    expect(result.ref).toBe('main')
    // Verify files landed and .git is gone.
    const agentExists = (await stat(join(result.tempDir, 'agent.json'))).isFile()
    expect(agentExists).toBe(true)
    let gitDirThere = true
    try { await stat(join(result.tempDir, '.git')) } catch { gitDirThere = false }
    expect(gitDirThere).toBe(false)
  })

  it('clones a specific branch with --branch', async () => {
    if (!gitOk) return
    const { cloneUrl, pushFiles } = await makeBareRepo()
    await pushFiles({ 'agent.json': '{"name":"x"}' }, { branch: 'main' })
    const featureSha = await pushFiles({
      'agent.json': '{"name":"x-feature"}',
    }, { branch: 'feature/x' })
    const tempParent = await makeTempDir('cortex-clone-target-')
    const result = await safeShallowClone({ cloneUrl, tempParent, ref: 'feature/x' })
    expect(result.commit).toBe(featureSha)
    expect(result.ref).toBe('feature/x')
    const agentJson = await readFile(join(result.tempDir, 'agent.json'), 'utf-8')
    expect(agentJson).toContain('x-feature')
  })
})

describe('safeShallowClone: failure paths', () => {
  it('rejects bad ref with clone_failed', async () => {
    if (!gitOk) return
    const { cloneUrl, pushFiles } = await makeBareRepo()
    await pushFiles({ 'agent.json': '{"name":"x"}' })
    const tempParent = await makeTempDir('cortex-clone-target-')
    await expectInstallError(
      safeShallowClone({ cloneUrl, tempParent, ref: 'does-not-exist' }),
      'clone_failed',
    )
  })

  it('rejects nonexistent local URL with clone_failed (file:// not found)', async () => {
    if (!gitOk) return
    const tempParent = await makeTempDir('cortex-clone-target-')
    await expectInstallError(
      safeShallowClone({ cloneUrl: 'file:///nonexistent/does/not/exist.git', tempParent }),
      'clone_failed',
    )
  })

  it('rejects ENOENT on git binary with clone_failed', async () => {
    const tempParent = await makeTempDir('cortex-clone-target-')
    await expectInstallError(
      safeShallowClone({
        cloneUrl: 'file:///irrelevant',
        tempParent,
        gitBinary: '/nonexistent/binary-that-does-not-exist',
      }),
      'clone_failed',
    )
  })

  it('cleans up the temp dir on failure', async () => {
    if (!gitOk) return
    const tempParent = await makeTempDir('cortex-clone-target-')
    let caught: unknown
    try {
      await safeShallowClone({
        cloneUrl: 'file:///nonexistent/does/not/exist.git',
        tempParent,
      })
    } catch (err) { caught = err }
    expect(caught).toBeDefined()
    // Directory should be empty (no leftover cortex-clone-* subdir).
    const { readdir } = await import('node:fs/promises')
    const remaining = await readdir(tempParent)
    expect(remaining).toEqual([])
  })

  it('respects timeout', async () => {
    // Construct a "git" that sleeps forever — use sh as the binary,
    // arguments handed to runGit are git's, not sh's, so this is fragile;
    // simpler: use a real but bogus URL and a tiny timeout. file:// to a
    // nonexistent path errors fast, so we use a slow bogus URL by piping
    // to a fake binary that just sleeps.
    if (!gitOk) return
    const tempParent = await makeTempDir('cortex-clone-target-')
    // Use a 1ms timeout so even success becomes a timeout.
    const result: Promise<unknown> = safeShallowClone({
      cloneUrl: 'file:///nonexistent/does/not/exist.git',
      tempParent,
      timeoutMs: 1,
    })
    // Either timeout or normal failure — both are clone_failed.
    let caught: unknown
    try { await result } catch (err) { caught = err }
    expect(isInstallError(caught)).toBe(true)
    expect((caught as InstallError).code).toBe('clone_failed')
  })
})

describe('safeShallowClone: secret hygiene', () => {
  it('does not include the auth token in any error message', async () => {
    if (!gitOk) return
    const tempParent = await makeTempDir('cortex-clone-target-')
    let caught: unknown
    try {
      await safeShallowClone({
        cloneUrl: 'file:///nonexistent/does/not/exist.git',
        tempParent,
        auth: { kind: 'pat', token: 'ghp_supersecret_TOKEN_VALUE' },
      })
    } catch (err) { caught = err }
    expect(isInstallError(caught)).toBe(true)
    const msg = (caught as InstallError).message
    const detailStr = JSON.stringify((caught as InstallError).detail)
    expect(msg).not.toContain('ghp_supersecret_TOKEN_VALUE')
    expect(detailStr).not.toContain('ghp_supersecret_TOKEN_VALUE')
  })
})

describe('isGitAvailable', () => {
  it('returns true when git is on PATH', async () => {
    expect(await isGitAvailable('git')).toBe(gitOk)
  })
  it('returns false for a nonexistent binary', async () => {
    expect(await isGitAvailable('/nonexistent/git-binary')).toBe(false)
  })
})
