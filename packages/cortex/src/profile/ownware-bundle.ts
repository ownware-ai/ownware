/**
 * Ownware Marketplace Bundle — the in-binary library of Ownware-curated
 * specialty profiles that ship with the app but are NOT pre-installed.
 *
 * The user discovers these in the client's Marketplace tab as "Ownware
 * Verified" entries. Clicking Install does a local copy from the bundle
 * dir into the user dir; no network call, no token, no exposure of the
 * private repo the bundle was built from.
 *
 * Source classification:
 *   - The bundle dir is `<cortex-package>/profiles/`
 *   - A `BUILTINS.json` in that dir splits children into `core` and
 *     `marketplace` arrays. `core` profiles are auto-loaded by the
 *     registry (existing behaviour). `marketplace` profiles are loaded
 *     ONLY by this module and surfaced as installable.
 *   - Anything not classified defaults to `core` (back-compat with
 *     repos that pre-date BUILTINS.json).
 *
 * Update detection:
 *   - Each installed copy carries a `bundleVersion` in its sidecar.
 *   - At app start, this module records the current bundle's version
 *     (a SHA pinned at app build time, or `'dev'` for local builds).
 *   - The Marketplace tab compares the user's installed version to the
 *     current bundle version; mismatch → "Update available" badge.
 */

