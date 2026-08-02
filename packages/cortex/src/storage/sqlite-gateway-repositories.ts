import {
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import { statSync } from 'node:fs'
import type { GatewayRepositories } from './gateway-repositories.js'
import type { SqliteRootRepositoryContext } from './sqlite-adapter.js'

function sqliteCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? '')
    : ''
}

async function repositoryCall<T>(
  context: SqliteRootRepositoryContext,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: () => T,
): Promise<Awaited<T>> {
  try {
    context.assertActive()
    return await fn()
  } catch (error) {
    if (
      error instanceof StorageLifecycleError ||
      error instanceof StorageRepositoryError ||
      error instanceof TypeError ||
      error instanceof RangeError
    ) {
      throw error
    }
    const driverCode = sqliteCode(error)
    if (!driverCode.startsWith('SQLITE_')) throw error
    throw new StorageRepositoryError(
      code,
      'sqlite',
      domain,
      operation,
      driverCode === 'SQLITE_BUSY' || driverCode === 'SQLITE_LOCKED',
    )
  }
}

/**
 * Async adapter port for the durable authorities historically exposed as
 * synchronous methods on CortexDatabase.
 */
export function createSqliteGatewayRepositories(
  context: SqliteRootRepositoryContext,
): GatewayRepositories {
  const db = context.legacyDatabase
  const read = <T>(
    domain: StorageRepositoryDomain,
    operation: string,
    fn: () => T,
  ): Promise<Awaited<T>> => repositoryCall(context, domain, operation, 'read_failed', fn)
  const write = <T>(
    domain: StorageRepositoryDomain,
    operation: string,
    fn: () => T,
  ): Promise<Awaited<T>> => repositoryCall(context, domain, operation, 'write_failed', fn)

  return {
    workspaces: {
      create: (path, name) => write('workspaces', 'create', () => db.createWorkspace(path, name)),
      get: (id) => read('workspaces', 'get', () => db.getWorkspace(id)),
      getByPath: (path) => read('workspaces', 'get_by_path', () => db.getWorkspaceByPath(path)),
      list: (status, options) => read('workspaces', 'list', () => db.listWorkspaces(status, options)),
      detail: (id) => read('workspaces', 'detail', () => db.getWorkspaceDetail(id)),
      update: (id, updates) => write('workspaces', 'update', () => db.updateWorkspace(id, updates)),
      delete: (id) => write('workspaces', 'delete', () => db.deleteWorkspace(id)),
      touch: (id) => write('workspaces', 'touch', () => db.touchWorkspace(id)),
      listThreads: (workspaceId) => read(
        'workspaces',
        'list_threads',
        () => db.listThreadsByWorkspace(workspaceId),
      ),
    },
    mcpServers: {
      create: (input) => write('mcp_servers', 'create', () => db.createMCPServer(input)),
      get: (id) => read('mcp_servers', 'get', () => db.getMCPServer(id)),
      list: (options) => read('mcp_servers', 'list', () => db.listMCPServers(options)),
      update: (id, updates) => write(
        'mcp_servers',
        'update',
        () => db.updateMCPServer(id, updates),
      ),
      delete: (id) => write('mcp_servers', 'delete', () => db.deleteMCPServer(id)),
      assignToProfile: (serverId, profileId) => write(
        'mcp_servers',
        'assign_to_profile',
        () => db.assignServerToProfile(serverId, profileId),
      ),
      removeFromProfile: (serverId, profileId) => write(
        'mcp_servers',
        'remove_from_profile',
        () => db.removeServerFromProfile(serverId, profileId),
      ),
      listForProfile: (profileId) => read(
        'mcp_servers',
        'list_for_profile',
        () => db.getServersForProfile(profileId),
      ),
    },
    localProfile: {
      create: (displayName, avatarUrl) => write(
        'local_profile',
        'create',
        () => db.createLocalProfile(displayName, avatarUrl),
      ),
      get: () => read('local_profile', 'get', () => db.getLocalProfile()),
      update: (id, updates) => write(
        'local_profile',
        'update',
        () => db.updateLocalProfile(id, updates),
      ),
    },
    settings: {
      get: (key) => read('user_settings', 'get', () => db.getSetting(key)),
      set: (key, value) => write('user_settings', 'set', () => db.setSetting(key, value)),
      list: () => read('user_settings', 'list', () => db.getAllSettings()),
      delete: (key) => write('user_settings', 'delete', () => db.deleteSetting(key)),
    },
    profileMetadata: {
      get: (profileId) => read(
        'profile_metadata',
        'get',
        () => db.getProfileMetadata(profileId),
      ),
      set: (profileId, updates) => write(
        'profile_metadata',
        'set',
        () => db.setProfileMetadata(profileId, updates),
      ),
      list: () => read('profile_metadata', 'list', () => db.listProfileMetadata()),
    },
    appState: {
      get: (key) => read('app_state', 'get', () => db.getAppState(key)),
      set: (key, value) => write('app_state', 'set', () => db.setAppState(key, value)),
      getWorkspaceSideTrackWidth: (workspaceId) => read(
        'app_state',
        'get_workspace_side_track_width',
        () => db.getWorkspaceSideTrackWidth(workspaceId),
      ),
      setWorkspaceSideTrackWidth: (workspaceId, widthPx) => write(
        'app_state',
        'set_workspace_side_track_width',
        () => db.setWorkspaceSideTrackWidth(workspaceId, widthPx),
      ),
    },
    auditLog: {
      add: (entry) => write('audit_log', 'add', () => db.addAuditLog(entry)),
    },
    diagnostics: {
      stats: () => read('gateway_diagnostics', 'stats', () => {
        const stats = db.getStorageStats()
        let databaseSizeBytes = 0
        try { databaseSizeBytes = statSync(db.dbPath).size } catch { /* unavailable is zero */ }
        return { databaseSizeBytes, ...stats }
      }),
      exportAll: () => read('gateway_diagnostics', 'export_all', () => db.exportAllData()),
      threadCount: () => read('gateway_diagnostics', 'thread_count', () => db.threadCount),
    },
  }
}
