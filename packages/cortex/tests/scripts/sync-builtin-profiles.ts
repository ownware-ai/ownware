#!/usr/bin/env node
/**
 * sync-builtin-profiles — pulls builtin profiles from a private GitHub
 * repo into `packages/cortex/profiles/` at app build time.
 *
 * Modes:
 *
 *   --check   (default in CI)
 *     Verify that `packages/cortex/profiles/<name>/` matches the
 *     content in the private repo at the pinned commit. Exit 0 on
 *     match, 1 on drift (with a list of drifted profiles).
 *
 *   --write
 *     Replace local builtin dirs with the private-repo content. Used
 *     by the release branch's automated bump PR — humans never run
 *     this on main.
 *
 *   --dry-run
 *     Show what --write WOULD do without touching disk.
 *
 * Source repo + ref are read from env vars so they never appear in
 * source control:
 *
 *   BUILTIN_PROFILES_REPO    e.g. "ownware/builtin-profiles"  (required)
 *   BUILTIN_PROFILES_REF     branch / tag / sha               (default: 'main')
 *   BUILTIN_PROFILES_TOKEN   GitHub PAT, repo:read scope only (required)
 *
 * Token is used ONCE for the clone and never written anywhere. The
 * shipped binary contains the profile content (which is about to be
 * public anyway via the marketplace) and a sidecar
 * `kind: 'builtin-bundle'` recording the source commit.
 *
 * Builtins are exempt from the install-time custom-code rejection —
 * because we wrote them and reviewed them. The validate-tree gate is
 * called with `allowCustomCode: true`.
 */

import { spawnSync } from 'node:child_process'
import {
  cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ORIGIN_SIDECAR_FILE,
  type OriginSidecarBuiltinBundle,
} from '../../src/profile/registry.js'
import { hashProfileDir } from '../../src/profile/dir-hash.js'
import { validateTree } from '../../src/profile/install/validate-tree.js'
import { loadProfile } from '../../src/profile/loader.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = resolve(__dirname, '..')
const BUILTIN_PROFILES_DIR = join(PACKAGE_ROOT, 'profiles')

interface Mode {
  check: boolean
  write: boolean
  dryRun: boolean
}

function parseMode(argv: string[]): Mode {
  const mode: Mode = { check: false, write: false, dryRun: false }
  for (const arg of argv) {
    if (arg === '--check') mode.check = true
    else if (arg === '--write') mode.write = true
    else if (arg === '--dry-run') mode.dryRun = true
  }
  if (!mode.check && !mode.write) mode.check = true   // default
  if (mode.check && mode.write) {
    fail('cannot pass both --check and --write')
  }
  return mode
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2))
  const repo = process.env['BUILTIN_PROFILES_REPO']
  const ref = process.env['BUILTIN_PROFILES_REF'] ?? 'main'
  const token = process.env['BUILTIN_PROFILES_TOKEN']

  if (!repo) fail('BUILTIN_PROFILES_REPO env var required')
  if (!token) fail('BUILTIN_PROFILES_TOKEN env var required')

  const cloneDir = await mkdtemp(join(tmpdir(), 'cortex-builtin-sync-'))
  try {
    log(`cloning ${repo}#${ref} → ${cloneDir}`)
    cloneRepo({ repo: repo!, ref, token: token!, dir: cloneDir })

    const commit = headCommit(cloneDir)
    log(`pinned commit: ${commit}`)

    const sourceProfilesDir = join(cloneDir, 'profiles')
    const profileNames = await listProfileDirs(sourceProfilesDir)
    if (profileNames.length === 0) {
      fail(`no profile directories found at ${sourceProfilesDir}/profiles/`)
    }
    log(`found ${profileNames.length} builtin profiles in private repo: ${profileNames.join(', ')}`)

    // Validate every profile loads + passes the tree gate (with the
    // builtin exemption for custom code). Catch issues BEFORE we
    // touch the local builtin dir.
    for (const name of profileNames) {
      const dir = join(sourceProfilesDir, name)
      await validateTree({ profileDir: dir, allowCustomCode: true })
      await loadProfile(dir)
    }
    log('every private-repo profile passes validation + load')

    // Compare or write.
    if (mode.write) {
      await writeBuiltins({
        sourceDir: sourceProfilesDir,
        names: profileNames,
        repo: repo!,
        commit,
        dryRun: mode.dryRun,
      })
    } else {
      const drifted = await checkBuiltins({
        sourceDir: sourceProfilesDir,
        names: profileNames,
        repo: repo!,
        commit,
      })
      if (drifted.length > 0) {
        console.error('\n[sync-builtin-profiles] DRIFT detected for:')
        for (const d of drifted) console.error(`  - ${d}`)
        console.error('\nRun with --write on the release branch to refresh.')
        process.exit(1)
      }
      log('all builtin profiles in sync with private repo')
    }
  } finally {
    try { await rm(cloneDir, { recursive: true, force: true }) } catch { /* */ }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function cloneRepo(opts: {
  repo: string
  ref: string
  token: string
  dir: string
}): void {
  // Token-in-URL (Basic auth via `x-access-token:<token>@host/`) works
  // for BOTH classic PATs and fine-grained PATs. The previous form —
  // `--config http.extraHeader=Authorization: Bearer <token>` — was
  // silently ignored for fine-grained PATs (git fell through to its
  // interactive credential prompt and failed non-interactively with
  // "could not read Username"). The clone is into a temp dir which is
  // `rm -rf`'d at the end of `main()` regardless of outcome, so the
  // token's persistence in `.git/config` is bounded to that lifetime.
  const url = `https://x-access-token:${opts.token}@github.com/${opts.repo}.git`
  const args = [
    'clone',
    '--depth', '1',
    '--single-branch',
    '--branch', opts.ref,
    '--no-tags',
    '--', url, opts.dir,
  ]
  const r = spawnSync('git', args, {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      LANG: 'C',
    },
  })
  if (r.status !== 0) {
    // Scrub token from any stderr that escaped before failing.
    const safe = (r.stderr ?? '').split(opts.token).join('***')
    fail(`git clone failed: ${safe}`)
  }
}

