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
import {
  ORIGIN_SIDECAR_FILE,
  parseOriginSidecar,
  type OriginSidecar,
  type OriginSidecarFork,
} from '../registry.js'
import { hashProfileDir } from '../dir-hash.js'
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
      const forkSidecar: OriginSidecarFork = {
        kind: 'fork',
        forkedFrom: dir.split('/').pop() ?? opts.repoId,
        forkedAtHash: await hashProfileDir(to),
      }
      await atomicWriteJson(join(to, ORIGIN_SIDECAR_FILE), forkSidecar)
    }
  } catch (err) {
    await restoreForksOrThrow(renamed, group)
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
    await restoreForksOrThrow(renamed, group)
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
    await restoreBackupsOrThrow(backups, stagingRoot)
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
    try {
      await rm(stagingRoot, { recursive: true, force: true })
      try {
        await stat(stagingRoot)
        throw new Error('staging remains')
      } catch (cleanupCheck) {
        if (cleanupCheck instanceof Error && cleanupCheck.message === 'staging remains') throw cleanupCheck
      }
    } catch {
      throw new InstallError('rollback_failed', {
        phase: 'cleanup',
        profiles: group.map(({ dir }) => dir.split('/').pop() ?? 'profile'),
      })
    }
    return {
      strategy: 'overwrite',
      affectedDirs: group.map((g) => g.dir),
      forkedDirs: [],
    }
  } catch (err) {
    // The fresh install is valid and live; only stale backup cleanup failed.
    // Restoring here would overwrite the new version and misreport reality.
    if (err instanceof InstallError && err.code === 'rollback_failed' && err.detail.phase === 'cleanup') {
      throw err
    }
    // Roll back: move everything from staging back where it was.
    await restoreBackupsOrThrow(backups, stagingRoot)
    throw err
  }
}

async function restoreForksOrThrow(
  renamed: Array<{ from: string; to: string }>,
  group: Array<{ dir: string; sidecar: OriginSidecar }>,
): Promise<void> {
  const failures: string[] = []
  const originals = new Map(group.map((item) => [item.dir, item.sidecar]))
  for (const item of renamed.slice().reverse()) {
    try {
      const original = originals.get(item.from)
      if (original === undefined) throw new Error('missing original sidecar')
      await atomicWriteJson(join(item.to, ORIGIN_SIDECAR_FILE), original)
      await rename(item.to, item.from)
    } catch {
      failures.push(item.from.split('/').pop() ?? 'profile')
    }
  }
  if (failures.length > 0) {
    throw new InstallError('rollback_failed', { phase: 'fork', profiles: failures })
  }
}

async function restoreBackupsOrThrow(
  backups: Array<{ from: string; to: string }>,
  stagingRoot: string,
): Promise<void> {
  const failures: string[] = []
  for (const backup of backups.slice().reverse()) {
    try { await rename(backup.to, backup.from) } catch {
      failures.push(backup.from.split('/').pop() ?? 'profile')
    }
  }
  try { await rm(stagingRoot, { recursive: true, force: true }) } catch {
    failures.push('staging cleanup')
  }
  if (failures.length > 0) {
    throw new InstallError('rollback_failed', { phase: 'update', profiles: failures })
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
  canUninstallProfile: (profileId: string) => boolean | Promise<boolean> = () => true,
): Promise<readonly string[]> {
  const group = await findProfilesForRepo(dataDir, repoId)
  for (const { dir } of group) {
    const profileId = dir.split('/').pop() ?? ''
    if (!(await canUninstallProfile(profileId))) {
      throw new InstallError('profile_in_use', { profile: profileId })
    }
  }
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

/**
 * Recover legacy marketplace replacement transactions after an unclean exit.
 * A complete replacement is identified only by a parseable origin sidecar
 * whose recorded content hash matches the bytes on disk. Anything else is a
 * partial target and the preserved backup is restored.
 */
export async function recoverInterruptedProfileUpdates(dataDir: string): Promise<{
  readonly restored: number
  readonly finalized: number
}>
export async function recoverInterruptedProfileUpdates(
  dataDir: string,
  deps?: { readonly rename?: typeof rename },
): Promise<{ readonly restored: number; readonly finalized: number }>
export async function recoverInterruptedProfileUpdates(
  dataDir: string,
  deps: { readonly rename?: typeof rename } = {},
): Promise<{ readonly restored: number; readonly finalized: number }> {
  const recoverRename = deps.rename ?? rename
  const root = resolve(dataDir)
  const profilesRoot = join(root, 'profiles')
  let restored = 0
  let finalized = 0

  const stagingRoot = join(root, '.staging')
  let transactions: string[] = []
  try { transactions = await readdir(stagingRoot) } catch { /* no staging */ }
  for (const transaction of transactions.filter((name) => name.startsWith('update-')).sort()) {
    const transactionDir = join(stagingRoot, transaction)
    let backups: string[]
    try { backups = await readdir(transactionDir) } catch { continue }
    for (const profileId of backups.sort()) {
      const backup = join(transactionDir, profileId)
      const target = join(profilesRoot, profileId)
      if (await isCompleteInstalledTarget(target)) {
        await rm(backup, { recursive: true, force: true })
        finalized += 1
      } else {
        await rm(target, { recursive: true, force: true })
        try {
          await recoverRename(backup, target)
          restored += 1
        } catch {
          throw new InstallError('rollback_failed', { phase: 'update', profiles: [profileId] })
        }
      }
    }
    try { await rm(transactionDir, { recursive: true, force: true }) } catch {
      throw new InstallError('rollback_failed', { phase: 'cleanup', profiles: ['staging transaction'] })
    }
  }

  // Ownware bundle updates keep their backup beside the target.
  let profileEntries: string[] = []
  try { profileEntries = await readdir(profilesRoot) } catch { /* no profiles */ }
  for (const entry of profileEntries.sort()) {
    const match = /^(.*)\.bak-\d+$/.exec(entry)
    if (match === null) continue
    const profileId = match[1]!
    const backup = join(profilesRoot, entry)
    const backupSidecar = await readSidecar(backup)
    if (backupSidecar?.kind !== 'ownware-marketplace') continue
    const target = join(profilesRoot, profileId)
    if (await isCompleteInstalledTarget(target)) {
      await rm(backup, { recursive: true, force: true })
      finalized += 1
    } else {
      await rm(target, { recursive: true, force: true })
      try {
        await recoverRename(backup, target)
        restored += 1
      } catch {
        throw new InstallError('rollback_failed', { phase: 'update', profiles: [profileId] })
      }
    }
  }

  return { restored, finalized }
}

async function isCompleteInstalledTarget(target: string): Promise<boolean> {
  const sidecar = await readSidecar(target)
  if (sidecar === null) return false
  if (sidecar.kind !== 'github' && sidecar.kind !== 'ownware-marketplace') return false
  if (sidecar.installedHash === undefined) return false
  try { return await hashProfileDir(target) === sidecar.installedHash } catch { return false }
}
