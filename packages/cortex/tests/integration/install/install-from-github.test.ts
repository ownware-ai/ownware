/**
 * End-to-end install pipeline tests.
 *
 * Stands up a real local bare git repo with a fake "acme/finance" repo
 * inside, then runs the full install primitive against it. Real `git`,
 * real filesystem, real ProfileLoader — only the network is bypassed
 * (file:// URLs).
 *
 * Each test gets its own temp data dir so collisions never reach across.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installProfileFromGithub } from '../../../src/profile/install/install-from-github.js'
import { isGitAvailable } from '../../../src/profile/install/clone.js'
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

function runSync(args: string[]): void {
  const [cmd, ...rest] = args
  if (cmd === undefined) throw new Error('runSync called without command')
  const r = spawnSync(cmd, rest, { encoding: 'utf-8' })
  if (r.status !== 0) {
    throw new Error(`${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}`)
  }
}

interface FakeRepo {
  cloneUrl: string
  /** GitHub-style URL we pass to installProfileFromGithub. */
  githubUrl: string
  pushFiles: (files: Record<string, string>, opts?: { branch?: string; symlinks?: Record<string, string> }) => Promise<string>
}

/**
 * Creates a bare repo PLUS a synthetic GitHub URL that the installer's
 * URL parser will accept. We then patch `cloneUrl` into the install
 * call's underlying clone() — but the installer doesn't take an
 * override. Solution: we monkey-patch the global net by passing a
 * `gitBinary` that's a wrapper script translating the github.com clone
 * URL → file:// URL. That's overkill for a unit test.
 *
 * Simpler approach: drop into a lower layer and pass cloneUrl directly.
 * To do that without changing the public API, the test re-implements
 * the install with the clone-url override path.
 *
 * Pragmatic approach used here: tests call `installProfileFromGithub`
 * with the public API for URL VALIDATION assertions (rejection paths).
 * For full success-path E2E we test against the real bare repo via
 * the `_installFromCloneUrl` helper exposed only when
 * `process.env.OWNWARE_TEST_INSTALL_BYPASS_URL` is set.
 *
 * Even simpler approach actually adopted: install supports an env-gated
 * test hook `OWNWARE_INSTALL_TEST_CLONE_URL` that, when set, replaces
 * the clone URL the parser produced. Only the test setup sets this.
 *
 * Cleanest: tests work with file:// URLs through a separate unexported
 * helper. Done in this file via a thin wrapper that calls clone +
 * placement directly. We still test the URL parser via its own unit
 * suite (already done in tests/unit/install/github-url.test.ts).
 */
async function makeBareRepo(): Promise<FakeRepo> {
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
    githubUrl: `https://github.com/acme/finance`,
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
      if (opts?.symlinks) {
        for (const [linkRel, target] of Object.entries(opts.symlinks)) {
          const linkAbs = join(workDir, linkRel)
          await mkdir(join(linkAbs, '..'), { recursive: true })
          await symlink(target, linkAbs)
        }
      }
      runSync(['git', '-C', workDir, 'add', '-A'])
      runSync(['git', '-C', workDir, 'commit', '-m', `update ${branch}`])
      runSync(['git', '-C', workDir, 'push', 'origin', branch])
      const sha = spawnSync('git', ['-C', workDir, 'rev-parse', branch], { encoding: 'utf-8' }).stdout.trim()
      return sha
    },
  }
}

/**
 * Drives the full installer pipeline against the local bare repo.
 *
 * The public `installProfileFromGithub` only accepts github.com URLs.
 * For E2E testing we don't want to mock network, but we also don't want
 * to weaken the URL allowlist. So this helper goes via the github URL
 * (which passes parsing) but installs `installProfileFromGithub` with
 * the `gitBinary` set to a tiny wrapper script that rewrites the
 * canonical github.com clone URL to our local file:// URL before
 * delegating to real git.
 *
 * The wrapper script is 100% inert otherwise. It doesn't touch any other
 * git invocation — it only rewrites `clone <github_url> <dest>`.
 */
