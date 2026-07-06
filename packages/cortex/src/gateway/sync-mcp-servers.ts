/**
 * Two-phase reconcile of MCP server data from `agent.json` files into
 * the `mcp_servers` + `profile_mcp_servers` tables.
 *
 * Extracted from `server.ts:syncMCPServers` so the logic is testable
 * without booting the full gateway. The class method is now a thin
 * wrapper that supplies the live state + profile registry.
 *
 * Contract:
 *
 *   1. **Forward sync (additive):** for every (profileId, serverId)
 *      declared in `agent.json`, ensure the `mcp_servers` row exists
 *      and the `profile_mcp_servers` assignment exists.
 *   2. **Reverse reconcile (removal):**
 *        a. For each profile, drop `profile_mcp_servers` rows whose
 *           serverId is no longer in that profile's `tools.mcp`.
 *        b. For each `mcp_servers` row whose `registry_id` is NULL or
 *           a featured-id (i.e. the row was created by a profile sync,
 *           NOT user-registered or auto-detected), delete it if no
 *           profile still references it.
 *
 * Auto-detected (`registry_id = 'detected'`) and user-registered
 * (`registry_id = 'custom'`) rows are NEVER auto-removed — those are
 * user-owned data and only get cleaned up via explicit DELETE on the
 * register endpoint or the auto-detect re-scan replacing them.
 *
 * Defensive: when a profile fails to load (malformed agent.json,
 * filesystem error), it's SKIPPED entirely — its assignments survive.
 * A transient read error must not delete user data.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPServerConfigForSync {
  readonly transport: string
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
}

export interface MCPServerRecordForSync {
  readonly id: string
  readonly registryId?: string | null
}

export interface ProfileForSync {
  readonly id: string
  /** When `null`, the profile failed to load and is skipped from reconcile. */
  readonly mcp: Record<string, MCPServerConfigForSync> | null
}

export interface SyncMCPServersStateAdapter {
  getMCPServer(id: string): MCPServerRecordForSync | undefined
  createMCPServer(server: {
    id: string
    name: string
    transport: string
    url?: string
    command?: string
    args?: readonly string[]
  }): unknown
  assignServerToProfile(serverId: string, profileId: string): void
  removeServerFromProfile(serverId: string, profileId: string): boolean
  getServersForProfile(profileId: string): readonly MCPServerRecordForSync[]
  listMCPServers(opts?: {
    limit?: number
    offset?: number
  }): { items: readonly MCPServerRecordForSync[] }
  deleteMCPServer(id: string): boolean
}

export interface SyncMCPServersResult {
  readonly addedAssignments: number
  readonly createdServers: number
  readonly removedAssignments: number
  readonly removedOrphanedServers: number
  /** Per-removal lines for telemetry / logging. */
  readonly removalLog: readonly string[]
}

export interface SyncMCPServersLogger {
  info(msg: string): void
}

const NOOP_LOGGER: SyncMCPServersLogger = { info: () => undefined }

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function reconcileMCPServers(
  profiles: readonly ProfileForSync[],
  state: SyncMCPServersStateAdapter,
  logger: SyncMCPServersLogger = NOOP_LOGGER,
): SyncMCPServersResult {
  const declared = new Map<string, Set<string>>()
  // Track profiles whose `mcp` is null (load failure). Their existing
  // assignments must NOT be reconciled — a transient read error must
  // not delete user data.
  const skippedProfileIds = new Set<string>()

  let addedAssignments = 0
  let createdServers = 0
  let removedAssignments = 0
  let removedOrphanedServers = 0
  const removalLog: string[] = []

  // Phase 1 — forward sync (additive). Only profiles whose `mcp` is
  // non-null participate; the null sentinel marks a load failure.
  for (const profile of profiles) {
    if (profile.mcp === null) {
      skippedProfileIds.add(profile.id)
      continue
    }
    const ids = new Set<string>()
    declared.set(profile.id, ids)

    for (const [serverId, config] of Object.entries(profile.mcp)) {
      ids.add(serverId)
      if (state.getMCPServer(serverId) === undefined) {
        const transport =
          config.transport === 'streamable_http' ? 'http' : config.transport
        state.createMCPServer({
          id: serverId,
          name: serverId.split('/').pop() ?? serverId,
          transport,
          ...(config.url !== undefined ? { url: config.url } : {}),
          ...(config.command !== undefined ? { command: config.command } : {}),
          ...(config.args !== undefined && config.args.length > 0
            ? { args: config.args }
            : {}),
        })
        createdServers++
      }
      state.assignServerToProfile(serverId, profile.id)
      addedAssignments++
    }
  }

  // Phase 2a — drop stale profile_mcp_servers assignments.
  for (const [profileId, declaredIds] of declared) {
    const liveAssigned = state.getServersForProfile(profileId)
    for (const row of liveAssigned) {
      if (!declaredIds.has(row.id)) {
        state.removeServerFromProfile(row.id, profileId)
        const line = `removed stale assignment profile='${profileId}' serverId='${row.id}' reason='not in agent.json'`
        removalLog.push(line)
        logger.info(`[ownware] syncMCPServers: ${line}`)
        removedAssignments++
      }
    }
  }

  // Phase 2b — drop orphaned mcp_servers rows.
  //
  // A server is "referenced" if either:
  //   (a) some declared profile lists it in its agent.json, OR
  //   (b) some skipped (load-failed) profile still has a live
  //       assignment to it. We can't tell from a failed read whether
  //       the user actually wants the server gone, so we err on the
  //       side of preserving it.
  //
  // Skip user-owned markers ('custom', 'detected'); those persist
  // regardless of profile references.
  const allServers = state.listMCPServers({ limit: 5000 })
  // Pre-compute the set of serverIds referenced by any skipped profile.
  const skippedReferences = new Set<string>()
  for (const profileId of skippedProfileIds) {
    for (const row of state.getServersForProfile(profileId)) {
      skippedReferences.add(row.id)
    }
  }

  for (const row of allServers.items) {
    if (row.registryId === 'custom' || row.registryId === 'detected') continue
    let referenced = false
    for (const set of declared.values()) {
      if (set.has(row.id)) {
        referenced = true
        break
      }
    }
    if (!referenced && skippedReferences.has(row.id)) {
      referenced = true
    }
    if (!referenced) {
      state.deleteMCPServer(row.id)
      const line = `removed orphaned mcp_server id='${row.id}' registryId='${row.registryId ?? 'null'}' reason='no profile references it'`
      removalLog.push(line)
      logger.info(`[ownware] syncMCPServers: ${line}`)
      removedOrphanedServers++
    }
  }

  return {
    addedAssignments,
    createdServers,
    removedAssignments,
    removedOrphanedServers,
    removalLog,
  }
}
