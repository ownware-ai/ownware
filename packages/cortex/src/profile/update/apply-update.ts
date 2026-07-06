/**
 * Apply an update to an installed github-sourced profile, with three
 * strategies:
 *
 *   - `'overwrite'` — replace the current dirs (and every sibling top-level
 *                     profile installed from the same `repoId`) with a
 *                     fresh clone of the recorded `repoUrl` at its current
 *                     remote head. Local edits are LOST.
 *   - `'fork'`      — preserve local edits by renaming each affected dir to
 *                     `<dirName>__local-<timestamp>/`, then doing an
 *                     overwrite-style fresh install. The user keeps a
 *                     standalone copy of their edits as a separate
 *                     installed profile.
 *   - `'keep'`      — no-op: write a `dismissedAt` field into each affected
 *                     sidecar so the UI can hide the "Update available"
 *                     badge until the next remote change.
 *
 * Atomicity:
 *   - `'overwrite'`: clone fresh into a temp dir under dataDir/.staging/,
 *     validate every gate, then rename the new dirs into place. The old
 *     dirs are removed only after every new dir has landed. On any failure
 *     mid-replace, the old dirs are restored from a backup we kept inside
 *     `.staging/`.
 *   - `'fork'`: rename old dirs to `*__local-*` first (atomic same-FS),
 *     then run the same fresh-install path. Failure path: rename the
 *     `*__local-*` back. The fork is permanent on success — a separate
 *     uninstall removes it.
 *   - `'keep'`: single sidecar write per dir. Idempotent.
 *
 * `repoId` matching: we treat every dir in `<dataDir>/profiles/` whose
 * sidecar's `kind === 'github'` AND `repoId === <target>` as part of the
 * same install group. Updates / fork / dismiss act on the whole group.
 */

import { mkdir, readdir, rename, rm, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ORIGIN_SIDECAR_FILE, parseOriginSidecar, type OriginSidecar } from '../registry.js'
import { atomicWriteJson } from '../install/atomic-write.js'
import { installProfileFromGithub } from '../install/install-from-github.js'
import { InstallError } from '../install/errors.js'
import type { GithubAuth } from '../install/types.js'

export type UpdateStrategy = 'overwrite' | 'fork' | 'keep'

export interface ApplyUpdateOptions {
  /** `<owner>/<repo>` — the repoId stamped into every sidecar of the
   *  group. Same value the install primitive returns as `repoId`. */
  readonly repoId: string
  readonly strategy: UpdateStrategy
  readonly dataDir: string
  /** Optional auth (private repos). Not persisted. */
  readonly auth?: GithubAuth
  /** Optional override for the `git` binary. Test hook. */
  readonly gitBinary?: string
}

export interface ApplyUpdateResult {
  readonly strategy: UpdateStrategy
  readonly affectedDirs: readonly string[]
  /** Populated for `'fork'` — the new dir names of the user's preserved
   *  edits. Empty for other strategies. */
  readonly forkedDirs: readonly string[]
}

/**
 * Resolve every installed profile dir that belongs to a given `repoId`.
 * Walks `<dataDir>/profiles/`, reads each sidecar, filters.
 */
export async function findProfilesForRepo(
  dataDir: string,
  repoId: string,
): Promise<Array<{ dir: string; sidecar: OriginSidecar }>> {
  const profilesRoot = join(resolve(dataDir), 'profiles')
  let entries: string[]
  try { entries = await readdir(profilesRoot) } catch { return [] }
  const out: Array<{ dir: string; sidecar: OriginSidecar }> = []
  for (const entry of entries) {
    const dir = join(profilesRoot, entry)
    let isDir = false
    try { isDir = (await stat(dir)).isDirectory() } catch { continue }
    if (!isDir) continue
    const sidecar = await readSidecar(dir)
    if (sidecar === null) continue
    if (sidecar.kind === 'github' && sidecar.repoId === repoId) {
      out.push({ dir, sidecar })
    }
  }
  return out
}

export async function applyProfileUpdate(opts: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const group = await findProfilesForRepo(opts.dataDir, opts.repoId)
  if (group.length === 0) {
    throw new InstallError('invalid_manifest', {
      issues: [`no installed profiles found for repoId '${opts.repoId}'`],
    })
  }

  switch (opts.strategy) {
    case 'keep':
      return applyKeep(group)
    case 'fork':
      return applyFork(opts, group)
    case 'overwrite':
      return applyOverwrite(opts, group)
  }
}

// ---------------------------------------------------------------------------
// keep — write `dismissedAt` into every sidecar in the group
// ---------------------------------------------------------------------------

async function applyKeep(
  group: Array<{ dir: string; sidecar: OriginSidecar }>,
): Promise<ApplyUpdateResult> {
  const affectedDirs: string[] = []
  for (const { dir, sidecar } of group) {
    if (sidecar.kind !== 'github') continue
    const updated = { ...sidecar, dismissedAt: new Date().toISOString() }
    await atomicWriteJson(join(dir, ORIGIN_SIDECAR_FILE), updated)
    affectedDirs.push(dir)
  }
  return { strategy: 'keep', affectedDirs, forkedDirs: [] }
}