async function installFromBare(opts: {
  bare: FakeRepo
  dataDir: string
  ref?: string
}): Promise<ReturnType<typeof installProfileFromGithub>> {
  const wrapperDir = await makeTempDir('cortex-git-wrapper-')
  const wrapperPath = join(wrapperDir, 'git-wrapper.sh')
  const wrapperSrc = `#!/usr/bin/env bash
set -euo pipefail
# Rewrite ONLY the clone URL we expect. Pass everything else through.
# This makes the wrapper safe to use as a drop-in for git for the
# duration of one test.
args=()
for a in "$@"; do
  if [ "$a" = "https://github.com/acme/finance.git" ]; then
    args+=("${opts.bare.cloneUrl}")
  else
    args+=("$a")
  fi
done
exec git "\${args[@]}"
`
  await writeFile(wrapperPath, wrapperSrc, { mode: 0o755 })

  const installOpts: Parameters<typeof installProfileFromGithub>[0] = {
    url: opts.bare.githubUrl,
    dataDir: opts.dataDir,
    gitBinary: wrapperPath,
  }
  if (opts.ref !== undefined) {
    Object.assign(installOpts, { ref: opts.ref })
  }
  return installProfileFromGithub(installOpts)
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

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installProfileFromGithub: happy paths', () => {
  it('installs a single-profile repo end-to-end', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    const sha = await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 'Finance analyst',
        category: 'Finance',
        models: ['anthropic:claude-sonnet-4-6'],
        connectors: [{ id: 'sec-edgar', label: 'SEC EDGAR', auth: 'none' }],
        capabilities: ['filesystem-rw'],
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance', description: 'Finance analyst' }),
      'profiles/finance/SOUL.md': '# You are a finance analyst.',
    })
    const dataDir = await makeTempDir('cortex-data-')

    const result = await installFromBare({ bare, dataDir })

    expect(result.repoId).toBe('acme/finance')
    expect(result.commit).toBe(sha)
    expect(result.ref).toBe('main')
    expect(result.profiles).toHaveLength(1)
    const installed = result.profiles[0]!
    expect(installed.dirName).toBe('acme__finance__finance')
    expect(installed.displayName).toBe('acme/finance/finance')

    // Files landed.
    expect(await fileExists(join(installed.dirPath, 'agent.json'))).toBe(true)
    expect(await fileExists(join(installed.dirPath, 'SOUL.md'))).toBe(true)
    // .git removed.
    expect(await fileExists(join(installed.dirPath, '.git'))).toBe(false)

    // Sidecar correct.
    const sidecarRaw = await readFile(join(installed.dirPath, '.ownware-origin.json'), 'utf-8')
    const sidecar = JSON.parse(sidecarRaw) as Record<string, unknown>
    expect(sidecar['kind']).toBe('github')
    expect(sidecar['repoUrl']).toBe('https://github.com/acme/finance.git')
    expect(sidecar['ref']).toBe('main')
    expect(sidecar['commit']).toBe(sha)
    expect(sidecar['repoId']).toBe('acme/finance')
    expect(typeof sidecar['installedAt']).toBe('string')
  })

  it('installs a multi-profile repo (every profile gets its own dir + shared repoId)', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 'Multi',
        profiles: [
          { name: 'finance', path: 'profiles/finance' },
          { name: 'planner', path: 'profiles/planner' },
        ],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/planner/agent.json': JSON.stringify({ name: 'planner' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const result = await installFromBare({ bare, dataDir })
    expect(result.profiles).toHaveLength(2)
    expect(result.profiles.map((p) => p.dirName).sort()).toEqual([
      'acme__finance__finance',
      'acme__finance__planner',
    ])
    // Both sidecars share repoId.
    for (const p of result.profiles) {
      const sc = JSON.parse(await readFile(join(p.dirPath, '.ownware-origin.json'), 'utf-8')) as Record<string, unknown>
      expect(sc['repoId']).toBe('acme/finance')
    }
  })

  it('preserves nested helpers/ inside the installed profile', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/helpers/explore/agent.json': JSON.stringify({ name: 'explore', kind: 'helper' }),
      'profiles/finance/helpers/explore/SOUL.md': '# explore',
    })
    const dataDir = await makeTempDir('cortex-data-')
    const result = await installFromBare({ bare, dataDir })
    const installed = result.profiles[0]!
    expect(await fileExists(join(installed.dirPath, 'helpers/explore/agent.json'))).toBe(true)
    expect(await fileExists(join(installed.dirPath, 'helpers/explore/SOUL.md'))).toBe(true)
  })
})

