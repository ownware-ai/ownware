/**
 * Install Profile From GitHub — the Phase-1 entry point.
 *
 * Orchestrates URL parse → clone → manifest read → tree validate →
 * per-profile load validate → collision check → place → sidecar write.
 *
 * Atomicity contract:
 *
 *   - Every check that CAN fail runs against the TEMP clone, not the user's
 *     profiles dir. The user's dir is only touched after every gate has
 *     passed for every profile in the bundle.
 *   - Placement is best-effort atomic: we collect all source/target pairs,
 *     verify no target exists, then `rename()` (same-FS) / `cp -R + rm`
 *     (cross-FS). On any failure mid-placement, we roll back the dirs
 *     that already landed and remove their sidecars.
 *   - Temp clone dir is always cleaned up — success path AND every error
 *     path.
 *
 * Helpers nested inside a profile's `helpers/` ride along automatically
 * via `cp -R`. They are NOT addressable as standalone profiles; the
 * subagent resolver finds them via the parent's path lookup.
 */

import { mkdir, readFile, rename, rm, cp, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hashProfileDir } from '../dir-hash.js'
import { loadProfile } from '../loader.js'
import {
  ORIGIN_SIDECAR_FILE,
  type OriginSidecar,
  type OriginSidecarGithub,
} from '../registry.js'
import { atomicWriteJson } from './atomic-write.js'
import { safeShallowClone, isGitAvailable } from './clone.js'
import { InstallError } from './errors.js'
import {
  parseGithubUrl,
  toCloneUrl,
  displayName,
} from './github-url.js'
import { parseManifest, type MarketplaceManifest } from './manifest.js'
import { validateTree } from './validate-tree.js'
import type {
  GithubAuth,
  InstallOptions,
  InstallResult,
  InstalledProfile,
} from './types.js'

const MANIFEST_FILENAME = 'cortex.profile.json'

/**
 * Install one or more top-level profiles from a GitHub repo. See module
 * doc for the atomicity contract.
 */
