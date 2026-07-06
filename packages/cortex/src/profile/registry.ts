/**
 * Profile Registry — Model C (layered builtin + user) source of truth.
 *
 * Cortex profiles live in two physical locations and one logical view:
 *
 *   builtin dir → packages/cortex/profiles/      (read-only, ships with app)
 *   user dir    → ~/.ownware/profiles/           (writable, all user edits)
 *   merged view → user shadows builtin on name collision
 *
 * Every entry carries an explicit `source` so callers never have to guess
 * which dir won. Edits to a builtin trigger copy-on-write into the user
 * dir (see `forkBuiltin`). Stale seed copies left behind by the v1
 * `seedProfiles()` boot path are reaped by `migrateStaleSeeds()` on each
 * boot — idempotent, hash-compared.
 *
 * Backwards-compatible: `discover(dir)` without a source defaults to
 * `'user'`, which preserves the older "later call wins" semantics for
 * tests and external callers that haven't migrated.
 */

import { readdir, stat, readFile, writeFile, cp, rm, unlink } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash, randomUUID } from 'node:crypto'
import { loadProfile } from './loader.js'
import type { LoadedProfile } from './loader.js'
import type { ProfileConfig } from './schema.js'
import { PROFILE_ORIGIN_SIDECAR_FILE } from '../constants.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProfileSource = 'builtin' | 'user'

/**
 * Sidecar file dropped at the root of a forked profile dir. Records the
 * builtin ancestor and the content-hash captured at fork time so the UI
 * can offer "Reset to default" and "Update available" affordances.
 */
export const ORIGIN_SIDECAR_FILE = PROFILE_ORIGIN_SIDECAR_FILE

/**
 * Sidecar discriminated union (v2). Three sources of truth:
 *
 *   - `'fork'`           — copied from a builtin into the user dir at
 *                          `forkBuiltin()` time. The legacy v1 shape
 *                          (just `forkedFrom` + `forkedAtHash`, no `kind`
 *                          field) is read back as this variant — see
 *                          `readOriginSidecar` below.
 *   - `'github'`         — installed from a community / public GitHub
 *                          repo via the marketplace install primitive.
 *                          `repoId` (`<owner>/<repo>`) groups every
 *                          top-level profile placed by the same install
 *                          call so uninstall acts on the repo as one
 *                          unit.
 *   - `'builtin-bundle'` — placed at app build time by the
 *                          `sync-builtin-profiles` script. Marker for
 *                          "this profile is exempt from the
 *                          no-custom-code install gate" because we
 *                          audited it before shipping.
 *
 * Forward-compatibility: an unknown `kind` is read back as `null` rather
 * than throwing — keeps an older Cortex from crashing on a sidecar a
 * newer Cortex wrote.
 */
export type OriginSidecar =
  | OriginSidecarFork
  | OriginSidecarGithub
  | OriginSidecarBuiltinBundle
  | OriginSidecarOwnwareBundle

export interface OriginSidecarFork {
  readonly kind: 'fork'
  /** Name of the builtin that was forked. */
  readonly forkedFrom: string
  /** SHA-256 of the builtin dir at fork time. Drives "Update available". */
  readonly forkedAtHash: string
}

export interface OriginSidecarGithub {
  readonly kind: 'github'
  /** Canonical clone URL recorded at install time. Update detection
   *  runs `git ls-remote` against THIS, not against a URL passed by the
   *  caller — no SSRF surface. */
  readonly repoUrl: string
  /** Branch / tag / sha we cloned. Update detection compares the current
   *  remote head of this ref to `commit`. */
  readonly ref: string
  /** Resolved commit SHA at install time. */
  readonly commit: string
  /** `<owner>/<repo>` — groups every top-level profile installed from
   *  the same repo so uninstall acts on the repo as one transaction. */
  readonly repoId: string
  /** ISO-8601 install timestamp. */
  readonly installedAt: string
  /**
   * SHA-256 of the profile dir contents at install time (computed via
   * `hashProfileDir`, sidecar excluded). Used by `update/local-edits.ts`
   * to detect whether the user has edited the dir since install.
   *
   * Optional for forward-compat: a v1 github sidecar without this field
   * loses local-edit detection (the update path treats the dir as
   * unmodified). All NEW installs land with this populated.
   */
  readonly installedHash?: string
}

export interface OriginSidecarBuiltinBundle {
  readonly kind: 'builtin-bundle'
  /** Identifier of the private repo the builtin was sourced from. */
  readonly bundledFrom: string
  /** Commit SHA pinned at app build time. */
  readonly bundleVersion: string
}

