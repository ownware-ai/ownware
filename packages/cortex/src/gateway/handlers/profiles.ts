/**
 * Profile CRUD handlers.
 *
 * List, detail, create, update, reload, file management, and AI generation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile, readdir, readFile, cp } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { sendJSON, sendError, readJSON } from '../router.js'
import type { ProfileRegistry } from '../../profile/registry.js'
import type { GatewayState } from '../state.js'
import type { PendingReconciles } from '../pending-reconcile.js'
import type { ProfileSummary, ProfileDetail, ProfileHelperResolved, CreateProfileRequest, DuplicateProfileRequest, UpdateProfileRequest, GenerateProfileRequest, ProfileFileRequest } from '../types.js'
import { z } from 'zod'
import { ProfileSchema } from '../../profile/schema.js'
import { countResolvedTools } from '../../profile/tool-policy.js'
import { deepMergePartial } from '../../profile/merge.js'
import {
  isKnownProduct,
  getProductPolicy,
  listProductSlugs,
} from '../../product/manifest.js'

/**
 * Resolve a parent profile's `subagents` list into the wire shape the
 * UI consumes. Subagents with a `profile` ref are looked up via the
 * registry and merged with parent-level overrides. Inline subagents
 * (no `profile` ref) emit their raw fields with `inline: true`.
 *
 * If a helper's referenced profile cannot be loaded (deleted, broken,
 * permissions), we degrade to an inline-style entry using the subagent
 * spec — the parent page must never crash because a helper went missing.
 */
export async function resolveHelpers(
  subagents: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly profile?: string
    readonly model?: string
    readonly avatar?: { bg: string; fg: string; accent: string; symbol: string }
  }>,
  registry: ProfileRegistry,
): Promise<ProfileHelperResolved[]> {
  const out: ProfileHelperResolved[] = []
  for (const sa of subagents) {
    if (sa.profile != null && sa.profile.length > 0 && registry.has(sa.profile)) {
      try {
        const helper = await registry.get(sa.profile)
        const meta = helper.config.metadata
        out.push({
          profileRef: sa.profile,
          name: sa.name.length > 0 ? sa.name : helper.config.name,
          description: sa.description.length > 0 ? sa.description : (helper.config.description ?? ''),
          model: sa.model != null && sa.model.length > 0 && sa.model !== 'inherit' ? sa.model : helper.config.model,
          icon: meta.icon ?? null,
          color: meta.color ?? null,
          avatar: meta.avatar ?? sa.avatar ?? null,
          abilityCount: countResolvedTools(helper.config.tools),
          accessLevel: deriveAccessLevel(helper.config.security?.level),
          inline: false,
        })
        continue
      } catch {
        // fall through to inline rendering
      }
    }
    out.push({
      profileRef: null,
      name: sa.name,
      description: sa.description,
      model: sa.model ?? 'inherit',
      icon: null,
      color: null,
      avatar: sa.avatar ?? null,
      abilityCount: null,
      accessLevel: 'scoped',
      inline: true,
    })
  }
  return out
}

/** Map the security level enum to a one-word user-facing access label. */
function deriveAccessLevel(level: string | undefined): string {
  switch (level) {
    case 'permissive': return 'permissive'
    case 'strict':
    case 'paranoid': return 'strict'
    case 'standard':
    default: return 'scoped'
  }
}

// ---------------------------------------------------------------------------
// Factory — creates handlers with shared dependencies
// ---------------------------------------------------------------------------

/**
 * @param registry         Profile registry (Model C: builtin + user merged).
 * @param userProfilesDir  WRITABLE directory. ALL writes (create, update,
 *                         duplicate, generate, delete, fork-on-edit) go
 *                         here. The bundled `packages/cortex/profiles/`
 *                         directory is read-only at runtime.
 * @param state            Optional gateway state for usage metadata.
 */
