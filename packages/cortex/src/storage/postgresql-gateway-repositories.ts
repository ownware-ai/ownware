import { randomUUID } from 'node:crypto'
import type {
  AppState,
  AuditLogEntry,
  LocalProfile,
  MCPServerRecord,
  ProfileMetadata,
  Thread,
  ThreadMessage,
  UserSettings,
  Workspace,
} from '../gateway/types.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type {
  GatewayDataExport,
  GatewayRepositories,
  MCPServerCreateInput,
  MCPServerUpdate,
  WorkspaceUpdate,
} from './gateway-repositories.js'
import type { PostgreSqlPool, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  finiteNumber,
  nullableSafeInteger,
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

type QueryClient = PostgreSqlPool | PostgreSqlPoolClient

interface WorkspaceRow {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly status: string
  readonly last_profile_id: string | null
  readonly pinned: boolean
  readonly active_products: string
  readonly last_opened_at: string
  readonly created_at: string
  readonly updated_at: string
}

interface ThreadRow {
  readonly id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly title: string | null
  readonly status: string
  readonly message_count: unknown
  readonly total_tokens: unknown
  readonly total_cost: unknown
  readonly model: string | null
  readonly last_message_preview: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface MCPServerRow {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly url: string | null
  readonly command: string | null
  readonly args: string | null
  readonly env: string | null
  readonly headers: string | null
  readonly registry_id: string | null
  readonly tool_count: unknown | null
  readonly tools_json: string | null
  readonly status: string
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly profile_ids?: readonly string[]
}

interface LocalProfileRow {
  readonly id: string
  readonly display_name: string
  readonly avatar_url: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface SettingsRow {
  readonly id: string
  readonly key: string
  readonly value: string
  readonly updated_at: string
}

interface ProfileMetadataRow {
  readonly profile_id: string
  readonly icon: string | null
  readonly color: string | null
  readonly category: string | null
  readonly use_count: unknown
  readonly total_cost: unknown
  readonly last_used_at: string | null
  readonly updated_at: string
}

interface AppStateRow {
  readonly key: string
  readonly value: string
  readonly updated_at: string
}

interface MessageRow {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly tools: string | null
  readonly sub_agents: string | null
  readonly permissions: string | null
  readonly attachments: string | null
  readonly thinking: string | null
  readonly usage_input: unknown | null
  readonly usage_output: unknown | null
  readonly usage_cache_read: unknown | null
  readonly usage_cache_creation: unknown | null
  readonly created_at: string
  readonly parts: string | null
  readonly credentials: string | null
  readonly model: string | null
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

function now(): string {
  return new Date().toISOString()
}

function parseActiveProducts(raw: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return ['ownware']
    const products = value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    )
    return products.length === 0 ? ['ownware'] : products
  } catch {
    return ['ownware']
  }
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    status: row.status as Workspace['status'],
    lastProfileId: row.last_profile_id,
    pinned: row.pinned,
    tabCount: 0,
    activeProducts: parseActiveProducts(row.active_products),
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as Thread['status'],
    messageCount: safeInteger(row.message_count),
    totalTokens: safeInteger(row.total_tokens),
    totalCost: finiteNumber(row.total_cost),
    model: row.model,
    lastMessagePreview: row.last_message_preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJson(value: string | null): unknown | undefined {
  return value === null ? undefined : JSON.parse(value) as unknown
}

function mapMessage(row: MessageRow): ThreadMessage {
  const usageInput = nullableSafeInteger(row.usage_input)
  return {
    id: row.id,
    role: row.role as ThreadMessage['role'],
    content: row.content,
    tools: parseJson(row.tools) as ThreadMessage['tools'],
    subAgents: parseJson(row.sub_agents) as ThreadMessage['subAgents'],
    permissions: parseJson(row.permissions) as ThreadMessage['permissions'],
    credentials: parseJson(row.credentials) as ThreadMessage['credentials'],
    attachments: parseJson(row.attachments) as ThreadMessage['attachments'],
    thinking: row.thinking ?? undefined,
    usage: usageInput === null
      ? undefined
      : {
          inputTokens: usageInput,
          outputTokens: nullableSafeInteger(row.usage_output) ?? 0,
          ...(row.usage_cache_read === null
            ? {}
            : { cacheReadTokens: safeInteger(row.usage_cache_read) }),
          ...(row.usage_cache_creation === null
            ? {}
            : { cacheCreationTokens: safeInteger(row.usage_cache_creation) }),
        },
    timestamp: row.created_at,
    parts: parseJson(row.parts) as ThreadMessage['parts'],
    ...(row.model === null ? {} : { model: row.model }),
  }
}

function mapMCPServer(row: MCPServerRow): MCPServerRecord {
  let toolsMetadata: MCPServerRecord['toolsMetadata'] = null
  if (row.tools_json !== null) {
    try {
      toolsMetadata = JSON.parse(row.tools_json) as MCPServerRecord['toolsMetadata']
    } catch {
      toolsMetadata = null
    }
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as MCPServerRecord['transport'],
    url: row.url,
    command: row.command,
    args: row.args === null ? [] : JSON.parse(row.args) as readonly string[],
    env: row.env === null ? {} : JSON.parse(row.env) as Record<string, string>,
    headers: row.headers === null ? {} : JSON.parse(row.headers) as Record<string, string>,
    registryId: row.registry_id,
    toolCount: row.tool_count === null ? null : safeInteger(row.tool_count),
    toolsMetadata,
    status: row.status as MCPServerRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileIds: row.profile_ids ?? [],
  }
}

function mapLocalProfile(row: LocalProfileRow): LocalProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSettings(row: SettingsRow): UserSettings {
  return { id: row.id, key: row.key, value: row.value, updatedAt: row.updated_at }
}

function mapProfileMetadata(row: ProfileMetadataRow): ProfileMetadata {
  return {
    profileId: row.profile_id,
    icon: row.icon,
    color: row.color,
    category: row.category,
    useCount: safeInteger(row.use_count),
    totalCost: finiteNumber(row.total_cost),
    lastUsedAt: row.last_used_at,
    updatedAt: row.updated_at,
  }
}

function mapAppState(row: AppStateRow): AppState {
  return { key: row.key, value: row.value, updatedAt: row.updated_at }
}

async function getWorkspace(client: QueryClient, workspaceId: string): Promise<Workspace | undefined> {
  const result = await client.query<WorkspaceRow>(
    'SELECT * FROM ownware.workspaces WHERE id = $1',
    [workspaceId],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : mapWorkspace(row)
}

async function getMCPServer(client: QueryClient, serverId: string): Promise<MCPServerRecord | undefined> {
  const result = await client.query<MCPServerRow>(`
    SELECT server.*, COALESCE(
      array_agg(link.profile_id ORDER BY link.profile_id)
        FILTER (WHERE link.profile_id IS NOT NULL),
      ARRAY[]::text[]
    ) AS profile_ids
    FROM ownware.mcp_servers AS server
    LEFT JOIN ownware.profile_mcp_servers AS link ON link.server_id = server.id
    WHERE server.id = $1
    GROUP BY server.id
  `, [serverId])
  const row = result.rows[0]
  return row === undefined ? undefined : mapMCPServer(row)
}

async function getLocalProfile(client: QueryClient): Promise<LocalProfile | undefined> {
  const result = await client.query<LocalProfileRow>(
    'SELECT * FROM ownware.local_profile ORDER BY created_at ASC, id ASC LIMIT 1',
  )
  const row = result.rows[0]
  return row === undefined ? undefined : mapLocalProfile(row)
}

async function getSetting(client: QueryClient, key: string): Promise<UserSettings | undefined> {
  const result = await client.query<SettingsRow>(
    'SELECT * FROM ownware.user_settings WHERE key = $1',
    [key],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : mapSettings(row)
}

async function getProfileMetadata(
  client: QueryClient,
  profileId: string,
): Promise<ProfileMetadata | undefined> {
  const result = await client.query<ProfileMetadataRow>(
    'SELECT * FROM ownware.profile_metadata WHERE profile_id = $1',
    [profileId],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : mapProfileMetadata(row)
}

async function getAppState(client: QueryClient, key: string): Promise<AppState | undefined> {
  const result = await client.query<AppStateRow>(
    'SELECT * FROM ownware.app_state WHERE key = $1',
    [key],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : mapAppState(row)
}

function workspaceSideTrackWidthKey(workspaceId: string): string {
  return `cx.workspace.${workspaceId}.sideTrackWidth`
}

async function updateWorkspace(
  client: PostgreSqlPoolClient,
  workspaceId: string,
  updates: WorkspaceUpdate,
): Promise<Workspace | undefined> {
  const current = await getWorkspace(client, workspaceId)
  if (current === undefined) return undefined
  const timestamp = now()
  await client.query(`
    UPDATE ownware.workspaces SET
      name = $1, pinned = $2, status = $3, last_profile_id = $4,
      active_products = $5, last_opened_at = $6, updated_at = $6
    WHERE id = $7
  `, [
    updates.name ?? current.name,
    updates.pinned ?? current.pinned,
    updates.status ?? current.status,
    updates.lastProfileId ?? current.lastProfileId,
    JSON.stringify(updates.activeProducts ?? current.activeProducts),
    timestamp,
    workspaceId,
  ])
  return getWorkspace(client, workspaceId)
}

async function updateMCPServer(
  client: QueryClient,
  serverId: string,
  updates: MCPServerUpdate,
): Promise<MCPServerRecord | undefined> {
  const result = await client.query(`
    UPDATE ownware.mcp_servers SET
      name = COALESCE($1, name),
      status = COALESCE($2, status),
      tool_count = CASE WHEN $3 THEN $4 ELSE tool_count END,
      error = CASE WHEN $5 THEN $6 ELSE error END,
      tools_json = CASE WHEN $7 THEN $8 ELSE tools_json END,
      updated_at = $9
    WHERE id = $10
  `, [
    updates.name ?? null,
    updates.status ?? null,
    updates.toolCount !== undefined,
    updates.toolCount ?? null,
    updates.error !== undefined,
    updates.error ?? null,
    updates.toolsJson !== undefined,
    updates.toolsJson ?? null,
    now(),
    serverId,
  ])
  return (result.rowCount ?? 0) === 0 ? undefined : getMCPServer(client, serverId)
}

async function exportAll(client: QueryClient): Promise<GatewayDataExport> {
  const threadRows = await client.query<ThreadRow>(
    'SELECT * FROM ownware.threads ORDER BY created_at DESC, id ASC',
  )
  const threads = threadRows.rows.map(mapThread)
  const messages: Record<string, ThreadMessage[]> = {}
  for (const thread of threads) {
    const rows = await client.query<MessageRow>(`
      SELECT * FROM ownware.messages
      WHERE thread_id = $1 ORDER BY message_seq ASC
    `, [thread.id])
    messages[thread.id] = rows.rows.map(mapMessage)
  }
  const workspaceRows = await client.query<WorkspaceRow>(
    'SELECT * FROM ownware.workspaces ORDER BY created_at DESC, id ASC',
  )
  const settingsRows = await client.query<SettingsRow>(
    'SELECT * FROM ownware.user_settings ORDER BY key ASC',
  )
  const usage = await client.query<{
    readonly tokens: unknown
    readonly cost: unknown
    readonly count: unknown
  }>(`
    SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
      COALESCE(SUM(cost_usd), 0) AS cost,
      count(*)::text AS count
    FROM ownware.usage_records
  `)
  const aggregate = usage.rows[0] ?? { tokens: '0', cost: 0, count: '0' }
  return {
    threads,
    messages,
    workspaces: workspaceRows.rows.map(mapWorkspace),
    settings: settingsRows.rows.map(mapSettings),
    usage: {
      totalTokens: safeInteger(aggregate.tokens),
      totalCost: finiteNumber(aggregate.cost),
      recordCount: safeInteger(aggregate.count),
    },
  }
}

/** Complete PostgreSQL implementation of GatewayState's legacy durable authorities. */
export function createPostgreSqlGatewayRepositories(
  context: PostgreSqlRootRepositoryContext,
): GatewayRepositories {
  return {
    workspaces: {
      create(path, name) {
        return repositoryCall(context, 'workspaces', 'create', 'write_failed', async (client) => {
          const workspaceId = id('ws')
          const timestamp = now()
          const workspaceName = name ?? path.split('/').filter(Boolean).pop() ?? 'workspace'
          await client.query(`
            INSERT INTO ownware.workspaces (
              id, name, path, status, pinned, last_opened_at, created_at, updated_at
            ) VALUES ($1, $2, $3, 'active', FALSE, $4, $4, $4)
          `, [workspaceId, workspaceName, path, timestamp])
          return (await getWorkspace(client, workspaceId))!
        })
      },
      get(workspaceId) {
        return repositoryCall(context, 'workspaces', 'get', 'read_failed', (client) =>
          getWorkspace(client, workspaceId))
      },
      getByPath(path) {
        return repositoryCall(context, 'workspaces', 'get_by_path', 'read_failed', async (client) => {
          const result = await client.query<WorkspaceRow>(
            'SELECT * FROM ownware.workspaces WHERE path = $1',
            [path],
          )
          const row = result.rows[0]
          return row === undefined ? undefined : mapWorkspace(row)
        })
      },
      list(status, options) {
        return repositoryCall(context, 'workspaces', 'list', 'read_failed', async (client) => {
          const limit = Math.min(options?.limit ?? 50, 200)
          const offset = options?.offset ?? 0
          const count = status === undefined
            ? await client.query<{ readonly count: string }>(
                'SELECT count(*)::text AS count FROM ownware.workspaces',
              )
            : await client.query<{ readonly count: string }>(
                'SELECT count(*)::text AS count FROM ownware.workspaces WHERE status = $1',
                [status],
              )
          const rows = status === undefined
            ? await client.query<WorkspaceRow>(`
                SELECT * FROM ownware.workspaces
                ORDER BY pinned DESC, last_opened_at DESC, id ASC LIMIT $1 OFFSET $2
              `, [limit, offset])
            : await client.query<WorkspaceRow>(`
                SELECT * FROM ownware.workspaces WHERE status = $1
                ORDER BY pinned DESC, last_opened_at DESC, id ASC LIMIT $2 OFFSET $3
              `, [status, limit, offset])
          return {
            items: rows.rows.map(mapWorkspace),
            total: safeInteger(count.rows[0]?.count ?? '0'),
            offset,
            limit,
          }
        })
      },
      detail(workspaceId) {
        return repositoryCall(context, 'workspaces', 'detail', 'read_failed', async (client) => {
          const workspace = await getWorkspace(client, workspaceId)
          if (workspace === undefined) return undefined
          const profiles = await client.query<{
            readonly profile_id: string
            readonly thread_count: unknown
            readonly last_used_at: string
          }>(`
            SELECT profile_id, thread_count, last_used_at
            FROM ownware.workspace_profiles WHERE workspace_id = $1
            ORDER BY last_used_at DESC, profile_id ASC
          `, [workspaceId])
          const counts = await client.query<{
            readonly active_threads: string
            readonly total_threads: string
          }>(`
            SELECT count(*) FILTER (WHERE status = 'active')::text AS active_threads,
              count(*)::text AS total_threads
            FROM ownware.threads WHERE workspace_id = $1
          `, [workspaceId])
          return {
            ...workspace,
            profiles: profiles.rows.map((row) => ({
              profileId: row.profile_id,
              threadCount: safeInteger(row.thread_count),
              lastUsedAt: row.last_used_at,
            })),
            activeThreads: safeInteger(counts.rows[0]?.active_threads ?? '0'),
            totalThreads: safeInteger(counts.rows[0]?.total_threads ?? '0'),
          }
        })
      },
      update(workspaceId, updates) {
        return repositoryCall(context, 'workspaces', 'update', 'write_failed', (pool) =>
          withPostgreSqlTransaction(pool as PostgreSqlPool, async (client) => {
            await client.query('SELECT id FROM ownware.workspaces WHERE id = $1 FOR UPDATE', [workspaceId])
            return updateWorkspace(client, workspaceId, updates)
          }))
      },
      delete(workspaceId) {
        return repositoryCall(context, 'workspaces', 'delete', 'write_failed', async (client) => {
          const result = await client.query('DELETE FROM ownware.workspaces WHERE id = $1', [workspaceId])
          return (result.rowCount ?? 0) > 0
        })
      },
      touch(workspaceId) {
        return repositoryCall(context, 'workspaces', 'touch', 'write_failed', async (client) => {
          const timestamp = now()
          await client.query(`
            UPDATE ownware.workspaces SET last_opened_at = $1, updated_at = $1 WHERE id = $2
          `, [timestamp, workspaceId])
        })
      },
      listThreads(workspaceId) {
        return repositoryCall(context, 'workspaces', 'list_threads', 'read_failed', async (client) => {
          const result = await client.query<ThreadRow>(`
            SELECT * FROM ownware.threads WHERE workspace_id = $1
            ORDER BY updated_at DESC, id ASC
          `, [workspaceId])
          return result.rows.map(mapThread)
        })
      },
    },
    mcpServers: {
      create(input: MCPServerCreateInput) {
        return repositoryCall(context, 'mcp_servers', 'create', 'write_failed', async (client) => {
          const timestamp = now()
          await client.query(`
            INSERT INTO ownware.mcp_servers (
              id, name, transport, url, command, args, env, headers, registry_id,
              status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'configured', $10, $10)
          `, [
            input.id,
            input.name,
            input.transport,
            input.url ?? null,
            input.command ?? null,
            input.args === undefined ? null : JSON.stringify(input.args),
            input.env === undefined ? null : JSON.stringify(input.env),
            input.headers === undefined ? null : JSON.stringify(input.headers),
            input.registryId ?? null,
            timestamp,
          ])
          return (await getMCPServer(client, input.id))!
        })
      },
      get(serverId) {
        return repositoryCall(context, 'mcp_servers', 'get', 'read_failed', (client) =>
          getMCPServer(client, serverId))
      },
      list(options) {
        return repositoryCall(context, 'mcp_servers', 'list', 'read_failed', async (client) => {
          const limit = Math.min(options?.limit ?? 50, 200)
          const offset = options?.offset ?? 0
          const count = await client.query<{ readonly count: string }>(
            'SELECT count(*)::text AS count FROM ownware.mcp_servers',
          )
          const rows = await client.query<MCPServerRow>(`
            SELECT server.*, COALESCE(
              array_agg(link.profile_id ORDER BY link.profile_id)
                FILTER (WHERE link.profile_id IS NOT NULL),
              ARRAY[]::text[]
            ) AS profile_ids
            FROM ownware.mcp_servers AS server
            LEFT JOIN ownware.profile_mcp_servers AS link ON link.server_id = server.id
            GROUP BY server.id
            ORDER BY server.name ASC, server.id ASC LIMIT $1 OFFSET $2
          `, [limit, offset])
          return {
            items: rows.rows.map(mapMCPServer),
            total: safeInteger(count.rows[0]?.count ?? '0'),
            offset,
            limit,
          }
        })
      },
      update(serverId, updates) {
        return repositoryCall(context, 'mcp_servers', 'update', 'write_failed', (client) =>
          updateMCPServer(client, serverId, updates))
      },
      delete(serverId) {
        return repositoryCall(context, 'mcp_servers', 'delete', 'write_failed', async (client) => {
          const result = await client.query('DELETE FROM ownware.mcp_servers WHERE id = $1', [serverId])
          return (result.rowCount ?? 0) > 0
        })
      },
      assignToProfile(serverId, profileId) {
        return repositoryCall(context, 'mcp_servers', 'assign_to_profile', 'write_failed', async (client) => {
          await client.query(`
            INSERT INTO ownware.profile_mcp_servers (profile_id, server_id)
            VALUES ($1, $2) ON CONFLICT (profile_id, server_id) DO NOTHING
          `, [profileId, serverId])
        })
      },
      removeFromProfile(serverId, profileId) {
        return repositoryCall(context, 'mcp_servers', 'remove_from_profile', 'write_failed', async (client) => {
          const result = await client.query(`
            DELETE FROM ownware.profile_mcp_servers WHERE server_id = $1 AND profile_id = $2
          `, [serverId, profileId])
          return (result.rowCount ?? 0) > 0
        })
      },
      listForProfile(profileId) {
        return repositoryCall(context, 'mcp_servers', 'list_for_profile', 'read_failed', async (client) => {
          const result = await client.query<MCPServerRow>(`
            SELECT server.*, ARRAY[$1]::text[] AS profile_ids
            FROM ownware.mcp_servers AS server
            INNER JOIN ownware.profile_mcp_servers AS link ON link.server_id = server.id
            WHERE link.profile_id = $1 ORDER BY server.name ASC, server.id ASC
          `, [profileId])
          return result.rows.map(mapMCPServer)
        })
      },
    },
    localProfile: {
      create(displayName, avatarUrl) {
        return repositoryCall(context, 'local_profile', 'create', 'write_failed', async (client) => {
          const profileId = id('lp')
          const timestamp = now()
          await client.query(`
            INSERT INTO ownware.local_profile (id, display_name, avatar_url, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $4)
          `, [profileId, displayName, avatarUrl ?? null, timestamp])
          return { profileId, timestamp }
        }).then(({ profileId, timestamp }) => ({
          id: profileId,
          displayName,
          avatarUrl: avatarUrl ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }))
      },
      get() {
        return repositoryCall(context, 'local_profile', 'get', 'read_failed', getLocalProfile)
      },
      update(profileId, updates) {
        return repositoryCall(context, 'local_profile', 'update', 'write_failed', async (client) => {
          const result = await client.query(`
            UPDATE ownware.local_profile SET
              display_name = COALESCE($1, display_name),
              avatar_url = CASE WHEN $2 THEN $3 ELSE avatar_url END,
              updated_at = $4
            WHERE id = $5
          `, [
            updates.displayName ?? null,
            updates.avatarUrl !== undefined,
            updates.avatarUrl ?? null,
            now(),
            profileId,
          ])
          return (result.rowCount ?? 0) === 0 ? undefined : getLocalProfile(client)
        })
      },
    },
    settings: {
      get(key) {
        return repositoryCall(context, 'user_settings', 'get', 'read_failed', (client) =>
          getSetting(client, key))
      },
      set(key, value) {
        return repositoryCall(context, 'user_settings', 'set', 'write_failed', async (client) => {
          await client.query(`
            INSERT INTO ownware.user_settings (id, key, value, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
          `, [id('set'), key, value, now()])
          return (await getSetting(client, key))!
        })
      },
      list() {
        return repositoryCall(context, 'user_settings', 'list', 'read_failed', async (client) => {
          const result = await client.query<SettingsRow>(
            'SELECT * FROM ownware.user_settings ORDER BY key ASC',
          )
          return result.rows.map(mapSettings)
        })
      },
      delete(key) {
        return repositoryCall(context, 'user_settings', 'delete', 'write_failed', async (client) => {
          const result = await client.query('DELETE FROM ownware.user_settings WHERE key = $1', [key])
          return (result.rowCount ?? 0) > 0
        })
      },
    },
    profileMetadata: {
      get(profileId) {
        return repositoryCall(context, 'profile_metadata', 'get', 'read_failed', (client) =>
          getProfileMetadata(client, profileId))
      },
      set(profileId, updates) {
        return repositoryCall(context, 'profile_metadata', 'set', 'write_failed', (pool) =>
          withPostgreSqlTransaction(pool as PostgreSqlPool, async (client) => {
            await client.query(
              'SELECT profile_id FROM ownware.profile_metadata WHERE profile_id = $1 FOR UPDATE',
              [profileId],
            )
            const current = await getProfileMetadata(client, profileId)
            await client.query(`
              INSERT INTO ownware.profile_metadata (
                profile_id, icon, color, category, updated_at
              ) VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (profile_id) DO UPDATE SET
                icon = EXCLUDED.icon,
                color = EXCLUDED.color,
                category = EXCLUDED.category,
                updated_at = EXCLUDED.updated_at
            `, [
              profileId,
              updates.icon !== undefined ? updates.icon : (current?.icon ?? null),
              updates.color !== undefined ? updates.color : (current?.color ?? null),
              updates.category !== undefined ? updates.category : (current?.category ?? null),
              now(),
            ])
            return (await getProfileMetadata(client, profileId))!
          }))
      },
      list() {
        return repositoryCall(context, 'profile_metadata', 'list', 'read_failed', async (client) => {
          const result = await client.query<ProfileMetadataRow>(
            'SELECT * FROM ownware.profile_metadata ORDER BY profile_id ASC',
          )
          return result.rows.map(mapProfileMetadata)
        })
      },
    },
    appState: {
      get(key) {
        return repositoryCall(context, 'app_state', 'get', 'read_failed', (client) =>
          getAppState(client, key))
      },
      set(key, value) {
        return repositoryCall(context, 'app_state', 'set', 'write_failed', async (client) => {
          await client.query(`
            INSERT INTO ownware.app_state (key, value, updated_at) VALUES ($1, $2, $3)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
          `, [key, value, now()])
          return (await getAppState(client, key))!
        })
      },
      getWorkspaceSideTrackWidth(workspaceId) {
        return repositoryCall(
          context,
          'app_state',
          'get_workspace_side_track_width',
          'read_failed',
          async (client) => {
            const state = await getAppState(client, workspaceSideTrackWidthKey(workspaceId))
            if (state === undefined) return null
            const parsed = Number.parseInt(state.value, 10)
            return !Number.isFinite(parsed) || parsed <= 0 ? null : parsed
          },
        )
      },
      setWorkspaceSideTrackWidth(workspaceId, widthPx) {
        return repositoryCall(
          context,
          'app_state',
          'set_workspace_side_track_width',
          'write_failed',
          async (client) => {
            const key = workspaceSideTrackWidthKey(workspaceId)
            await client.query(`
              INSERT INTO ownware.app_state (key, value, updated_at) VALUES ($1, $2, $3)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
            `, [key, String(widthPx), now()])
          },
        )
      },
    },
    auditLog: {
      add(entry) {
        return repositoryCall(context, 'audit_log', 'add', 'write_failed', async (client) => {
          const auditId = id('audit')
          const timestamp = now()
          await client.query(`
            INSERT INTO ownware.audit_log (
              id, action, entity_type, entity_id, detail, ip_address, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            auditId,
            entry.action,
            entry.entityType,
            entry.entityId ?? null,
            entry.detail ?? null,
            entry.ipAddress ?? null,
            timestamp,
          ])
          const result: AuditLogEntry = {
            id: auditId,
            action: entry.action,
            entityType: entry.entityType,
            entityId: entry.entityId ?? null,
            detail: entry.detail ?? null,
            ipAddress: entry.ipAddress ?? null,
            createdAt: timestamp,
          }
          return result
        })
      },
    },
    diagnostics: {
      stats() {
        return repositoryCall(context, 'gateway_diagnostics', 'stats', 'read_failed', async (client) => {
          const result = await client.query<{
            readonly database_size_bytes: string
            readonly thread_count: string
            readonly message_count: string
            readonly usage_record_count: string
          }>(`
            SELECT
              pg_database_size(current_database())::text AS database_size_bytes,
              (SELECT count(*)::text FROM ownware.threads) AS thread_count,
              (SELECT count(*)::text FROM ownware.messages) AS message_count,
              (SELECT count(*)::text FROM ownware.usage_records) AS usage_record_count
          `)
          const row = result.rows[0]
          return {
            databaseSizeBytes: safeInteger(row?.database_size_bytes ?? '0'),
            threadCount: safeInteger(row?.thread_count ?? '0'),
            messageCount: safeInteger(row?.message_count ?? '0'),
            usageRecordCount: safeInteger(row?.usage_record_count ?? '0'),
          }
        })
      },
      exportAll() {
        return repositoryCall(context, 'gateway_diagnostics', 'export_all', 'read_failed', exportAll)
      },
      threadCount() {
        return repositoryCall(context, 'gateway_diagnostics', 'thread_count', 'read_failed', async (client) => {
          const result = await client.query<{ readonly count: string }>(
            'SELECT count(*)::text AS count FROM ownware.threads',
          )
          return safeInteger(result.rows[0]?.count ?? '0')
        })
      },
    },
  }
}