/**
 * Ownware-curated marketplace profile installed from the LOCAL bundle
 * shipped with the app. Distinct from `builtin-bundle` because the
 * user explicitly installed this — it is uninstallable, surfaces as
 * a regular user profile, and gets "Update available" treatment when
 * a new Cortex release ships a newer bundleVersion.
 *
 * The source path is the bundle dir inside the app, NOT a remote URL.
 * Updates happen by re-copying from the bundle when bundleVersion
 * changes, never by network fetch.
 */
export interface OriginSidecarOwnwareBundle {
  readonly kind: 'ownware-marketplace'
  /** Profile name as it lives in the bundle dir. */
  readonly profileName: string
  /** Identifier of the private repo / bundle source (e.g. 'ownware-profiles'). */
  readonly bundledFrom: string
  /** Commit SHA of the bundle when this profile was installed. Used by
   *  the Marketplace tab to surface "Update available" when the running
   *  app's bundle has a newer SHA. */
  readonly bundleVersion: string
  /** ISO-8601 install timestamp. */
  readonly installedAt: string
  /** SHA-256 of the profile dir at install time, for local-edit detection. */
  readonly installedHash: string
}

/** A user-facing view of one registry entry — what `list()` returns. */
export interface RegistryEntryView {
  readonly name: string
  readonly path: string
  readonly source: ProfileSource
  readonly readOnly: boolean
  readonly forkedFrom: string | null
  readonly hasUpdate: boolean
  readonly description?: string
  readonly tags?: string[]
  readonly kind: 'agent' | 'helper' | 'both'
}

// ---------------------------------------------------------------------------
// Internal entry shape
// ---------------------------------------------------------------------------

interface RegistryEntry {
  readonly path: string
  readonly source: ProfileSource
  loaded: LoadedProfile | null
  meta: {
    description?: string
    tags?: string[]
    kind?: 'agent' | 'helper' | 'both'
  } | null
  /** Cached SHA-256 of the profile dir contents. Null until first request. */
  contentHash: string | null
  /** Parsed sidecar — only meaningful for source==='user'. */
  origin: OriginSidecar | null
}

// ---------------------------------------------------------------------------
// ProfileRegistry
// ---------------------------------------------------------------------------

export class ProfileRegistry {
  /** The merged, winning view: user shadows builtin on name collision. */
  private readonly profiles = new Map<string, RegistryEntry>()

  /**
   * Absolute paths of every directory discovered as a `user` source. Kept so
   * the registry can re-scan them for profiles WRITTEN AFTER BOOT (e.g. the
   * agent builder's `create_profile`) without a gateway restart. Populated by
   * `discover(..., 'user')`; re-scanned by `refreshUser()` + lazily on a
   * `get()` miss.
   */
  private readonly userDirs = new Set<string>()
  /**
   * Builtin entries that have been shadowed by a user entry of the same
   * name. Kept so we can compute `hasUpdate` and re-emerge the builtin
   * when the user copy is deleted.
   */
  private readonly shadowed = new Map<string, RegistryEntry>()
  /**
   * In-flight fork operations, keyed by profile name. Concurrent
   * `forkBuiltin` calls for the same name share the same promise so we
   * never copy the dir twice or write the sidecar twice.
   */
  private readonly inFlightForks = new Map<string, Promise<string>>()