import { readFile, readdir, stat, mkdir, cp, rm, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { hashProfileDir } from './dir-hash.js'
import { loadProfile, type LoadedProfile } from './loader.js'
import { atomicWriteJson } from './install/atomic-write.js'
import {
  ORIGIN_SIDECAR_FILE,
  type OriginSidecar,
  type OriginSidecarOwnwareBundle,
} from './registry.js'
import type { ProfileMetadata } from './schema.js'

// ---------------------------------------------------------------------------
// BUILTINS.json shape
// ---------------------------------------------------------------------------

const BuiltinsManifestSchema = z.object({
  core: z.array(z.string()).default([]),
  marketplace: z.array(z.string()).default([]),
}).passthrough()

export type BuiltinsManifest = z.infer<typeof BuiltinsManifestSchema>

const BUILTINS_FILENAME = 'BUILTINS.json'
/** What we record in the sidecar when running from a non-CI build. */
export const DEV_BUNDLE_VERSION = 'dev'
/** What we record as the bundledFrom when no override is provided. */
export const DEFAULT_BUNDLE_FROM = 'ownware-profiles'

/**
 * Read `BUILTINS.json` from the bundle dir. Returns the parsed manifest
 * or null when the file is absent. A missing file is fine — the
 * registry's existing default ("treat every dir as core") preserves
 * back-compat.
 */
export async function readBuiltinsManifest(bundleDir: string): Promise<BuiltinsManifest | null> {
  let raw: string
  try { raw = await readFile(join(bundleDir, BUILTINS_FILENAME), 'utf-8') } catch {
    return null
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return null
  }
  const result = BuiltinsManifestSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * Set of profile names the registry should SKIP when discovering
 * builtins (because they're marketplace items the user hasn't asked
 * for yet). Returns an empty set when no manifest is present.
 */
export async function readMarketplaceSkipSet(bundleDir: string): Promise<ReadonlySet<string>> {
  const manifest = await readBuiltinsManifest(bundleDir)
  if (manifest === null) return new Set()
  return new Set(manifest.marketplace)
}

// ---------------------------------------------------------------------------
// Bundle entry — what the marketplace UI renders
// ---------------------------------------------------------------------------

export interface OwnwareBundleEntry {
  /** Profile name as it lives in the bundle dir. */
  readonly name: string
  /** Optional human-readable description from `agent.json`. */
  readonly description: string | null
  readonly tags: readonly string[]
  /** Per-profile UI metadata — icon, color, category, avatar, requiredSecrets. */
  readonly metadata: ProfileMetadata
  /** Resolved at app start; same value lands in sidecar.bundleVersion on install. */
  readonly bundleVersion: string
  /** True when the user already installed this profile (uninstall offered). */
  readonly installed: boolean
  /** True when installed AND the bundle's bundleVersion has advanced beyond
   *  the user's installed bundleVersion → user sees "Update available". */
  readonly hasUpdate: boolean
}

/**
 * Full detail payload for the marketplace's "profile detail" page.
 * Strict superset of `OwnwareBundleEntry` — adds the SOUL preview,
 * skills, helpers, model wiring, capabilities, and connector list.
 *
 * Used by `GET /api/v1/marketplace/ownware/:name`. Cheap to build —
 * everything is a single profile load + small folder reads.
 */
export interface OwnwareBundleDetail extends OwnwareBundleEntry {
  /** Full SOUL.md content (or null when no SOUL). */
  readonly soulMd: string | null
  /** Optional AGENTS.md memory seed (or null). */
  readonly agentsMd: string | null
  /** Main model id, e.g. 'anthropic:claude-sonnet-4-6'. */
  readonly model: string
  /** Optional small-fast model. */
  readonly smallFastModel: string | null
  /** Skills — full content for the detail expand. */
  readonly skills: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly trigger: string
    readonly content: string
  }>
  /** Nested per-profile helpers — for the Helpers section in the UI. */
  readonly helpers: ReadonlyArray<{
    readonly name: string
    readonly description: string | null
    readonly model: string
    readonly soulPreview: string | null
    readonly metadata: ProfileMetadata
  }>
  /** Subagent declarations from agent.json (parent's grant decisions). */
  readonly subagents: ReadonlyArray<{
    readonly name: string
    readonly description: string
  }>
  /** MCP server names declared in the profile (count is what the UI shows). */
  readonly mcpServers: readonly string[]
  /** Tool preset (full / coding / readonly / none). */
  readonly toolPreset: string
  /** Plain-English capability tags derived from preset + tools. */
  readonly capabilities: readonly string[]
  /** Security level (permissive / standard / strict / paranoid). */
  readonly securityLevel: string
  /** Permission mode (auto / ask / deny / allowlist). */
  readonly permissionMode: string
  /** Profile version from agent.json. */
  readonly version: string
}

// ---------------------------------------------------------------------------
// Bundle service
// ---------------------------------------------------------------------------

export interface OwnwareBundleOptions {
  /** Absolute path to the bundle dir (the `profiles/` folder shipped
   *  with the cortex package). */
  readonly bundleDir: string
  /** Absolute path to the user dir (`<dataDir>/profiles/`). */
  readonly userDir: string
  /** Bundle version. Defaults to `'dev'`. CI build sets this to the
   *  pinned source-repo SHA. */
  readonly bundleVersion?: string
  /** Identifier of the source repo this bundle was built from. */
  readonly bundledFrom?: string
}

export class OwnwareBundle {
  private readonly bundleDir: string
  private readonly userDir: string
  private readonly bundleVersion: string
  private readonly bundledFrom: string

  constructor(opts: OwnwareBundleOptions) {
    this.bundleDir = resolve(opts.bundleDir)
    this.userDir = resolve(opts.userDir)
    this.bundleVersion = opts.bundleVersion ?? DEV_BUNDLE_VERSION
    this.bundledFrom = opts.bundledFrom ?? DEFAULT_BUNDLE_FROM
  }

  /**
   * List every marketplace-classified profile currently in the bundle,
   * with an `installed` + `hasUpdate` flag computed against the user's
   * installed copies.
   */
  async list(): Promise<readonly OwnwareBundleEntry[]> {
    const manifest = await readBuiltinsManifest(this.bundleDir)
    const names = manifest?.marketplace ?? []
    if (names.length === 0) return []

    const entries: OwnwareBundleEntry[] = []
    for (const name of names) {
      const sourceDir = join(this.bundleDir, name)
      const exists = await dirExists(sourceDir)
      if (!exists) continue

      let loaded: LoadedProfile
      try {
        loaded = await loadProfile(sourceDir)
      } catch {
        // Broken bundle entry — skip rather than crash the marketplace.
        continue
      }

      const installedSidecar = await this.readInstalledSidecar(name)
      const installed = installedSidecar !== null
      const hasUpdate = installed && installedSidecar.bundleVersion !== this.bundleVersion

      entries.push({
        name,
        description: loaded.config.description ?? null,
        tags: loaded.config.tags,
        metadata: loaded.config.metadata,
        bundleVersion: this.bundleVersion,
        installed,
        hasUpdate,
      })
    }
    return entries
  }

  /**
   * Build the full detail payload for the Marketplace detail page.
   * Reads the profile, its skills, and any nested helpers from disk.
   *
   * Throws when `name` isn't classified as marketplace or its dir is
   * missing.
   */
  async detail(name: string): Promise<OwnwareBundleDetail> {
    const manifest = await readBuiltinsManifest(this.bundleDir)
    const allowed = new Set(manifest?.marketplace ?? [])
    if (!allowed.has(name)) {
      throw new Error(
        `Profile '${name}' is not a Ownware marketplace bundle entry.`,
      )
    }
    const sourceDir = join(this.bundleDir, name)
    if (!(await dirExists(sourceDir))) {
      throw new Error(`Bundle directory missing: ${sourceDir}`)
    }
    const loaded = await loadProfile(sourceDir)

    // Helpers — walk the optional `helpers/` subdir; skip cleanly when absent.
    const helpersDir = join(sourceDir, 'helpers')
    const helpers: Array<OwnwareBundleDetail['helpers'][number]> = []
    if (await dirExists(helpersDir)) {
      const entries = await readdir(helpersDir)
      for (const helperName of entries) {
        const helperDir = join(helpersDir, helperName)
        if (!(await dirExists(helperDir))) continue
        try {
          const h = await loadProfile(helperDir)
          const preview = h.soulMd
            ? h.soulMd.split('\n').filter((l) => l.trim().length > 0).slice(0, 3).join('\n')
            : null
          helpers.push({
            name: helperName,
            description: h.config.description ?? null,
            model: h.config.model,
            soulPreview: preview,
            metadata: h.config.metadata,
          })
        } catch {
          // Broken helper — skip rather than fail the whole detail.
        }
      }
    }

    // Sidecar to compute installed/hasUpdate (same logic as list()).
    const installedSidecar = await this.readInstalledSidecar(name)
    const installed = installedSidecar !== null
    const hasUpdate = installed && installedSidecar.bundleVersion !== this.bundleVersion

    return {
      // Entry fields
      name,
      description: loaded.config.description ?? null,
      tags: loaded.config.tags,
      metadata: loaded.config.metadata,
      bundleVersion: this.bundleVersion,
      installed,
      hasUpdate,

      // Detail fields
      soulMd: loaded.soulMd,
      agentsMd: loaded.agentsMd,
      model: loaded.config.model,
      smallFastModel: loaded.config.smallFastModel ?? null,
      skills: loaded.skills.map((s) => ({
        name: s.name,
        description: s.description,
        // SkillDefinition.trigger can be string | RegExp; the marketplace UI
        // only displays it, so coerce to string.
        trigger: typeof s.trigger === 'string' ? s.trigger : String(s.trigger),
        content: s.content,
      })),
      helpers,
      subagents: loaded.config.subagents.map((s) => ({
        name: s.name,
        description: s.description,
      })),
      mcpServers: Object.keys(loaded.config.tools.mcp ?? {}),
      toolPreset: loaded.config.tools.preset,
      capabilities: derivePlainCapabilities(loaded.config),
      securityLevel: loaded.config.security.level,
      permissionMode: loaded.config.security.permissionMode,
      version: loaded.config.version,
    }
  }

  /**
   * Install a marketplace bundle profile by name.
   *
   * Steps:
   *   1. Look up the profile in the bundle dir (must be classified
   *      as `marketplace` in BUILTINS.json — refuses anything else).
   *   2. Validate it loads via `loadProfile` (catches a broken bundle
   *      entry before it lands on disk).
   *   3. `cp -R` into `<userDir>/<name>/`.
   *   4. Hash the placed dir; write the sidecar.
   *
   * Throws on:
   *   - unknown name (not in BUILTINS.json marketplace list)
   *   - missing source dir
   *   - profile load failure
   *   - target name collision (existing dir at the target path)
   */
  async install(name: string): Promise<{ readonly path: string; readonly sidecar: OriginSidecarOwnwareBundle }> {
    const manifest = await readBuiltinsManifest(this.bundleDir)
    const allowed = new Set(manifest?.marketplace ?? [])
    if (!allowed.has(name)) {
      throw new Error(
        `Profile '${name}' is not a Ownware marketplace bundle entry. ` +
        `Allowed names: ${[...allowed].sort().join(', ') || '(none)'}`,
      )
    }
    const sourceDir = join(this.bundleDir, name)
    if (!(await dirExists(sourceDir))) {
      throw new Error(`Bundle directory missing: ${sourceDir}`)
    }
    // Profile must load cleanly before placement.
    await loadProfile(sourceDir)

    const targetDir = join(this.userDir, name)
    if (await dirExists(targetDir)) {
      throw new Error(`A profile is already installed at ${targetDir}. Uninstall it first.`)
    }

    await mkdir(this.userDir, { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true })

    const installedHash = await hashProfileDir(targetDir)
    const sidecar: OriginSidecarOwnwareBundle = {
      kind: 'ownware-marketplace',
      profileName: name,
      bundledFrom: this.bundledFrom,
      bundleVersion: this.bundleVersion,
      installedAt: new Date().toISOString(),
      installedHash,
    }
    await atomicWriteJson(join(targetDir, ORIGIN_SIDECAR_FILE), sidecar)
    return { path: targetDir, sidecar }
  }

  /**
   * Update an already-installed bundle profile by replacing its dir
   * with a fresh copy from the bundle. Atomic via temp-rename.
   */
  async update(name: string): Promise<{ readonly path: string; readonly sidecar: OriginSidecarOwnwareBundle }> {
    const targetDir = join(this.userDir, name)
    if (!(await dirExists(targetDir))) {
      throw new Error(`Profile '${name}' is not installed; nothing to update.`)
    }
    // Best-effort atomic: rename current to backup, install fresh,
    // drop backup on success / restore on failure.
    const backup = `${targetDir}.bak-${Date.now()}`
    const { rename } = await import('node:fs/promises')
    await rename(targetDir, backup)
    try {
      const result = await this.install(name)
      try { await rm(backup, { recursive: true, force: true }) } catch { /* */ }
      return result
    } catch (err) {
      try { await rename(backup, targetDir) } catch { /* */ }
      throw err
    }
  }

  /**
   * Uninstall by name. Refuses to touch dirs whose sidecar isn't
   * `ownware-marketplace` — same guard the marketplace HTTP uninstall
   * uses for github profiles.
   */
  async uninstall(name: string): Promise<{ readonly removed: boolean }> {
    const targetDir = join(this.userDir, name)
    if (!(await dirExists(targetDir))) return { removed: false }
    const sidecar = await this.readInstalledSidecar(name)
    if (sidecar === null) {
      throw new Error(`Cannot uninstall '${name}': no Ownware marketplace sidecar found.`)
    }
    await rm(targetDir, { recursive: true, force: true })
    return { removed: true }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async readInstalledSidecar(name: string): Promise<OriginSidecarOwnwareBundle | null> {
    const sidecarPath = join(this.userDir, name, ORIGIN_SIDECAR_FILE)
    let raw: string
    try { raw = await readFile(sidecarPath, 'utf-8') } catch { return null }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return null }
    if (parsed === null || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (obj['kind'] !== 'ownware-marketplace') return null
    if (
      typeof obj['profileName'] === 'string' &&
      typeof obj['bundledFrom'] === 'string' &&
      typeof obj['bundleVersion'] === 'string' &&
      typeof obj['installedAt'] === 'string' &&
      typeof obj['installedHash'] === 'string'
    ) {
      return {
        kind: 'ownware-marketplace',
        profileName: obj['profileName'],
        bundledFrom: obj['bundledFrom'],
        bundleVersion: obj['bundleVersion'],
        installedAt: obj['installedAt'],
        installedHash: obj['installedHash'],
      }
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

/**
 * Map preset + tools config to plain-English capability tags shown on
 * the marketplace detail page. Stays in this module because the mapping
 * is preview-grade UX text, not a runtime concern. Order is stable so
 * the UI lists them deterministically.
 */
function derivePlainCapabilities(config: {
  readonly tools: { readonly preset: string; readonly mcp?: Record<string, unknown> }
  readonly browser?: { readonly autoLaunch?: boolean | 'auto' }
  readonly subagents?: ReadonlyArray<unknown>
}): string[] {
  const out: string[] = []
  switch (config.tools.preset) {
    case 'full':
      out.push('Reads and writes files in your workspace')
      out.push('Runs shell commands (with confirmation)')
      out.push('Browses the web')
      break
    case 'coding':
      out.push('Reads and writes files in your workspace')
      out.push('Runs shell commands (with confirmation)')
      break
    case 'readonly':
      out.push('Reads files in your workspace (read-only)')
      break
    case 'none':
      out.push('Conversation only — no file or shell access')
      break
  }
  const mcpCount = Object.keys(config.tools.mcp ?? {}).length
  if (mcpCount > 0) {
    out.push(`Connects to ${mcpCount} external tool${mcpCount === 1 ? '' : 's'}`)
  }
  const subCount = config.subagents?.length ?? 0
  if (subCount > 0) {
    out.push(`Delegates to ${subCount} helper agent${subCount === 1 ? '' : 's'}`)
  }
  return out
}

// Re-export so callers don't need to import OriginSidecar from registry.
export type { OriginSidecar }

// ---------------------------------------------------------------------------
// Marketplace rename migration (one-shot, idempotent)
// ---------------------------------------------------------------------------

/**
 * Old → new marketplace profile names that need on-disk renaming for
 * users who installed an entry before the 2026-05-19 brand-prefix
 * rename (PR B). Pairs with SQL migration #30 — keep in sync.
 *
 * Only entries whose sidecar `kind === 'ownware-marketplace'` AND whose
 * `profileName` matches the OLD name get renamed. User forks (no
 * sidecar, or `kind: 'fork'`) are untouched even if they happen to
 * share an old name — those are the user's data, not ours to move.
 */
export const MARKETPLACE_RENAME_MAP: Readonly<Record<string, string>> = {
  counsel: 'ownware-law',
  finance: 'ownware-finance',
  marketing: 'ownware-marketing',
  researcher: 'ownware-research',
  sentinel: 'ownware-security',
  'trading-coach': 'ownware-trade-coach',
  'trading-research': 'ownware-trade-research',
}

export interface MarketplaceRenameResult {
  /** Old → new pairs that were renamed in this run. */
  readonly renamed: ReadonlyArray<{ from: string; to: string }>
  /** Old names found whose target dir already existed — skipped to stay idempotent. */
  readonly skippedTargetExists: readonly string[]
  /** Old names whose rename or sidecar rewrite failed (with the error string). */
  readonly failed: ReadonlyArray<{ from: string; reason: string }>
}

/**
 * Walk `userDir` for installed marketplace profiles using an old name
 * from `MARKETPLACE_RENAME_MAP` and rename them in place. Each rename
 * is:
 *
 *   1. Verify the source dir's sidecar declares `kind: 'ownware-marketplace'`.
 *      Anything else (no sidecar, fork, github) is left untouched.
 *   2. If `userDir/<new-name>` already exists, skip — idempotent rerun
 *      or the user has both copies; we never overwrite.
 *   3. `rename(old, new)`.
 *   4. Rewrite the sidecar JSON at `new/.ownware-origin.json` with the
 *      new `profileName`. Keep all other fields (`bundledFrom`,
 *      `bundleVersion`, `installedAt`, `installedHash`) intact so the
 *      "Update available" badge logic still works.
 *
 * Designed to run once at gateway startup, before registry discovery
 * walks the user dir. After a successful rename, the registry sees
 * the new folder name on its first pass and the marketplace list +
 * client UI line up with the bundle's new names.
 *
 * Failures are logged via the returned `failed` array and never throw
 * — a single broken sidecar should not block boot.
 */
export async function migrateMarketplaceInstalledNames(
  userDir: string,
): Promise<MarketplaceRenameResult> {
  const renamed: Array<{ from: string; to: string }> = []
  const skippedTargetExists: string[] = []
  const failed: Array<{ from: string; reason: string }> = []

  // Missing userDir is fine — fresh install or user never opened the
  // app before this build. Nothing to migrate.
  if (!(await dirExists(userDir))) {
    return { renamed, skippedTargetExists, failed }
  }

  for (const [oldName, newName] of Object.entries(MARKETPLACE_RENAME_MAP)) {
    const oldDir = join(userDir, oldName)
    if (!(await dirExists(oldDir))) continue

    // Sidecar guard — only touch entries we know we shipped.
    const sidecarPath = join(oldDir, ORIGIN_SIDECAR_FILE)
    let sidecar: OriginSidecarOwnwareBundle
    try {
      const raw = await readFile(sidecarPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed['kind'] !== 'ownware-marketplace') continue
      if (
        typeof parsed['profileName'] !== 'string' ||
        typeof parsed['bundledFrom'] !== 'string' ||
        typeof parsed['bundleVersion'] !== 'string' ||
        typeof parsed['installedAt'] !== 'string' ||
        typeof parsed['installedHash'] !== 'string'
      ) {
        continue
      }
      sidecar = {
        kind: 'ownware-marketplace',
        profileName: parsed['profileName'],
        bundledFrom: parsed['bundledFrom'],
        bundleVersion: parsed['bundleVersion'],
        installedAt: parsed['installedAt'],
        installedHash: parsed['installedHash'],
      }
    } catch {
      // No sidecar, or unreadable — leave it alone. The dir is a fork
      // or hand-edit at this point; the user owns it.
      continue
    }

    // Target collision — both old and new installed simultaneously
    // (very unlikely but possible). Skip rather than clobber.
    const newDir = join(userDir, newName)
    if (await dirExists(newDir)) {
      skippedTargetExists.push(oldName)
      continue
    }

    try {
      await rename(oldDir, newDir)
      const updatedSidecar: OriginSidecarOwnwareBundle = {
        ...sidecar,
        profileName: newName,
      }
      await atomicWriteJson(join(newDir, ORIGIN_SIDECAR_FILE), updatedSidecar)
      renamed.push({ from: oldName, to: newName })
    } catch (err) {
      failed.push({
        from: oldName,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { renamed, skippedTargetExists, failed }
}