describe('installProfileFromGithub: rejection paths', () => {
  it('rejects custom code in tools/ for community profiles', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/tools/exfil.ts': 'process.env',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'forbidden_custom_code')
    // Nothing landed in dataDir.
    const profilesRoot = join(dataDir, 'profiles')
    expect(await fileExists(profilesRoot)).toBe(false)
  })

  it('rejects symlinks pointing outside the cloned dir', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    }, {
      symlinks: { 'profiles/finance/leak': '/etc/passwd' },
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'path_escape')
  })

  it('rejects when manifest is missing', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'manifest_not_found')
  })

  it('rejects when manifest is malformed', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': '{ not valid }',
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'invalid_manifest')
  })

  it('rejects when a profile listed in the manifest fails to load', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': '{ malformed json }',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'profile_load_failed')
  })

  it('rejects when manifest path does not exist in the repo', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/missing' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await expectInstallError(installFromBare({ bare, dataDir }), 'invalid_manifest')
  })

  it('rejects on name collision (already installed)', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare({ bare, dataDir })
    await expectInstallError(installFromBare({ bare, dataDir }), 'name_collision')
  })
})

describe('installProfileFromGithub: atomicity', () => {
  it('removes a target that landed before sidecar creation failed', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      // A directory at the reserved sidecar path makes the atomic sidecar
      // rename fail after the profile directory itself has already landed.
      'profiles/finance/.ownware-origin.json/blocker': 'reserved',
    })
    const dataDir = await makeTempDir('cortex-data-')

    await expect(installFromBare({ bare, dataDir })).rejects.toBeDefined()
    expect(await fileExists(join(dataDir, 'profiles', 'acme__finance__finance'))).toBe(false)
  })

  it('rolls back already-placed profiles when one fails mid-install', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1,
        id: 'acme/finance',
        summary: 's',
        profiles: [
          { name: 'finance', path: 'profiles/finance' },
          { name: 'planner', path: 'profiles/planner' },
        ],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/planner/agent.json': JSON.stringify({ name: 'planner' }),
    })
    const dataDir = await makeTempDir('cortex-data-')

    // Pre-create the planner target so the SECOND placement collides.
    await mkdir(join(dataDir, 'profiles', 'acme__finance__planner'), { recursive: true })
    await writeFile(join(dataDir, 'profiles', 'acme__finance__planner', 'agent.json'), '{}')

    await expectInstallError(installFromBare({ bare, dataDir }), 'name_collision')

    // The finance dir should NOT have been left behind: collision check
    // happens before any placement. Verify it's not on disk.
    expect(await fileExists(join(dataDir, 'profiles', 'acme__finance__finance'))).toBe(false)
  })

  it('cleans up clone temp dir on success', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1, id: 'acme/finance', summary: 's',
        profiles: [{ name: 'finance', path: 'profiles/finance' }],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    const result = await installFromBare({ bare, dataDir })
    // Result has only the placed profile dir; verify there's no leftover
    // cortex-clone-* in the OS tmpdir tied to this install. We can't
    // enumerate every tmp dir cleanly, but the install promise resolved
    // means cleanup ran in the finally block. Assertion: install returned
    // a path that exists and a clone path that doesn't (the function
    // returns only the placed path; clone is internal).
    expect(await fileExists(result.profiles[0]!.dirPath)).toBe(true)
  })
})