  /**
   * Discover profiles from a directory.
   *
   * @param rootDir Directory to scan. Missing dir is silently skipped.
   * @param source  Either `'builtin'` (read-only catalog) or `'user'`
   *                (writable). Defaults to `'user'` for back-compat with
   *                callers/tests that pre-date Model C.
   *
   * Merge rules on name collision:
   * - new=user, existing=builtin → user takes the slot, builtin → shadowed
   * - new=builtin, existing=user → builtin → shadowed (user keeps the slot)
   * - same source → last write wins (preserves legacy semantics)
   */
  async discover(
    rootDir: string,
    source: ProfileSource = 'user',
    opts?: { readonly onlyNew?: boolean },
  ): Promise<void> {
    const absRoot = resolve(rootDir)
    // Remember user roots so post-boot writes can be re-scanned without a
    // restart (see `userDirs` / `refreshUser`).
    if (source === 'user') this.userDirs.add(absRoot)

    let entries: string[]
    try {
      entries = await readdir(absRoot)
    } catch {
      return
    }

    // For builtin discovery only: read the BUILTINS.json manifest (if
    // present) and skip any profile listed under `marketplace`. Those
    // are bundled WITH the app but installable on demand via the
    // Ownware Marketplace tab — they must NOT auto-load as builtins
    // (otherwise the user sees them in the Profiles tab without ever
    // having clicked Install).
    //
    // For 'user' source the manifest is irrelevant — user dirs are
    // whatever the user installed.
    let marketplaceSkip: ReadonlySet<string> = new Set()
    if (source === 'builtin') {
      marketplaceSkip = await readBuiltinsMarketplaceSet(absRoot)
    }

    for (const entry of entries) {
      if (entry.startsWith('_') || entry.startsWith('.')) continue
      // Skip marketplace-classified dirs at builtin discovery time.
      if (marketplaceSkip.has(entry)) continue
      // Refresh mode: only register profiles we don't already know, so a
      // re-scan never drops the cached `loaded` of existing profiles
      // (placeEntry is last-write-wins for same-source).
      if (opts?.onlyNew === true && this.profiles.has(entry)) continue

      const dirPath = join(absRoot, entry)
      const dirStat = await safeStat(dirPath)
      if (!dirStat?.isDirectory()) continue

      const hasJson = await fileExists(join(dirPath, 'agent.json'))
      const hasYaml =
        (await fileExists(join(dirPath, 'agent.yaml'))) ||
        (await fileExists(join(dirPath, 'agent.yml')))
      if (!hasJson && !hasYaml) continue

      const meta = await readQuickMeta(dirPath)
      const origin = source === 'user' ? await readOriginSidecar(dirPath) : null

      // Sweep stale skill-install temp files left behind by crashes mid-rename.
      // Only for writable (user) profiles — builtins never accumulate tmps.
      if (source === 'user') {
        await sweepStaleSkillTemps(dirPath)
      }

      const next: RegistryEntry = {
        path: dirPath,
        source,
        loaded: null,
        meta,
        contentHash: null,
        origin,
      }

      this.placeEntry(entry, next)
    }
  }

  /**
   * Place an entry into the merged view, honouring shadow semantics.
   * Pure: no I/O, no async.
   */
  private placeEntry(name: string, next: RegistryEntry): void {
    const current = this.profiles.get(name)
    if (!current) {
      this.profiles.set(name, next)
      return
    }

    if (current.source === next.source) {
      // Same source — last write wins. Drop any cached load.
      this.profiles.set(name, next)
      return
    }

    if (next.source === 'user' && current.source === 'builtin') {
      // User takes the slot; builtin moves to shadowed.
      this.shadowed.set(name, current)
      this.profiles.set(name, next)
      return
    }

    if (next.source === 'builtin' && current.source === 'user') {
      // User keeps the slot; new builtin goes to shadowed.
      this.shadowed.set(name, next)
      return
    }
  }

  /**
   * Get a loaded profile by name. Lazy-loads on first access.
   *
   * @throws Error if the profile name is not registered or load fails.
   */
  /**
   * Re-scan every known user directory for profiles added since boot, WITHOUT
   * disturbing already-registered ones (`onlyNew`). Cheap (a readdir + a few
   * stats), idempotent, and safe to call on a hot path like the profiles list
   * — this is what lets a just-built agent appear with no gateway restart.
   */
  async refreshUser(): Promise<void> {
    for (const dir of this.userDirs) {
      await this.discover(dir, 'user', { onlyNew: true })
    }
  }

  async get(name: string): Promise<LoadedProfile> {
    let entry = this.profiles.get(name)
    if (!entry && this.userDirs.size > 0) {
      // Miss — a profile may have been written after boot (e.g. the builder's
      // create_profile). Re-scan user dirs once, then retry before failing.
      await this.refreshUser()
      entry = this.profiles.get(name)
    }
    if (!entry) {
      const available = [...this.profiles.keys()].join(', ') || '(none)'
      throw new Error(
        `Profile "${name}" not found. Available profiles: ${available}.`,
      )
    }

    if (entry.loaded === null) {
      entry.loaded = await loadProfile(entry.path)
    }

    return entry.loaded
  }

  /**
   * Synchronous cached read — returns the already-loaded profile if
   * one is sitting in the registry entry, `null` otherwise.
   *
   * Used by the gateway's status-bus subscriber to decide whether a
   * thread needs a reconcile mark WITHOUT hitting disk from inside a
   * fan-out loop. Profiles that aren't cached correspond to threads
   * with no live session (nothing to reconcile anyway) — safe to
   * skip. The next `get(name)` will still load from disk on demand.
   */
  getCached(name: string): LoadedProfile | null {
    return this.profiles.get(name)?.loaded ?? null
  }

  /**
   * List all registered profiles with metadata + source attribution.
   * Lazy: does not trigger full load. Each entry exposes `source`,
   * `readOnly`, `forkedFrom`, and `hasUpdate` so the UI can render the
   * correct affordances without a second round-trip.
   *
   * Note: `hasUpdate` requires a content hash compare against the
   * shadowed builtin. Hashes are cached after first compute.
   */
  list(): RegistryEntryView[] {
    const out: RegistryEntryView[] = []
    for (const [name, entry] of this.profiles) {
      out.push(this.viewOf(name, entry))
    }
    return out
  }

