/**
 * End-to-end tests for the Phase 2 update pipeline.
 *
 * Reuses the bare-repo fixture pattern from the install integration
 * tests. Each test exercises a real install → simulated upstream change
 * → check → apply (overwrite/fork/keep) → verify.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installProfileFromGithub } from '../../../src/profile/install/install-from-github.js'
import { isGitAvailable } from '../../../src/profile/install/clone.js'
import {
  checkProfileUpdate,
  applyProfileUpdate,
  findProfilesForRepo,
  detectLocalEdits,
} from '../../../src/profile/update/index.js'

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
  githubUrl: string
  pushFiles: (files: Record<string, string>, opts?: { branch?: string }) => Promise<string>
}

async function makeBareRepo(): Promise<FakeRepo> {
  const root = await makeTempDir('cortex-bare-')
  const bareDir = join(root, 'remote.git')
  const workDir = join(root, 'work')
  await mkdir(bareDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  runSync(['git', 'init', '--bare', '--initial-branch=main', bareDir])
  runSync(['git', 'init', '--initial-branch=main', workDir])
  runSync(['git', '-C', workDir, 'config', 'user.email', 't@e.com'])
  runSync(['git', '-C', workDir, 'config', 'user.name', 'T'])
  runSync(['git', '-C', workDir, 'config', 'commit.gpgsign', 'false'])
  runSync(['git', '-C', workDir, 'remote', 'add', 'origin', bareDir])
  return {
    cloneUrl: `file://${bareDir}`,
    githubUrl: 'https://github.com/acme/finance',
    pushFiles: async (files, opts) => {
      const branch = opts?.branch ?? 'main'
      const exists = spawnSync('git', ['-C', workDir, 'rev-parse', '--verify', branch], { stdio: 'ignore' }).status === 0
      if (exists) {
        runSync(['git', '-C', workDir, 'checkout', branch])
      } else {
        runSync(['git', '-C', workDir, 'checkout', '-B', branch])
      }
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(workDir, rel)
        await mkdir(join(abs, '..'), { recursive: true })
        await writeFile(abs, content)
      }
      runSync(['git', '-C', workDir, 'add', '-A'])
      runSync(['git', '-C', workDir, 'commit', '-m', `update ${branch}`])
      runSync(['git', '-C', workDir, 'push', 'origin', branch])
      return spawnSync('git', ['-C', workDir, 'rev-parse', branch], { encoding: 'utf-8' }).stdout.trim()
    },
  }
}

async function gitWrapper(bare: FakeRepo): Promise<string> {
  const wrapperDir = await makeTempDir('cortex-git-wrapper-')
  const wrapperPath = join(wrapperDir, 'git-wrapper.sh')
  const wrapperSrc = `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [ "$a" = "https://github.com/acme/finance.git" ]; then
    args+=("${bare.cloneUrl}")
  else
    args+=("$a")
  fi
done
exec git "\${args[@]}"
`
  await writeFile(wrapperPath, wrapperSrc, { mode: 0o755 })
  return wrapperPath
}

async function installFromBare(bare: FakeRepo, dataDir: string): Promise<void> {
  const wrapper = await gitWrapper(bare)
  await installProfileFromGithub({
    url: bare.githubUrl,
    dataDir,
    gitBinary: wrapper,
  })
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

const MANIFEST = (extras: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1,
  id: 'acme/finance',
  summary: 'Finance',
  profiles: [{ name: 'finance', path: 'profiles/finance' }],
  ...extras,
})

// ---------------------------------------------------------------------------
// detectLocalEdits
// ---------------------------------------------------------------------------

describe('detectLocalEdits', () => {
  it('returns "unmodified" right after install', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/SOUL.md': '# v1',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    const sidecar = JSON.parse(await readFile(join(dir, '.ownware-origin.json'), 'utf-8'))
    expect(await detectLocalEdits(dir, sidecar)).toBe('unmodified')
  })

  it('detects "modified" after the user edits a file', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    const sidecar = JSON.parse(await readFile(join(dir, '.ownware-origin.json'), 'utf-8'))
    await writeFile(join(dir, 'SOUL.md'), '# user edit')
    expect(await detectLocalEdits(dir, sidecar)).toBe('modified')
  })

  it('returns "no-sidecar" for an unknown dir', async () => {
    const dir = await makeTempDir('cortex-loose-')
    await writeFile(join(dir, 'agent.json'), '{"name":"loose"}')
    expect(await detectLocalEdits(dir, null)).toBe('no-sidecar')
  })

  it('returns "not-tracked" for a fork sidecar', async () => {
    const dir = await makeTempDir('cortex-fork-')
    expect(await detectLocalEdits(dir, {
      kind: 'fork', forkedFrom: 'x', forkedAtHash: 'abc',
    })).toBe('not-tracked')
  })

  it('returns "unknown" when the github sidecar lacks installedHash', async () => {
    const dir = await makeTempDir('cortex-legacy-')
    await writeFile(join(dir, 'agent.json'), '{"name":"x"}')
    expect(await detectLocalEdits(dir, {
      kind: 'github',
      repoUrl: 'https://github.com/x/y.git',
      ref: 'main',
      commit: 'abc',
      repoId: 'x/y',
      installedAt: '2026-01-01T00:00:00Z',
    })).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// checkProfileUpdate
// ---------------------------------------------------------------------------

describe('checkProfileUpdate', () => {
  it('returns up-to-date when remote has not changed', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    // Use local file:// URL by rewriting sidecar (tests can't have real
    // github reach a local bare repo). Replace repoUrl with file URL.
    const sidecarPath = join(dir, '.ownware-origin.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'))
    sidecar.repoUrl = bare.cloneUrl
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('up-to-date')
  })

  it('returns update-available when remote has new commits + flags unmodified', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    // Rewrite sidecar to point at file:// bare.
    const sidecarPath = join(dir, '.ownware-origin.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'))
    sidecar.repoUrl = bare.cloneUrl
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    // Push a new commit upstream
    const newSha = await bare.pushFiles({
      'profiles/finance/SOUL.md': '# new soul',
    })

    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('update-available')
    if (result.state !== 'update-available') return
    expect(result.remoteCommit).toBe(newSha)
    expect(result.localEdits).toBe('unmodified')
    expect(result.compareUrl).toContain('/compare/')
  })

  it('flags localEdits as "modified" when user has edited the dir', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    const sidecarPath = join(dir, '.ownware-origin.json')
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8'))
    sidecar.repoUrl = bare.cloneUrl
    await writeFile(sidecarPath, JSON.stringify(sidecar))

    await bare.pushFiles({ 'profiles/finance/SOUL.md': '# remote new' })
    await writeFile(join(dir, 'AGENTS.md'), '# my notes')

    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('update-available')
    if (result.state !== 'update-available') return
    expect(result.localEdits).toBe('modified')
  })

  it('returns source-unavailable for a missing repo URL', async () => {
    const dir = await makeTempDir('cortex-missing-')
    await writeFile(join(dir, '.ownware-origin.json'), JSON.stringify({
      kind: 'github',
      repoUrl: 'file:///nonexistent/missing.git',
      ref: 'main',
      commit: 'abc',
      repoId: 'x/y',
      installedAt: '2026-01-01T00:00:00Z',
    }))
    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('source-unavailable')
  })

  it('returns not-trackable for fork sidecars', async () => {
    const dir = await makeTempDir('cortex-fork-sidecar-')
    await writeFile(join(dir, '.ownware-origin.json'), JSON.stringify({
      kind: 'fork', forkedFrom: 'x', forkedAtHash: 'abc',
    }))
    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('not-trackable')
  })

  it('returns not-trackable when no sidecar exists', async () => {
    const dir = await makeTempDir('cortex-no-side-')
    await writeFile(join(dir, 'agent.json'), '{"name":"x"}')
    const result = await checkProfileUpdate({ profileDir: dir })
    expect(result.state).toBe('not-trackable')
  })
})

// ---------------------------------------------------------------------------
// findProfilesForRepo
// ---------------------------------------------------------------------------

describe('findProfilesForRepo', () => {
  it('finds every dir whose sidecar matches the repoId', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': JSON.stringify({
        schema: 1, id: 'acme/finance', summary: 's',
        profiles: [
          { name: 'finance', path: 'profiles/finance' },
          { name: 'planner', path: 'profiles/planner' },
        ],
      }),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/planner/agent.json': JSON.stringify({ name: 'planner' }),
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const found = await findProfilesForRepo(dataDir, 'acme/finance')
    expect(found.map((f) => f.dir.split('/').pop()).sort()).toEqual([
      'acme__finance__finance',
      'acme__finance__planner',
    ])
  })

  it('returns empty when nothing matches', async () => {
    const dataDir = await makeTempDir('cortex-data-')
    expect(await findProfilesForRepo(dataDir, 'nope/nope')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// applyProfileUpdate — strategies
// ---------------------------------------------------------------------------

describe('applyProfileUpdate: keep', () => {
  it('writes dismissedAt without touching files', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/SOUL.md': '# v1',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    const before = await readFile(join(dir, 'SOUL.md'), 'utf-8')

    const result = await applyProfileUpdate({
      repoId: 'acme/finance',
      strategy: 'keep',
      dataDir,
    })
    expect(result.strategy).toBe('keep')
    expect(result.affectedDirs).toHaveLength(1)

    // File untouched.
    expect(await readFile(join(dir, 'SOUL.md'), 'utf-8')).toBe(before)
    // Sidecar gained dismissedAt.
    const sc = JSON.parse(await readFile(join(dir, '.ownware-origin.json'), 'utf-8'))
    expect(typeof sc.dismissedAt).toBe('string')
  })
})

describe('applyProfileUpdate: overwrite', () => {
  it('replaces local files with the new remote contents', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/SOUL.md': '# v1',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    expect(await readFile(join(dir, 'SOUL.md'), 'utf-8')).toBe('# v1')

    // Push v2.
    await bare.pushFiles({ 'profiles/finance/SOUL.md': '# v2' })

    const wrapper = await gitWrapper(bare)
    // The apply path will try to clone via the repoUrl in sidecar
    // (https://github.com/acme/finance.git). Wrapper rewrites it.
    const result = await applyProfileUpdate({
      repoId: 'acme/finance',
      strategy: 'overwrite',
      dataDir,
      gitBinary: wrapper,
    })
    expect(result.strategy).toBe('overwrite')
    expect(await readFile(join(dir, 'SOUL.md'), 'utf-8')).toBe('# v2')

    // Staging dir cleaned up.
    let stagingExists = false
    try {
      const entries = await readdir(join(dataDir, '.staging'))
      stagingExists = entries.length > 0
    } catch { /* */ }
    expect(stagingExists).toBe(false)
  })

  it('rolls back to old contents when fresh install fails', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/SOUL.md': '# v1',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')

    // Push a v2 that has forbidden custom code so install will reject.
    await bare.pushFiles({
      'profiles/finance/tools/evil.ts': 'export const x = 1',
    })

    const wrapper = await gitWrapper(bare)
    let caught: unknown
    try {
      await applyProfileUpdate({
        repoId: 'acme/finance',
        strategy: 'overwrite',
        dataDir,
        gitBinary: wrapper,
      })
    } catch (err) { caught = err }
    expect(caught).toBeDefined()
    // Old contents restored.
    expect(await fileExists(dir)).toBe(true)
    expect(await readFile(join(dir, 'SOUL.md'), 'utf-8')).toBe('# v1')
  })
})