export async function installProfileFromGithub(
  opts: InstallOptions,
): Promise<InstallResult> {
  // ---------- 1. fail fast on missing tooling ----------
  if (!(await isGitAvailable(opts.gitBinary ?? 'git'))) {
    throw new InstallError('clone_failed', {
      reason: 'git binary not found on PATH — install git and retry',
    })
  }

  // ---------- 2. parse + canonicalise URL ----------
  const parsed = parseGithubUrl(opts.url)
  const cloneUrl = toCloneUrl(parsed)
  const ref = opts.ref ?? parsed.ref
  const repoId = displayName(parsed)

  // ---------- 3. shallow clone into temp ----------
  const cloneOpts: Parameters<typeof safeShallowClone>[0] = {
    cloneUrl,
    ...(ref !== undefined ? { ref } : {}),
    ...(opts.auth ? { auth: opts.auth } : {}),
    ...(opts.cloneTimeoutMs !== undefined ? { timeoutMs: opts.cloneTimeoutMs } : {}),
    ...(opts.gitBinary ? { gitBinary: opts.gitBinary } : {}),
  }
  const clone = await safeShallowClone(cloneOpts)

  let manifest: MarketplaceManifest
  let placed: InstalledProfile[] = []
  const profilesRoot = join(resolve(opts.dataDir), 'profiles')

  try {
    // ---------- 4. validate the entire cloned tree ----------
    await validateTree({
      profileDir: clone.tempDir,
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
    })

    // ---------- 5. parse manifest ----------
    manifest = await readManifest(clone.tempDir)

    // ---------- 6. resolve + validate every declared profile ----------
    type Pending = {
      readonly entry: MarketplaceManifest['profiles'][number]
      readonly sourceDir: string
      readonly targetDir: string
      readonly targetDirName: string
    }
    const pending: Pending[] = []
    for (const entry of manifest.profiles) {
      const sourceDir = join(clone.tempDir, entry.path)

      // Defensive: confirm the path the manifest points at actually
      // exists and is a directory. Manifest could lie.
      let isDir = false
      try { isDir = (await stat(sourceDir)).isDirectory() } catch { /* */ }
      if (!isDir) {
        throw new InstallError('invalid_manifest', {
          issues: [`profiles[${entry.name}].path: '${entry.path}' is not a directory in the repo`],
        })
      }

      // Validate the profile loads cleanly under Zod + file refs.
      // Failure here surfaces the loader's clear error message wrapped
      // in our InstallError so the gateway can render it.
      try {
        await loadProfile(sourceDir)
      } catch (err) {
        throw new InstallError('profile_load_failed', {
          profile: entry.name,
          reason: err instanceof Error ? err.message : String(err),
        })
      }

      const targetDirName = `${parsed.owner}__${parsed.repo}__${entry.name}`
      const targetDir = join(profilesRoot, targetDirName)

      // Name-collision check — we never overwrite a user's profile dir.
      let exists = false
      try { exists = (await stat(targetDir)).isDirectory() } catch { /* */ }
      if (exists) {
        throw new InstallError('name_collision', { existing: targetDirName })
      }

      pending.push({ entry, sourceDir, targetDir, targetDirName })
    }

    // ---------- 7. ensure profiles root exists ----------
    await mkdir(profilesRoot, { recursive: true })

    // ---------- 8. shared sidecar base (per-profile installedHash added below) ----------
    const installedAt = new Date().toISOString()

    // ---------- 9. place each profile + hash + write its sidecar ----------
    // Best-effort atomic: rename when source/target on same FS, fall
    // back to cp + rm. Roll back already-placed dirs on any failure.
    placed = []
    let lastSidecar: OriginSidecar | null = null
    try {
      for (const p of pending) {
        await placeDir(p.sourceDir, p.targetDir)
        // Hash AFTER placement so we hash exactly the bytes that landed.
        // Sidecar is excluded by hashProfileDir.
        const installedHash = await hashProfileDir(p.targetDir)
        const sidecar: OriginSidecarGithub = {
          kind: 'github',
          repoUrl: cloneUrl,
          ref: clone.ref,
          commit: clone.commit,
          repoId,
          installedAt,
          installedHash,
        }
        await atomicWriteJson(join(p.targetDir, ORIGIN_SIDECAR_FILE), sidecar)
        lastSidecar = sidecar
        placed.push({
          displayName: `${repoId}/${p.entry.name}`,
          dirPath: p.targetDir,
          dirName: p.targetDirName,
          profileName: p.entry.name,
        })
      }
    } catch (err) {
      // Roll back any dirs that landed before the failure.
      for (const done of placed) {
        try { await rm(done.dirPath, { recursive: true, force: true }) } catch { /* */ }
      }
      throw err
    }

    // Sidecars are per-profile (each carries its own installedHash) but
    // the InstallResult exposes a representative one. Manifests with at
    // least one profile always populate this.
    if (lastSidecar === null) {
      throw new InstallError('invalid_manifest', { issues: ['no profiles placed'] })
    }

    return {
      repoId,
      commit: clone.commit,
      ref: clone.ref,
      profiles: placed,
      manifest,
      sidecar: lastSidecar,
    }
  } finally {
    // Always clean up the clone temp dir, success or failure.
    try { await rm(clone.tempDir, { recursive: true, force: true }) } catch { /* */ }
  }
}

/**
 * Read and parse `cortex.profile.json` at the root of the clone.
 * Throws `manifest_not_found` if absent, `invalid_manifest` on schema
 * failure (the latter via parseManifest).
 */
async function readManifest(cloneDir: string): Promise<MarketplaceManifest> {
  const manifestPath = join(cloneDir, MANIFEST_FILENAME)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  } catch {
    throw new InstallError('manifest_not_found', { path: MANIFEST_FILENAME })
  }
  return parseManifest(raw)
}

/**
 * Move `source` to `target`. Tries `rename()` first (atomic on the same
 * filesystem), falls back to `cp -R + rm` if the rename crosses a
 * filesystem boundary (EXDEV). The cp+rm fallback is NOT atomic by
 * itself; the caller's outer rollback loop handles partial-bundle
 * failures.
 */
async function placeDir(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw err
  }
  await cp(source, target, { recursive: true })
  await rm(source, { recursive: true, force: true })
}

// Re-export public types/utilities for caller convenience.
export type {
  InstallOptions,
  InstallResult,
  InstalledProfile,
  GithubAuth,
}