  private viewOf(name: string, entry: RegistryEntry): RegistryEntryView {
    // RegistryEntryView's `forkedFrom` historically meant "the builtin
    // this user copy was forked from." Under the v2 sidecar union it
    // remains a fork-specific concept; github / builtin-bundle origins
    // surface as `null` here. UI code that needs richer origin metadata
    // reads `entry.origin` directly via a separate accessor.
    const forkedFrom = entry.origin !== null && entry.origin.kind === 'fork'
      ? entry.origin.forkedFrom
      : null

    const view: RegistryEntryView = {
      name,
      path: entry.path,
      source: entry.source,
      readOnly: entry.source === 'builtin',
      forkedFrom,
      hasUpdate: this.computeHasUpdate(name, entry),
      ...(entry.meta?.description !== undefined && { description: entry.meta.description }),
      ...(entry.meta?.tags !== undefined && { tags: entry.meta.tags }),
      kind: entry.meta?.kind ?? 'agent',
    }
    return view
  }

  /**
   * `hasUpdate` is true iff this user entry was forked from a builtin
   * whose content has since changed. Synchronous — uses cached hashes
   * only; first lookup may return false until hashes are warmed via
   * `warmHashes()` or `migrateStaleSeeds()`.
   *
   * Only `kind: 'fork'` sidecars participate. `github` and
   * `builtin-bundle` origins have their own update-detection paths
   * (Phase 2) that the registry does not run synchronously.
   */
  private computeHasUpdate(name: string, entry: RegistryEntry): boolean {
    if (entry.source !== 'user' || entry.origin === null) return false
    if (entry.origin.kind !== 'fork') return false
    const builtin = this.shadowed.get(name)
    if (!builtin) return false
    if (builtin.contentHash === null) return false
    return entry.origin.forkedAtHash !== builtin.contentHash
  }

  /**
   * Warm the content-hash cache for every entry (both winning and
   * shadowed). Cheap: stat + read of small files. Call once at boot
   * so `list()` returns accurate `hasUpdate` flags without per-request
   * I/O. Idempotent.
   */
  async warmHashes(): Promise<void> {
    for (const entry of this.profiles.values()) {
      if (entry.contentHash === null) {
        entry.contentHash = await hashProfileDir(entry.path)
      }
    }
    for (const entry of this.shadowed.values()) {
      if (entry.contentHash === null) {
        entry.contentHash = await hashProfileDir(entry.path)
      }
    }
  }

  /** Check if a profile name is registered (in the winning view). */
  has(name: string): boolean {
    return this.profiles.has(name)
  }

  /** Look up the source of a registered profile, or null if unknown. */
  sourceOf(name: string): ProfileSource | null {
    return this.profiles.get(name)?.source ?? null
  }

  /** Detailed view for a single entry (or null). */
  viewFor(name: string): RegistryEntryView | null {
    const entry = this.profiles.get(name)
    if (!entry) return null
    return this.viewOf(name, entry)
  }

  /** Force reload a profile from disk. */
  async reload(name: string): Promise<LoadedProfile> {
    const entry = this.profiles.get(name)
    if (!entry) {
      throw new Error(`Profile "${name}" not found. Cannot reload.`)
    }

    entry.loaded = await loadProfile(entry.path)
    // Content has likely changed; invalidate cached hash.
    entry.contentHash = null
    // Re-read sidecar (user may have deleted it, etc.)
    if (entry.source === 'user') {
      entry.origin = await readOriginSidecar(entry.path)
    }
    // Refresh quick meta so the listing stays accurate after edits.
    entry.meta = await readQuickMeta(entry.path)
    return entry.loaded
  }

  /**
   * Register a profile programmatically (not from filesystem).
   * Useful for in-memory or dynamically generated profiles. Treated as
   * source='user' since it is not part of the bundled catalog.
   */
  register(name: string, config: ProfileConfig, basePath?: string): void {
    const entry: RegistryEntry = {
      path: basePath ?? process.cwd(),
      source: 'user',
      loaded: {
        config,
        soulMd: config.systemPrompt ?? null,
        agentsMd: null,
        skills: [],
        basePath: basePath ?? process.cwd(),
        timeoutMs: 1_800_000,
      },
      meta: { description: config.description, tags: config.tags },
      contentHash: null,
      origin: null,
    }
    this.placeEntry(name, entry)
  }

  /** Number of registered profiles in the winning view. */
  get size(): number {
    return this.profiles.size
  }

  /** Clear all registered profiles AND shadowed entries. */
  clear(): void {
    this.profiles.clear()
    this.shadowed.clear()
  }