function headCommit(repoDir: string): string {
  const r = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' })
  if (r.status !== 0) fail(`failed to read HEAD: ${r.stderr}`)
  return r.stdout.trim()
}

async function listProfileDirs(rootDir: string): Promise<string[]> {
  let entries: string[]
  try { entries = await readdir(rootDir) } catch {
    return []
  }
  const names: string[] = []
  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const dir = join(rootDir, name)
    const s = await safeStat(dir)
    if (!s?.isDirectory()) continue
    if (
      await fileExists(join(dir, 'agent.json')) ||
      await fileExists(join(dir, 'agent.yaml')) ||
      await fileExists(join(dir, 'agent.yml'))
    ) {
      names.push(name)
    }
  }
  return names.sort()
}

async function checkBuiltins(opts: {
  sourceDir: string
  names: readonly string[]
  repo: string
  commit: string
}): Promise<string[]> {
  const drifted: string[] = []
  for (const name of opts.names) {
    const sourceProfile = join(opts.sourceDir, name)
    const localProfile = join(BUILTIN_PROFILES_DIR, name)
    const localExists = await fileExists(join(localProfile, 'agent.json')) ||
      await fileExists(join(localProfile, 'agent.yaml')) ||
      await fileExists(join(localProfile, 'agent.yml'))
    if (!localExists) {
      drifted.push(`${name}: not present locally (would be added)`)
      continue
    }
    const sourceHash = await hashProfileDir(sourceProfile)
    const localHash = await hashProfileDir(localProfile)
    if (sourceHash !== localHash) {
      drifted.push(`${name}: content differs from private repo`)
      continue
    }
    // Sidecar must point at the expected repo + commit.
    const sidecar = await readSidecar(localProfile)
    if (sidecar === null || sidecar.bundledFrom !== opts.repo || sidecar.bundleVersion !== opts.commit) {
      drifted.push(`${name}: sidecar repo/commit out of date`)
    }
  }
  // Local-only profiles that aren't in the private repo are NOT drift —
  // they're profiles authored locally (default, coder, etc.). Don't
  // touch them.
  return drifted
}

async function writeBuiltins(opts: {
  sourceDir: string
  names: readonly string[]
  repo: string
  commit: string
  dryRun: boolean
}): Promise<void> {
  for (const name of opts.names) {
    const sourceProfile = join(opts.sourceDir, name)
    const localProfile = join(BUILTIN_PROFILES_DIR, name)
    if (opts.dryRun) {
      log(`[dry-run] would replace ${localProfile} with ${sourceProfile}`)
      continue
    }
    log(`writing ${name}`)
    // Atomic-ish: rename existing (if any) to a tmp name, copy fresh,
    // then drop the tmp on success.
    let backup: string | null = null
    try {
      const exists = await fileExists(join(localProfile, 'agent.json')) ||
        await fileExists(join(localProfile, 'agent.yaml')) ||
        await fileExists(join(localProfile, 'agent.yml'))
      if (exists) {
        backup = `${localProfile}.bak-${Date.now()}`
        await renameDir(localProfile, backup)
      }
      await mkdir(dirname(localProfile), { recursive: true })
      await cp(sourceProfile, localProfile, { recursive: true })
      const sidecar: OriginSidecarBuiltinBundle = {
        kind: 'builtin-bundle',
        bundledFrom: opts.repo,
        bundleVersion: opts.commit,
      }
      await writeFile(
        join(localProfile, ORIGIN_SIDECAR_FILE),
        JSON.stringify(sidecar, null, 2),
        { encoding: 'utf-8' },
      )
      if (backup !== null) {
        await rm(backup, { recursive: true, force: true })
      }
    } catch (err) {
      // Roll back on failure
      if (backup !== null) {
        try { await rm(localProfile, { recursive: true, force: true }) } catch { /* */ }
        try { await renameDir(backup, localProfile) } catch { /* */ }
      }
      throw err
    }
  }
}

async function readSidecar(profileDir: string): Promise<OriginSidecarBuiltinBundle | null> {
  let raw: string
  try { raw = await readFile(join(profileDir, ORIGIN_SIDECAR_FILE), 'utf-8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (
    parsed !== null && typeof parsed === 'object' &&
    (parsed as Record<string, unknown>)['kind'] === 'builtin-bundle' &&
    typeof (parsed as Record<string, unknown>)['bundledFrom'] === 'string' &&
    typeof (parsed as Record<string, unknown>)['bundleVersion'] === 'string'
  ) {
    const o = parsed as Record<string, string>
    return {
      kind: 'builtin-bundle',
      bundledFrom: o['bundledFrom']!,
      bundleVersion: o['bundleVersion']!,
    }
  }
  return null
}

async function renameDir(from: string, to: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  try { await rename(from, to) } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EXDEV') {
      await cp(from, to, { recursive: true })
      await rm(from, { recursive: true, force: true })
      return
    }
    throw err
  }
}

async function safeStat(p: string) {
  try { return await stat(p) } catch { return null }
}

async function fileExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isFile() } catch { return false }
}

function log(msg: string): void {
  console.log(`[sync-builtin-profiles] ${msg}`)
}

function fail(msg: string): never {
  console.error(`[sync-builtin-profiles] ERROR: ${msg}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[sync-builtin-profiles] unhandled error:', err)
  process.exit(1)
})