describe('applyProfileUpdate: fork', () => {
  it('preserves user edits as a __local-* dir while installing the new version', async () => {
    if (!gitOk) return
    const bare = await makeBareRepo()
    await bare.pushFiles({
      'cortex.profile.json': MANIFEST(),
      'profiles/finance/agent.json': JSON.stringify({ name: 'finance' }),
      'profiles/finance/SOUL.md': '# v1',
    })
    const dataDir = await makeTempDir('cortex-data-')
    await installFromBare(bare, dataDir)
    const dir = join(dataDir, 'profiles', 'acme__finance__finance')
    // User edit
    await writeFile(join(dir, 'AGENTS.md'), '# my notes')
    // Remote v2
    await bare.pushFiles({ 'profiles/finance/SOUL.md': '# v2' })

    const wrapper = await gitWrapper(bare)
    const result = await applyProfileUpdate({
      repoId: 'acme/finance',
      strategy: 'fork',
      dataDir,
      gitBinary: wrapper,
    })
    expect(result.strategy).toBe('fork')
    expect(result.forkedDirs).toHaveLength(1)

    // New v2 sits at the original dir name.
    expect(await readFile(join(dir, 'SOUL.md'), 'utf-8')).toBe('# v2')
    // User's edit preserved in the forked dir.
    const forked = result.forkedDirs[0]!
    expect(await fileExists(forked)).toBe(true)
    expect(await readFile(join(forked, 'AGENTS.md'), 'utf-8')).toBe('# my notes')
  })
})