  // -------------------------------------------------------------------------
  // Copy-on-write fork
  // -------------------------------------------------------------------------

  /**
   * Fork a builtin profile into the user dir. After this call the
   * winning entry is the user copy; subsequent writes (PUT, MCP edits,
   * file uploads) target the new path. Idempotent: if `name` is already
   * a user entry, this is a no-op and returns the existing path.
   *
   * The forked dir gets a `.ownware-origin.json` sidecar with the
   * builtin's name and content hash captured at fork time so the UI
   * can detect upstream updates and offer "Reset to default".
   *
   * @throws if `name` is not registered or no user dir was provided.
   */
  async forkBuiltin(name: string, userDir: string): Promise<string> {
    // Coalesce concurrent forks of the same name. Without this, N parallel
    // edits to the same builtin race on cp + sidecar write.
    const pending = this.inFlightForks.get(name)
    if (pending) return pending
    const p = this.doForkBuiltin(name, userDir)
    this.inFlightForks.set(name, p)
    try {
      return await p
    } finally {
      this.inFlightForks.delete(name)
    }
  }

  private async doForkBuiltin(name: string, userDir: string): Promise<string> {
    const entry = this.profiles.get(name)
    if (!entry) throw new Error(`Profile "${name}" not found. Cannot fork.`)
    if (entry.source === 'user') return entry.path // already forked or user-owned

    // entry.source === 'builtin' — copy to user dir, then re-point.
    const builtinPath = entry.path
    const userPath = join(resolve(userDir), name)

    if (await fileExists(join(userPath, 'agent.json'))) {
      // Concurrent fork raced us, or user dir already has same name —
      // promote that to the winning slot and re-discover its sidecar.
      const origin = await readOriginSidecar(userPath)
      const promoted: RegistryEntry = {
        path: userPath,
        source: 'user',
        loaded: null,
        meta: await readQuickMeta(userPath),
        contentHash: null,
        origin,
      }
      this.shadowed.set(name, entry)
      this.profiles.set(name, promoted)
      return userPath
    }

    // Compute the builtin hash now so the sidecar records a real value.
    if (entry.contentHash === null) {
      entry.contentHash = await hashProfileDir(builtinPath)
    }
    const forkedAtHash = entry.contentHash

    await cp(builtinPath, userPath, { recursive: true })

    const sidecar: OriginSidecar = { kind: 'fork', forkedFrom: name, forkedAtHash }
    await atomicWrite(
      join(userPath, ORIGIN_SIDECAR_FILE),
      JSON.stringify(sidecar, null, 2),
    )

    const userEntry: RegistryEntry = {
      path: userPath,
      source: 'user',
      loaded: null,
      meta: await readQuickMeta(userPath),
      contentHash: null,
      origin: sidecar,
    }

    // Builtin → shadowed; user → winning slot.
    this.shadowed.set(name, entry)
    this.profiles.set(name, userEntry)
    return userPath
  }

  /**
   * Remove a user profile from disk. If it was forked from a builtin
   * and that builtin still exists in the shadowed map, the builtin
   * re-emerges as the winning entry automatically.
   *
   * @throws if `name` is a builtin (use the wire-level handler to
   *         translate this to a 409 with an actionable message).
   */
  async removeUser(name: string): Promise<{ readonly builtinReemerged: boolean }> {
    const entry = this.profiles.get(name)
    if (!entry) throw new Error(`Profile "${name}" not found.`)
    if (entry.source !== 'user') {
      throw new Error(
        `Profile "${name}" is built-in and cannot be deleted. ` +
        `Edit it to fork into your library, or hide it via user settings.`,
      )
    }

    await rm(entry.path, { recursive: true, force: true })
    this.profiles.delete(name)

    const shadow = this.shadowed.get(name)
    if (shadow) {
      this.profiles.set(name, shadow)
      this.shadowed.delete(name)
      return { builtinReemerged: true }
    }
    return { builtinReemerged: false }
  }

  // -------------------------------------------------------------------------
  // Migration: reap stale seed copies left by the legacy seedProfiles()
  // -------------------------------------------------------------------------