// ---------------------------------------------------------------------------
// fork — rename current dirs to *__local-<ts>, then run overwrite-style install
// ---------------------------------------------------------------------------

async function applyFork(
  opts: ApplyUpdateOptions,
  group: Array<{ dir: string; sidecar: OriginSidecar }>,
): Promise<ApplyUpdateResult> {
  const ts = Date.now()
  const forkedDirs: string[] = []
  const renamed: Array<{ from: string; to: string }> = []
  try {
    for (const { dir } of group) {
      const to = `${dir}__local-${ts}`
      await rename(dir, to)
      renamed.push({ from: dir, to })
      forkedDirs.push(to)
      // Mark the fork's sidecar so it shows up correctly in the UI as
      // "your local copy of <repoId>". We rewrite the sidecar to keep
      // `kind: 'github'` (so update detection still applies if the user
      // wants it) but stamp a `forkOfRepoId` discriminator. Simpler:
      // leave the sidecar as-is — the dir name carries the local marker.
    }
  } catch (err) {
    // Rollback the renames we managed to do.
    for (const r of renamed.slice().reverse()) {
      try { await rename(r.to, r.from) } catch { /* */ }
    }
    throw err
  }

  // Now run a fresh install. If it fails, we restore the renames so the
  // user isn't left without their profiles.
  try {
    const sample = group[0]!.sidecar
    if (sample.kind !== 'github') throw new InstallError('invalid_manifest', { issues: ['unexpected non-github sidecar'] })
    await installProfileFromGithub({
      url: sample.repoUrl,
      ref: sample.ref,
      dataDir: opts.dataDir,
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.gitBinary !== undefined ? { gitBinary: opts.gitBinary } : {}),
    })
    return {
      strategy: 'fork',
      affectedDirs: group.map((g) => g.dir),
      forkedDirs,
    }
  } catch (err) {
    // Restore the original dir names. The fork attempt failed; the user
    // is back to their pre-update state.
    for (const r of renamed.slice().reverse()) {
      try { await rename(r.to, r.from) } catch { /* */ }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// overwrite — backup → fresh install → drop backup
// ---------------------------------------------------------------------------

async function applyOverwrite(
  opts: ApplyUpdateOptions,
  group: Array<{ dir: string; sidecar: OriginSidecar }>,
): Promise<ApplyUpdateResult> {
  // Move every existing dir into a per-call backup root inside dataDir.
  const stagingRoot = join(resolve(opts.dataDir), '.staging', `update-${Date.now()}`)
  await mkdir(stagingRoot, { recursive: true })

  const backups: Array<{ from: string; to: string }> = []
  try {
    for (const { dir } of group) {
      const to = join(stagingRoot, dir.split('/').pop() ?? 'profile')
      await rename(dir, to)
      backups.push({ from: dir, to })
    }
  } catch (err) {
    // Restore anything we already moved.
    for (const b of backups.slice().reverse()) {
      try { await rename(b.to, b.from) } catch { /* */ }
    }
    try { await rm(stagingRoot, { recursive: true, force: true }) } catch { /* */ }
    throw err
  }

  try {
    const sample = group[0]!.sidecar
    if (sample.kind !== 'github') throw new InstallError('invalid_manifest', { issues: ['unexpected non-github sidecar'] })
    await installProfileFromGithub({
      url: sample.repoUrl,
      ref: sample.ref,
      dataDir: opts.dataDir,
      ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
      ...(opts.gitBinary !== undefined ? { gitBinary: opts.gitBinary } : {}),
    })
    // Success — drop the backups.
    try { await rm(stagingRoot, { recursive: true, force: true }) } catch { /* */ }
    return {
      strategy: 'overwrite',
      affectedDirs: group.map((g) => g.dir),
      forkedDirs: [],
    }
  } catch (err) {
    // Roll back: move everything from staging back where it was.
    for (const b of backups.slice().reverse()) {
      try { await rename(b.to, b.from) } catch { /* */ }
    }
    try { await rm(stagingRoot, { recursive: true, force: true }) } catch { /* */ }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readSidecar(profileDir: string): Promise<OriginSidecar | null> {
  let raw: string
  try {
    raw = await readFile(join(profileDir, ORIGIN_SIDECAR_FILE), 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  return parseOriginSidecar(parsed)
}

// Re-export types for caller convenience.
export type { OriginSidecar }

// Used by the gateway uninstall handler in Phase 5; lives here because
// it shares the repoId-matching primitive.
export async function uninstallProfilesForRepo(
  dataDir: string,
  repoId: string,
): Promise<readonly string[]> {
  const group = await findProfilesForRepo(dataDir, repoId)
  const removed: string[] = []
  for (const { dir, sidecar } of group) {
    // Refuse to uninstall builtins via this path (defense in depth — the
    // group filter already excluded non-github sidecars, but the UI
    // shouldn't be able to call this for a builtin via clever repoId).
    if (sidecar.kind !== 'github') continue
    await rm(dir, { recursive: true, force: true })
    removed.push(dir)
  }
  return removed
}