export function createProfileHandlers(
  registry: ProfileRegistry,
  userProfilesDir: string,
  state?: GatewayState,
  pendingReconciles?: PendingReconciles,
) {
  /**
   * Mark every thread on this profile as needing a reconcile on its
   * next turn. Called after any successful mutation that changes the
   * profile's declared tool list (attach/detach composio or mcp,
   * PUT that rewrites `tools.*`). No-op when reconcile isn't wired.
   */
  function markThreadsForProfileReconcile(profileId: string): void {
    if (pendingReconciles === undefined || state === undefined) return
    const threads = state.listThreads(profileId, { limit: 10_000 })
    for (const thread of threads.items) {
      pendingReconciles.mark(thread.id)
    }
  }


  // GET /api/v1/profiles
  //
  // Query params:
  //   ?kind=agent   → only runnable profiles (default; excludes helpers)
  //   ?kind=helper  → only helpers
  //   ?kind=both    → only profiles marked both
  //   ?kind=all     → every profile regardless of kind
  //
  // Default behaviour (no query param) returns agents + both — the set
  // a non-technical user expects to see in the main Profiles lobby.
  // Helpers are hidden unless explicitly requested.
  async function listProfiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const kindFilter = url.searchParams.get('kind')
    // Pick up any profile written after boot (e.g. the agent builder's
    // create_profile) so "Your agents" shows it with no gateway restart.
    await registry.refreshUser()
    const profiles = registry.list()
    const summaries: ProfileSummary[] = []

    for (const entry of profiles) {
      const meta = state?.getProfileMetadata(entry.name)
      const isLive = state?.hasActiveRuntime(entry.name) ?? false

      try {
        const loaded = await registry.get(entry.name)
        // Source of truth: agent.json's `metadata` field.
        // Database meta (profile_metadata table) is only used as an
        // override for usage stats (useCount/totalCost/lastUsedAt) and
        // user customizations that haven't been written back to disk.
        const configMeta = loaded.config.metadata
        const kind = loaded.config.kind
        if (!matchesKindFilter(kind, kindFilter)) continue
        summaries.push({
          id: entry.name,
          name: loaded.config.name,
          displayName: loaded.config.displayName ?? null,
          description: loaded.config.description ?? '',
          productId: loaded.config.productId,
          locked: loaded.config.locked,
          model: loaded.config.model,
          tags: loaded.config.tags,
          toolCount: countResolvedTools(loaded.config.tools),
          hasSkills: loaded.skills.length > 0,
          hasMcp: Object.keys(loaded.config.tools.mcp).length > 0,
          icon: meta?.icon ?? configMeta.icon ?? null,
          color: meta?.color ?? configMeta.color,
          category: meta?.category ?? configMeta.category,
          role: configMeta.role ?? null,
          composioToolkits: loaded.config.tools.composio?.toolkits ?? [],
          avatar: configMeta.avatar ?? null,
          pixelAvatar: configMeta.pixelAvatar ?? null,
          firstHello: configMeta.firstHello ?? null,
          starters: Array.isArray(configMeta.starters) ? configMeta.starters : [],
          useCount: (meta as any)?.useCount ?? 0,
          totalCost: (meta as any)?.totalCost ?? 0,
          lastUsedAt: (meta as any)?.lastUsedAt ?? null,
          helperCount: loaded.config.subagents.length,
          isLive,
          kind,
          source: entry.source,
          readOnly: entry.readOnly,
          forkedFrom: entry.forkedFrom,
          hasUpdate: entry.hasUpdate,
        })
      } catch {
        // Profile failed to load — include minimal info. We can't read
        // agent.json metadata here so fall back to schema defaults.
        // Unknown kind defaults to 'agent' so broken profiles stay
        // visible to users who can fix them.
        const kind: 'agent' | 'helper' | 'both' = entry.kind
        if (!matchesKindFilter(kind, kindFilter)) continue
        summaries.push({
          id: entry.name,
          name: entry.name,
          displayName: null,
          description: entry.description ?? '',
          // Fallback branch: profile failed to load through Zod.
          // Default to the Ownware default product so the broken profile
          // still surfaces in the default picker for the user to fix.
          productId: 'ownware',
          // Broken profiles are never locked — keep them visible/fixable.
          locked: false,
          model: 'unknown',
          tags: entry.tags ?? [],
          toolCount: 0,
          hasSkills: false,
          hasMcp: false,
          icon: meta?.icon ?? null,
          color: meta?.color ?? 'violet',
          category: meta?.category ?? 'General',
          role: null,
          composioToolkits: [],
          avatar: null,
          pixelAvatar: null,
          firstHello: null,
          starters: [],
          useCount: (meta as any)?.useCount ?? 0,
          totalCost: (meta as any)?.totalCost ?? 0,
          lastUsedAt: (meta as any)?.lastUsedAt ?? null,
          helperCount: 0,
          isLive,
          kind,
          source: entry.source,
          readOnly: entry.readOnly,
          forkedFrom: entry.forkedFrom,
          hasUpdate: entry.hasUpdate,
        })
      }
    }

    sendJSON(res, 200, summaries)
  }

  function matchesKindFilter(
    kind: 'agent' | 'helper' | 'both',
    filter: string | null,
  ): boolean {
    if (!filter || filter === 'agent') return kind === 'agent' || kind === 'both'
    if (filter === 'helper') return kind === 'helper' || kind === 'both'
    if (filter === 'both') return kind === 'both'
    if (filter === 'all') return true
    // Unknown filter value → fall back to default (agents + both)
    return kind === 'agent' || kind === 'both'
  }

  // GET /api/v1/profiles/:profileId
  async function getProfile(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      // May have been written after boot (builder's create_profile) — re-scan
      // user dirs once before giving up, so Meet/detail resolve without a restart.
      await registry.refreshUser()
      if (!registry.has(profileId)) {
        sendError(res, 404, `Profile "${profileId}" not found`)
        return
      }
    }

    try {
      const loaded = await registry.get(profileId)
      const meta = state?.getProfileMetadata(profileId)
      const isLive = state?.hasActiveRuntime(profileId) ?? false
      const configMeta = loaded.config.metadata
      const helpers = await resolveHelpers(loaded.config.subagents, registry)
      const view = registry.viewFor(profileId)
      const detail: ProfileDetail = {
        id: profileId,
        name: loaded.config.name,
        displayName: loaded.config.displayName ?? null,
        description: loaded.config.description ?? '',
        productId: loaded.config.productId,
        locked: loaded.config.locked,
        model: loaded.config.model,
        tags: loaded.config.tags,
        toolCount: countResolvedTools(loaded.config.tools),
        hasSkills: loaded.skills.length > 0,
        hasMcp: Object.keys(loaded.config.tools.mcp).length > 0,
        icon: meta?.icon ?? configMeta.icon ?? null,
        color: meta?.color ?? configMeta.color,
        category: meta?.category ?? configMeta.category,
        role: configMeta.role ?? null,
        composioToolkits: loaded.config.tools.composio?.toolkits ?? [],
        avatar: configMeta.avatar ?? null,
        pixelAvatar: configMeta.pixelAvatar ?? null,
        firstHello: configMeta.firstHello ?? null,
        starters: Array.isArray(configMeta.starters) ? configMeta.starters : [],
        useCount: (meta as any)?.useCount ?? 0,
        totalCost: (meta as any)?.totalCost ?? 0,
        lastUsedAt: (meta as any)?.lastUsedAt ?? null,
        helperCount: helpers.length,
        isLive,
        kind: loaded.config.kind,
        source: view?.source ?? 'user',
        readOnly: view?.readOnly ?? false,
        forkedFrom: view?.forkedFrom ?? null,
        hasUpdate: view?.hasUpdate ?? false,
        config: loaded.config,
        soulMd: loaded.soulMd,
        agentsMd: loaded.agentsMd,
        skills: loaded.skills.map(s => ({
          name: s.name,
          description: s.description,
          content: s.content,
          // Default to true for legacy / undefined; explicit false only when
          // the loader saw a `.disabled` marker.
          active: s.active !== false,
        })),
        path: loaded.basePath,
        helpers,
      }
      sendJSON(res, 200, detail)
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to load profile')
    }
  }

  // GET /api/v1/profiles/zones
  //
  // Batch sibling of getProfileZones: returns the resolved zone config
  // for EVERY profile in one response so the Settings → Permissions
  // "Autonomy" tab fetches once instead of N times (one per card). A
  // profile that fails to load is omitted — its card surfaces the same
  // honest "Failed to load zones" state it would have hit on the
  // per-profile endpoint. Shape: { zones: [<same per-profile object>] }.
  async function getAllProfileZones(
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const zonesList: unknown[] = []
    for (const entry of registry.list()) {
      try {
        const loaded = await registry.get(entry.name)
        const security = loaded.config.security
        const zones = security.zones
        zonesList.push({
          profileId: entry.name,
          enabled: zones.enabled,
          securityLevel: security.level,
          maxAutoZone: zones.maxAutoZone ?? null,
          maxAskZone: zones.maxAskZone ?? null,
          overrides: zones.overrides,
        })
      } catch {
        // Broken profile — omit from the batch. The card keyed on this
        // profileId finds no entry and renders its "Failed to load
        // zones" state, matching the per-profile endpoint's behaviour.
        continue
      }
    }
    sendJSON(res, 200, { zones: zonesList })
  }

  // GET /api/v1/profiles/:profileId/zones
  //
  // Returns the resolved zone configuration for a profile so the
  // Settings → Permissions "Autonomy" tab can render it. Read-only
  // in this slice — the editor surface (slider PATCH, override CRUD)
  // lands in Phase 4.
  //
  // Shape:
  //   {
  //     enabled: boolean,
  //     securityLevel: 'permissive'|'standard'|'strict'|'paranoid',
  //     maxAutoZone: ZoneName | null,   // profile override or null
  //     maxAskZone:  ZoneName | null,   // profile override or null
  //     overrides:   [{ tool, zone, reason? }, ...]
  //   }
  async function getProfileZones(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }
    try {
      const loaded = await registry.get(profileId)
      const security = loaded.config.security
      const zones = security.zones
      sendJSON(res, 200, {
        profileId,
        enabled: zones.enabled,
        securityLevel: security.level,
        maxAutoZone: zones.maxAutoZone ?? null,
        maxAskZone: zones.maxAskZone ?? null,
        overrides: zones.overrides,
      })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to load profile zones')
    }
  }

  // POST /api/v1/profiles/:profileId/reload
  async function reloadProfile(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    try {
      const loaded = await registry.reload(profileId)
      sendJSON(res, 200, {
        id: profileId,
        name: loaded.config.name,
        reloaded: true,
      })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to reload profile')
    }
  }

  // POST /api/v1/profiles
  async function createProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON<CreateProfileRequest>(req)
    if (!body?.name) {
      sendError(res, 400, 'Missing required field: name')
      return
    }

    // Validate name format
    if (!/^[a-z0-9-]+$/.test(body.name)) {
      sendError(res, 400, 'Profile name must be lowercase alphanumeric with hyphens only')
      return
    }

    // productId is required since slice-08 of product-base-shift Phase 2.
    if (typeof body.productId !== 'string' || body.productId.length === 0) {
      sendError(res, 400, 'Missing required field: productId')
      return
    }
    // productId must name a real product in the canonical catalog — not just
    // any kebab string. A typo'd slug would orphan the profile (no product UI
    // would host it), so reject it loudly here at the boundary rather than
    // letting the client silently drop the profile on read.
    if (!isKnownProduct(body.productId)) {
      sendError(
        res,
        400,
        `Unknown product "${body.productId}". Valid products: ${listProductSlugs().join(', ')}`,
      )
      return
    }
    // Closed products ship a fixed first-party team and do not accept
    // user-authored profiles (their surface is bespoke — IDE, canvas, doc).
    // Only the open product (Ownware) hosts custom profiles.
    if (getProductPolicy(body.productId) === 'closed') {
      sendError(
        res,
        403,
        `Product "${body.productId}" does not accept custom profiles — it ships a fixed first-party team.`,
      )
      return
    }

    if (registry.has(body.name)) {
      sendError(res, 409, `Profile "${body.name}" already exists`)
      return
    }

    const profileDir = join(userProfilesDir, body.name)

    try {
      // Create directory
      await mkdir(profileDir, { recursive: true })

      // Write agent.json
      const config: Record<string, unknown> = {
        name: body.name,
        description: body.description ?? '',
        model: body.model ?? 'anthropic:claude-sonnet-4-20250514',
        productId: body.productId,
      }
      if (body.tools) config['tools'] = body.tools
      if (body.security) config['security'] = body.security

      // Validate with Zod before writing
      const validated = ProfileSchema.parse(config)
      await writeFile(join(profileDir, 'agent.json'), JSON.stringify(validated, null, 2))

      // Write SOUL.md
      const soulContent = body.soulMd ?? `# ${body.name}\n\nYou are a helpful AI assistant.`
      await writeFile(join(profileDir, 'SOUL.md'), soulContent)

      // Write AGENTS.md
      await writeFile(join(profileDir, 'AGENTS.md'), '# Memory\n\nThis file stores what the agent learns across sessions.\n')

      // Create skills directory
      await mkdir(join(profileDir, 'skills'), { recursive: true })

      // Re-discover to pick up new profile
      await registry.discover(userProfilesDir)

      sendJSON(res, 201, {
        id: body.name,
        name: body.name,
        path: profileDir,
        productId: body.productId,
        created: true,
      })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to create profile')
    }
  }

  // PUT /api/v1/profiles/:profileId
  async function updateProfile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const body = await readJSON<UpdateProfileRequest>(req)
    if (!body) {
      sendError(res, 400, 'Request body required')
      return
    }

    try {
      // Copy-on-write: if this profile is built-in, fork it into the
      // user dir before applying any edit. The bundled catalog must
      // never be mutated at runtime. After this call, `registry.get`
      // returns the user copy.
      await registry.forkBuiltin(profileId, userProfilesDir)
      const loaded = await registry.get(profileId)

      // Update agent.json if config provided.
      //
      // Three things happen in this block, in strict order:
      //
      //   1. Read the RAW on-disk agent.json (not `loaded.config`). The
      //      registry's config has all zod defaults applied, so using it
      //      as the merge base would inflate every optional field into
      //      the disk file on first save. The raw on-disk object preserves
      //      whatever minimal shape the author actually wrote.
      //
      //   2. Deep-merge the patch via RFC 7396 JSON Merge Patch. A sparse
      //      patch like `{ security: { level: "strict" } }` must preserve
      //      sibling fields (`security.zones`, `security.permissionMode`,
      //      `security.hitlTimeoutMs`, …). Shallow spread clobbered them.
      //
      //   3. Validate the merged object with the full `ProfileSchema`
      //      BEFORE touching disk. An invalid patch throws here and the
      //      file is never written — the old config remains authoritative.
      //
      // We write the merged (pre-zod-default-expansion) object so the disk
      // file stays minimal. Loader + registry re-apply defaults on read.
      if (body.config) {
        const configPath = join(loaded.basePath, 'agent.json')
        let rawOnDisk: Record<string, unknown>
        try {
          const raw = await readFile(configPath, 'utf-8')
          const parsed: unknown = JSON.parse(raw)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`agent.json at ${configPath} is not a JSON object`)
          }
          rawOnDisk = parsed as Record<string, unknown>
        } catch (readErr) {
          throw new Error(
            `Failed to read ${configPath} before update: ` +
              (readErr instanceof Error ? readErr.message : String(readErr)),
          )
        }

        const merged = deepMergePartial(rawOnDisk, body.config as Record<string, unknown>)
        ProfileSchema.parse(merged) // throws on invalid merge — disk untouched
        await writeFile(configPath, JSON.stringify(merged, null, 2))
      }

      // Update SOUL.md
      if (body.soulMd !== undefined) {
        await writeFile(join(loaded.basePath, 'SOUL.md'), body.soulMd)
      }

      // Update AGENTS.md
      if (body.agentsMd !== undefined) {
        await writeFile(join(loaded.basePath, 'AGENTS.md'), body.agentsMd)
      }

      // Update profile metadata (icon, color, category) in DB
      const metaFields = body as Record<string, unknown>
      if (state && (metaFields.icon !== undefined || metaFields.color !== undefined || metaFields.category !== undefined)) {
        state.setProfileMetadata(profileId, {
          icon: metaFields.icon as string | null | undefined,
          color: metaFields.color as string | null | undefined,
          category: metaFields.category as string | null | undefined,
        })
      }

      // Reload
      const reloaded = await registry.reload(profileId)
      // A PUT can rewrite any part of the profile, including the
      // tools block. Mark every running thread on this profile as
      // pending reconcile — the next turn will diff + apply. If the
      // edit didn't touch tools, the diff is empty and reconcile is
      // a free no-op.
      markThreadsForProfileReconcile(profileId)
      sendJSON(res, 200, {
        id: profileId,
        name: reloaded.config.name,
        updated: true,
      })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to update profile')
    }
  }

  // POST /api/v1/profiles/generate
  async function generateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJSON<GenerateProfileRequest>(req)
    if (!body?.purpose) {
      sendError(res, 400, 'Missing required field: purpose')
      return
    }

    try {
      // Use Loom to generate a profile config
      const { Loom } = await import('@ownware/loom')
      const model = body.model ?? 'anthropic:claude-sonnet-4-20250514'

      const prompt = `You are a profile generator for an AI agent system called Cortex.

Given the user's purpose, generate a complete agent profile as a JSON object.

The JSON must have these fields:
- "name": lowercase-hyphenated short name (e.g., "code-reviewer", "data-analyst")
- "description": one sentence describing the agent
- "soulMd": the full system prompt in markdown (personality, instructions, guidelines)
- "model": the model to use (default: "anthropic:claude-sonnet-4-20250514")
- "tools": { "preset": "full"|"coding"|"readonly"|"none", "deny": [...tool names to deny] }
- "security": { "level": "permissive"|"standard"|"strict", "permissionMode": "auto"|"ask" }
- "tags": array of capability tags

User's purpose: ${body.purpose}

Respond with ONLY the JSON object, no markdown fences, no explanation.`

      const result = await Loom.run(model, prompt, { maxTokens: 2048 })
      const generated = JSON.parse(result.text) as Record<string, unknown>

      const name = typeof generated['name'] === 'string' ? generated['name'] : 'generated-agent'
      const soulMd = typeof generated['soulMd'] === 'string' ? generated['soulMd'] : undefined

      // Remove soulMd from config (it goes to SOUL.md file)
      delete generated['soulMd']

      // Validate
      const validated = ProfileSchema.parse(generated)

      // Write to disk
      const profileDir = join(userProfilesDir, name)
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'agent.json'), JSON.stringify(validated, null, 2))
      if (soulMd) await writeFile(join(profileDir, 'SOUL.md'), soulMd)
      await writeFile(join(profileDir, 'AGENTS.md'), '# Memory\n\nThis file stores what the agent learns across sessions.\n')
      await mkdir(join(profileDir, 'skills'), { recursive: true })

      await registry.discover(userProfilesDir)

      sendJSON(res, 201, { id: name, name, path: profileDir, generated: true, config: validated })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to generate profile')
    }
  }

  // POST /api/v1/profiles/:profileId/files
  async function uploadProfileFile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const body = await readJSON<ProfileFileRequest>(req)
    if (!body?.type || !body.content) {
      sendError(res, 400, 'Missing required fields: type, content')
      return
    }

    try {
      // Fork-on-write: builtin profiles are read-only on disk.
      await registry.forkBuiltin(profileId, userProfilesDir)
      const loaded = await registry.get(profileId)
      let filePath: string

      switch (body.type) {
        case 'soul_md':
          filePath = join(loaded.basePath, 'SOUL.md')
          break
        case 'agents_md':
          filePath = join(loaded.basePath, 'AGENTS.md')
          break
        case 'skill':
          if (!body.skillName) {
            sendError(res, 400, 'Missing required field: skillName (for type "skill")')
            return
          }
          // Defense-in-depth: reject path traversal and unsafe characters
          if (!/^[a-zA-Z0-9_-]+$/.test(body.skillName)) {
            sendError(res, 400, 'Invalid skill name: must be alphanumeric with hyphens/underscores only')
            return
          }
          await mkdir(join(loaded.basePath, 'skills'), { recursive: true })
          filePath = join(loaded.basePath, 'skills', `${body.skillName}.md`)
          break
        default:
          sendError(res, 400, `Invalid file type: ${body.type}`)
          return
      }

      await writeFile(filePath, body.content)
      await registry.reload(profileId)
      sendJSON(res, 200, { updated: true, path: filePath })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to upload file')
    }
  }

  // GET /api/v1/profiles/:profileId/files
  async function listProfileFiles(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    try {
      const loaded = await registry.get(profileId)
      const files: Array<{ name: string; content: string }> = []

      const entries = await readdir(loaded.basePath)
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue
        const fullPath = join(loaded.basePath, entry)
        try {
          const content = await readFile(fullPath, 'utf-8')
          files.push({ name: entry, content })
        } catch {
          // Binary file or directory — skip
        }
      }

      // Also list skills
      try {
        const skillEntries = await readdir(join(loaded.basePath, 'skills'))
        for (const entry of skillEntries) {
          if (!entry.endsWith('.md')) continue
          const content = await readFile(join(loaded.basePath, 'skills', entry), 'utf-8')
          files.push({ name: `skills/${entry}`, content })
        }
      } catch {
        // No skills dir
      }

      sendJSON(res, 200, files)
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to list files')
    }
  }

  // DELETE /api/v1/profiles/:profileId
  async function deleteProfile(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    // Check not in active use
    if (state?.hasActiveRuntime(profileId)) {
      sendError(res, 409, 'Profile is currently in use by an active agent')
      return
    }

    // Built-in profiles are read-only — they cannot be deleted in place.
    // The user can fork (any edit triggers copy-on-write) or, in a
    // future v1.1, hide the built-in via user settings.
    if (registry.sourceOf(profileId) === 'builtin') {
      sendError(
        res,
        409,
        `Profile "${profileId}" is built-in and cannot be deleted. ` +
          `Edit any field to fork it into your library, then delete the fork.`,
      )
      return
    }

    try {
      // Removes from disk; if this was a fork, the underlying built-in
      // re-emerges in the registry's winning slot automatically.
      await registry.removeUser(profileId)
      res.writeHead(204)
      res.end()
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to delete profile')
    }
  }

  // POST /api/v1/profiles/:profileId/duplicate
  //
  // The UI surface presents this as "Fork" on Product Detail (slice-08
  // of product-base-shift Phase 2). The wire endpoint stays named
  // `duplicate` so existing consumers keep working; the optional body is
  // the only thing that's new. See `DuplicateProfileRequest` in
  // `gateway/types.ts` for the reasoning.
  async function duplicateProfile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    // Optional override body. A bodyless POST (the legacy shape) is
    // still accepted; `readJSON` returns `null` for empty bodies which
    // we coerce to `{}`. Validate the slug format when `name` is
    // present — slug-conflict suffixing happens below.
    const body = (await readJSON<DuplicateProfileRequest>(req)) ?? {}
    if (body.name != null && !/^[a-z0-9-]+$/.test(body.name)) {
      sendError(res, 400, 'Profile name must be lowercase alphanumeric with hyphens only')
      return
    }

    try {
      const loaded = await registry.get(profileId)

      // A fork inherits the source's productId (it stays inside the same
      // product). Closed products ship a fixed first-party team and do not
      // accept user-authored profiles, so forking one would smuggle a custom
      // profile into a closed product. Reject it — same policy as create.
      if (getProductPolicy(loaded.config.productId) === 'closed') {
        sendError(
          res,
          403,
          `Product "${loaded.config.productId}" does not accept custom profiles — "${profileId}" cannot be forked.`,
        )
        return
      }

      // Generate the destination slug:
      //   • If `body.name` is supplied, use it (with `-2/-3` suffixing
      //     on conflict so the client always gets a valid result).
      //   • Otherwise fall back to the legacy `<id>-copy[-N]` pattern.
      const baseName = body.name ?? `${profileId}-copy`
      let copyName = baseName
      let counter = 2
      while (registry.has(copyName) || existsSync(join(userProfilesDir, copyName))) {
        copyName = `${baseName}-${counter}`
        counter++
      }

      // Copy directory
      const destDir = join(userProfilesDir, copyName)
      await cp(loaded.basePath, destDir, { recursive: true })

      // Update name (always) + optional description in copied agent.json.
      // productId is inherited from the source — fork stays inside the
      // same product (slice-08 brief edge case).
      const configPath = join(destDir, 'agent.json')
      const configRaw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(configRaw)
      config.name = copyName
      if (body.description != null) {
        config.description = body.description
      }
      await writeFile(configPath, JSON.stringify(config, null, 2))

      // Optional SOUL.md override. When omitted, the source SOUL.md
      // (already copied by `cp -r`) stays as-is.
      if (body.soulMd != null) {
        await writeFile(join(destDir, 'SOUL.md'), body.soulMd)
      }

      // Re-discover
      await registry.discover(userProfilesDir)

      // Create metadata for the copy
      if (state) {
        const originalMeta = state.getProfileMetadata(profileId)
        if (originalMeta) {
          state.setProfileMetadata(copyName, {
            icon: originalMeta.icon,
            color: originalMeta.color,
            category: originalMeta.category,
          })
        }
      }

      sendJSON(res, 201, {
        id: copyName,
        name: copyName,
        path: destDir,
        duplicatedFrom: profileId,
        productId: config.productId ?? null,
      })
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Failed to duplicate profile')
    }
  }

  // ── T03: Composio toolkit attach / detach ───────────────────────────────
  //
  // Parallel to `addMCPToProfile` / `removeMCPFromProfile` (in
  // `handlers/mcp.ts`). Gives the client a dedicated, typed attach surface
  // for Composio toolkits so every attach flow goes through one handler
  // instead of routing Composio through the generic `PUT /profiles/:id`
  // merge. Idempotent on POST; 404 on DELETE of a slug not present.

  /** Toolkit slugs are kebab-case identifiers in Composio's catalog. */
  const ToolkitSchema = z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'toolkit must match /^[a-z0-9_-]+$/')

  const AddComposioBodySchema = z.object({ toolkit: ToolkitSchema }).strict()

  async function addComposioToProfile(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    const raw = await readJSON(req).catch(() => null)
    const parsed = AddComposioBodySchema.safeParse(raw ?? {})
    if (!parsed.success) {
      sendError(res, 400, `Invalid body: ${parsed.error.message}`)
      return
    }
    const { toolkit } = parsed.data

    try {
      const added = await registry.addProfileComposioToolkit(
        profileId,
        toolkit,
        userProfilesDir,
      )
      if (added) markThreadsForProfileReconcile(profileId)
      // Idempotent: 200 either way. `added === false` means the slug
      // was already in the profile — no-op, still success.
      sendJSON(res, 200, { profileId, toolkit, added })
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to attach toolkit: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async function removeComposioFromProfile(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const profileId = params['profileId']!
    const toolkit = params['toolkit']!

    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    // Validate the path param against the same slug grammar as POST —
    // stops malformed paths (e.g. percent-encoded junk) from touching
    // disk.
    const slugCheck = ToolkitSchema.safeParse(toolkit)
    if (!slugCheck.success) {
      sendError(res, 400, `Invalid toolkit slug: ${slugCheck.error.message}`)
      return
    }

    try {
      const removed = await registry.removeProfileComposioToolkit(
        profileId,
        toolkit,
        userProfilesDir,
      )
      if (!removed) {
        sendError(
          res,
          404,
          `Toolkit "${toolkit}" not in profile "${profileId}".`,
        )
        return
      }
      markThreadsForProfileReconcile(profileId)
      res.writeHead(204)
      res.end()
    } catch (err) {
      sendError(
        res,
        500,
        `Failed to detach toolkit: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    listProfiles,
    getProfile,
    getProfileZones,
    getAllProfileZones,
    reloadProfile,
    createProfile,
    updateProfile,
    generateProfile,
    uploadProfileFile,
    listProfileFiles,
    deleteProfile,
    duplicateProfile,
    addComposioToProfile,
    removeComposioFromProfile,
  }
}