  /**
   * On first boot of the Model C version, users whose `~/.ownware/profiles/`
   * was populated by the old `seedProfiles()` will have a pile of unchanged
   * copies of bundled profiles. They have no `.ownware-origin.json` sidecar
   * (they predate the format) but their content hash matches the current
   * builtin exactly. Delete them so the bundled layer flows through cleanly.
   *
   * Conservative rules — only delete a user dir if ALL hold:
   *   1. It has no sidecar (so we have no fork ancestry to honour).
   *   2. A builtin with the same name exists.
   *   3. Their content hashes are byte-identical.
   *
   * If the user has modified the seed copy (hashes differ), we leave it
   * alone — it's their work.
   *
   * Idempotent. Call on every boot. Returns the names removed.
   */
  async migrateStaleSeeds(): Promise<string[]> {
    const removed: string[] = []
    for (const [name, entry] of [...this.profiles]) {
      if (entry.source !== 'user') continue
      if (entry.origin !== null) continue
      const builtin = this.shadowed.get(name)
      if (!builtin) continue

      if (entry.contentHash === null) {
        entry.contentHash = await hashProfileDir(entry.path)
      }
      if (builtin.contentHash === null) {
        builtin.contentHash = await hashProfileDir(builtin.path)
      }
      if (entry.contentHash !== builtin.contentHash) continue

      // Stale identical seed copy — reap it; builtin re-emerges.
      await rm(entry.path, { recursive: true, force: true })
      this.profiles.set(name, builtin)
      this.shadowed.delete(name)
      removed.push(name)
    }
    return removed
  }

  // -------------------------------------------------------------------------
  // MCP edit helpers (used by gateway). Both fork on first write.
  // -------------------------------------------------------------------------

  /**
   * Add or update an MCP server config in a profile's agent.json.
   * Forks the profile into `userDir` first if it is a builtin.
   */
  async updateProfileMCP(
    profileId: string,
    serverId: string,
    mcpConfig: Record<string, unknown>,
    userDir: string,
  ): Promise<void> {
    await this.forkBuiltin(profileId, userDir)
    const entry = this.profiles.get(profileId)!
    const configPath = join(entry.path, 'agent.json')
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>

    if (!raw['tools'] || typeof raw['tools'] !== 'object') {
      raw['tools'] = {}
    }
    const tools = raw['tools'] as Record<string, unknown>
    if (!tools['mcp'] || typeof tools['mcp'] !== 'object') {
      tools['mcp'] = {}
    }
    const mcp = tools['mcp'] as Record<string, unknown>
    mcp[serverId] = mcpConfig

    await atomicWrite(configPath, JSON.stringify(raw, null, 2))
    entry.loaded = null
    entry.contentHash = null
  }

  /**
   * Remove an MCP server config from a profile's agent.json.
   * Forks the profile into `userDir` first if it is a builtin.
   */
  async removeProfileMCP(
    profileId: string,
    serverId: string,
    userDir: string,
  ): Promise<void> {
    await this.forkBuiltin(profileId, userDir)
    const entry = this.profiles.get(profileId)!
    const configPath = join(entry.path, 'agent.json')
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>

    const tools = raw['tools'] as Record<string, unknown> | undefined
    const mcp = tools?.['mcp'] as Record<string, unknown> | undefined
    if (mcp && serverId in mcp) {
      delete mcp[serverId]
      await atomicWrite(configPath, JSON.stringify(raw, null, 2))
      entry.loaded = null
      entry.contentHash = null
    }
  }

  // -------------------------------------------------------------------------
  // Composio toolkit edit helpers (T03). Parallel to the MCP pair above:
  // same fork-on-first-write semantics, same atomic write, same cache
  // invalidation — just operating on `config.tools.composio.toolkits[]`
  // (an array of slugs) instead of `config.tools.mcp` (an object map).
  // -------------------------------------------------------------------------

  /**
   * Append a Composio toolkit slug to a profile's
   * `config.tools.composio.toolkits`. Idempotent: adding a slug that
   * is already present is a no-op (caller still gets success, matching
   * the T03 acceptance criterion "adding the same toolkit twice is a
   * 200 no-op").
   *
   * Forks the profile into `userDir` first if it is a builtin —
   * same policy as `updateProfileMCP`.
   *
   * Returns `true` when a write happened (new slug), `false` when the
   * slug was already present (dedupe short-circuit). Callers use this
   * signal for logging / audit; the handler returns 200 either way.
   */
  async addProfileComposioToolkit(
    profileId: string,
    toolkit: string,
    userDir: string,
  ): Promise<boolean> {
    await this.forkBuiltin(profileId, userDir)
    const entry = this.profiles.get(profileId)!
    const configPath = join(entry.path, 'agent.json')
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>

    if (!raw['tools'] || typeof raw['tools'] !== 'object') {
      raw['tools'] = {}
    }
    const tools = raw['tools'] as Record<string, unknown>
    if (!tools['composio'] || typeof tools['composio'] !== 'object') {
      tools['composio'] = {}
    }
    const composio = tools['composio'] as Record<string, unknown>
    const currentRaw = composio['toolkits']
    const current = Array.isArray(currentRaw)
      ? currentRaw.filter((t): t is string => typeof t === 'string')
      : []
    if (current.includes(toolkit)) {
      // Already present — don't rewrite the file. Keeps
      // `entry.contentHash` valid and avoids a spurious fs touch.
      return false
    }
    composio['toolkits'] = [...current, toolkit]
    await atomicWrite(configPath, JSON.stringify(raw, null, 2))
    entry.loaded = null
    entry.contentHash = null
    return true
  }

  /**
   * Remove a Composio toolkit slug from a profile's
   * `config.tools.composio.toolkits`. Returns `true` when a write
   * happened (slug was present and removed), `false` when the slug
   * was NOT in the array — the handler converts `false` into a 404.
   */
  async removeProfileComposioToolkit(
    profileId: string,
    toolkit: string,
    userDir: string,
  ): Promise<boolean> {
    await this.forkBuiltin(profileId, userDir)
    const entry = this.profiles.get(profileId)!
    const configPath = join(entry.path, 'agent.json')
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>

    const tools = raw['tools'] as Record<string, unknown> | undefined
    const composio = tools?.['composio'] as Record<string, unknown> | undefined
    if (composio == null) return false
    const currentRaw = composio['toolkits']
    if (!Array.isArray(currentRaw)) return false
    if (!currentRaw.includes(toolkit)) return false

    composio['toolkits'] = currentRaw.filter((t) => t !== toolkit)
    await atomicWrite(configPath, JSON.stringify(raw, null, 2))
    entry.loaded = null
    entry.contentHash = null
    return true
  }
}

// ---------------------------------------------------------------------------
// Helpers — file I/O + hashing
// ---------------------------------------------------------------------------

async function readQuickMeta(
  dirPath: string,
): Promise<{ description?: string; tags?: string[]; kind?: 'agent' | 'helper' | 'both' } | null> {
  try {
    const jsonPath = join(dirPath, 'agent.json')
    const content = await readFile(jsonPath, 'utf-8')
    const raw = JSON.parse(content) as Record<string, unknown>
    const rawKind = raw['kind']
    const kind =
      rawKind === 'helper' || rawKind === 'both' || rawKind === 'agent' ? rawKind : undefined
    return {
      description: typeof raw['description'] === 'string' ? raw['description'] : undefined,
      tags: Array.isArray(raw['tags'])
        ? raw['tags'].filter((t): t is string => typeof t === 'string')
        : undefined,
      kind,
    }
  } catch {
    return null
  }
}

async function readOriginSidecar(dirPath: string): Promise<OriginSidecar | null> {
  try {
    const raw = await readFile(join(dirPath, ORIGIN_SIDECAR_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parseOriginSidecar(parsed)
  } catch {
    return null
  }
}

/**
 * Pure parser for sidecar payloads. Lifted out so the install pipeline
 * (which reads/writes sidecars during placement) can share the same
 * shape contract as the registry without re-implementing the v1
 * back-compat logic.
 *
 * Forward-compat: any unknown `kind` returns `null` rather than throwing
 * so an older Cortex doesn't crash on a sidecar written by a newer one.
 * Back-compat: a v1 payload (no `kind` field, just `forkedFrom` +
 * `forkedAtHash`) is upgraded in place to `kind: 'fork'`.
 */
export function parseOriginSidecar(raw: unknown): OriginSidecar | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // Explicit kind takes priority (v2+).
  if (typeof obj['kind'] === 'string') {
    switch (obj['kind']) {
      case 'fork':
        if (
          typeof obj['forkedFrom'] === 'string' &&
          typeof obj['forkedAtHash'] === 'string'
        ) {
          return {
            kind: 'fork',
            forkedFrom: obj['forkedFrom'],
            forkedAtHash: obj['forkedAtHash'],
          }
        }
        return null
      case 'github':
        if (
          typeof obj['repoUrl'] === 'string' &&
          typeof obj['ref'] === 'string' &&
          typeof obj['commit'] === 'string' &&
          typeof obj['repoId'] === 'string' &&
          typeof obj['installedAt'] === 'string'
        ) {
          const base: OriginSidecarGithub = {
            kind: 'github',
            repoUrl: obj['repoUrl'],
            ref: obj['ref'],
            commit: obj['commit'],
            repoId: obj['repoId'],
            installedAt: obj['installedAt'],
          }
          return typeof obj['installedHash'] === 'string'
            ? { ...base, installedHash: obj['installedHash'] }
            : base
        }
        return null
      case 'builtin-bundle':
        if (
          typeof obj['bundledFrom'] === 'string' &&
          typeof obj['bundleVersion'] === 'string'
        ) {
          return {
            kind: 'builtin-bundle',
            bundledFrom: obj['bundledFrom'],
            bundleVersion: obj['bundleVersion'],
          }
        }
        return null
      case 'ownware-marketplace':
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
      default:
        return null
    }
  }

  // v1 back-compat: no `kind` field, just the fork shape.
  if (
    typeof obj['forkedFrom'] === 'string' &&
    typeof obj['forkedAtHash'] === 'string'
  ) {
    return {
      kind: 'fork',
      forkedFrom: obj['forkedFrom'],
      forkedAtHash: obj['forkedAtHash'],
    }
  }
  return null
}

async function safeStat(p: string) {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p)
    return s.isFile()
  } catch {
    return false
  }
}

/**
 * Skill install writes via temp file + rename. If the process dies between
 * write and rename, the temp file is orphaned. Sweep them up once per
 * discovery — best-effort, never throws.
 *
 * Two layouts to cover:
 *   - legacy flat:   skills/.<slug>.md.tmp
 *   - nested:        skills/<slug>/.SKILL.md.tmp
 */
const FLAT_TEMP_RE = /^\.[a-zA-Z0-9_-]+\.md\.tmp$/
const NESTED_TEMP_NAME = '.SKILL.md.tmp'

async function sweepStaleSkillTemps(profileDir: string): Promise<void> {
  const skillsDir = join(profileDir, 'skills')
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return // no skills dir yet — nothing to sweep
  }
  for (const entry of entries) {
    const entryPath = join(skillsDir, entry)
    // Flat layout: stray `.<slug>.md.tmp` files at the skills/ root
    if (FLAT_TEMP_RE.test(entry)) {
      try {
        await unlink(entryPath)
      } catch {
        // ignore
      }
      continue
    }
    // Nested layout: walk one level into each subfolder for `.SKILL.md.tmp`
    const stat0 = await safeStat(entryPath)
    if (!stat0?.isDirectory()) continue
    try {
      const inner = await readdir(entryPath)
      for (const innerEntry of inner) {
        if (innerEntry.toLowerCase() === NESTED_TEMP_NAME.toLowerCase()) {
          try {
            await unlink(join(entryPath, innerEntry))
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Compute a stable SHA-256 hash of a profile directory. The sidecar
 * itself is excluded (it's metadata about the fork, not content of the
 * profile). Files are sorted by path so the hash is deterministic
 * regardless of fs walk order.
 */
async function hashProfileDir(dirPath: string): Promise<string> {
  const files: Array<{ rel: string; bytes: Buffer }> = []
  await collect(dirPath, '', files)
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(f.rel, 'utf-8')
    hash.update('\0')
    hash.update(f.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function collect(
  base: string,
  prefix: string,
  out: Array<{ rel: string; bytes: Buffer }>,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry === ORIGIN_SIDECAR_FILE) continue
    const full = join(base, entry)
    const rel = prefix === '' ? entry : `${prefix}/${entry}`
    const s = await safeStat(full)
    if (!s) continue
    if (s.isDirectory()) {
      await collect(full, rel, out)
    } else if (s.isFile()) {
      try {
        const bytes = await readFile(full)
        out.push({ rel, bytes })
      } catch {
        // Unreadable file — skip; hashing must not throw on a single bad file.
      }
    }
  }
}

/**
 * Atomic write: write to `path.tmp`, then rename. Survives concurrent
 * writers and partial-write crashes — readers always see either the
 * old or new bytes, never a half-written file.
 */
async function atomicWrite(path: string, content: string): Promise<void> {
  // Tmp name MUST be unique even under heavy concurrency — pid+ms collides
  // when many writes race within the same millisecond. randomUUID() gives
  // 122 bits of entropy, more than enough.
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
  await writeFile(tmp, content, 'utf-8')
  // fs/promises.rename is atomic within the same filesystem.
  const { rename } = await import('fs/promises')
  await rename(tmp, path)
}

/**
 * Read `BUILTINS.json` (if present) and return the set of profile names
 * classified as "marketplace" — those should NOT auto-load as builtins.
 *
 * Lives at the bottom of registry.ts so the discover() impl can consult
 * it without importing ownware-bundle.ts (which would create a cycle:
 * ownware-bundle imports OriginSidecar from registry).
 *
 * Returns an empty set when the file is missing / unreadable / malformed.
 * That preserves the pre-BUILTINS.json behaviour (every dir = builtin).
 */
async function readBuiltinsMarketplaceSet(rootDir: string): Promise<ReadonlySet<string>> {
  let raw: string
  try { raw = await readFile(join(rootDir, 'BUILTINS.json'), 'utf-8') } catch {
    return new Set()
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    return new Set()
  }
  if (parsed === null || typeof parsed !== 'object') return new Set()
  const arr = (parsed as Record<string, unknown>)['marketplace']
  if (!Array.isArray(arr)) return new Set()
  return new Set(arr.filter((s): s is string => typeof s === 'string'))
}
