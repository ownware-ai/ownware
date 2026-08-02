import type {
  AppState,
  AuditLogEntry,
  LocalProfile,
  MCPServerRecord,
  PaginatedResult,
  ProfileMetadata,
  Thread,
  ThreadMessage,
  UserSettings,
  Workspace,
  WorkspaceDetail,
} from '../gateway/types.js'

export interface WorkspaceUpdate {
  readonly name?: string
  readonly pinned?: boolean
  readonly status?: string
  readonly lastProfileId?: string
  readonly activeProducts?: readonly string[]
}

export interface WorkspaceRepository {
  create(path: string, name?: string): Promise<Workspace>
  get(id: string): Promise<Workspace | undefined>
  getByPath(path: string): Promise<Workspace | undefined>
  list(
    status?: 'active' | 'archived',
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<PaginatedResult<Workspace>>
  detail(id: string): Promise<WorkspaceDetail | undefined>
  update(id: string, updates: WorkspaceUpdate): Promise<Workspace | undefined>
  delete(id: string): Promise<boolean>
  touch(id: string): Promise<void>
  listThreads(workspaceId: string): Promise<Thread[]>
}

export interface MCPServerCreateInput {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly url?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly headers?: Record<string, string>
  readonly registryId?: string
}

export interface MCPServerUpdate {
  readonly name?: string
  readonly status?: string
  readonly toolCount?: number
  readonly error?: string | null
  readonly toolsJson?: string | null
}

export interface MCPServerRepository {
  create(input: MCPServerCreateInput): Promise<MCPServerRecord>
  get(id: string): Promise<MCPServerRecord | undefined>
  list(options?: {
    readonly limit?: number
    readonly offset?: number
  }): Promise<PaginatedResult<MCPServerRecord>>
  update(id: string, updates: MCPServerUpdate): Promise<MCPServerRecord | undefined>
  delete(id: string): Promise<boolean>
  assignToProfile(serverId: string, profileId: string): Promise<void>
  removeFromProfile(serverId: string, profileId: string): Promise<boolean>
  listForProfile(profileId: string): Promise<MCPServerRecord[]>
}

export interface LocalProfileRepository {
  create(displayName: string, avatarUrl?: string): Promise<LocalProfile>
  get(): Promise<LocalProfile | undefined>
  update(
    id: string,
    updates: { readonly displayName?: string; readonly avatarUrl?: string | null },
  ): Promise<LocalProfile | undefined>
}

export interface UserSettingsRepository {
  get(key: string): Promise<UserSettings | undefined>
  set(key: string, value: string): Promise<UserSettings>
  list(): Promise<UserSettings[]>
  delete(key: string): Promise<boolean>
}

export interface ProfileMetadataRepository {
  get(profileId: string): Promise<ProfileMetadata | undefined>
  set(
    profileId: string,
    updates: {
      readonly icon?: string | null
      readonly color?: string | null
      readonly category?: string | null
    },
  ): Promise<ProfileMetadata>
  list(): Promise<ProfileMetadata[]>
}

export interface AppStateRepository {
  get(key: string): Promise<AppState | undefined>
  set(key: string, value: string): Promise<AppState>
  getWorkspaceSideTrackWidth(workspaceId: string): Promise<number | null>
  setWorkspaceSideTrackWidth(workspaceId: string, widthPx: number): Promise<void>
}

export interface AuditLogRepository {
  add(entry: {
    readonly action: string
    readonly entityType: string
    readonly entityId?: string
    readonly detail?: string
    readonly ipAddress?: string
  }): Promise<AuditLogEntry>
}

export interface GatewayStorageStats {
  readonly databaseSizeBytes: number
  readonly threadCount: number
  readonly messageCount: number
  readonly usageRecordCount: number
}

export interface GatewayDataExport {
  readonly threads: Thread[]
  readonly messages: Record<string, ThreadMessage[]>
  readonly workspaces: Workspace[]
  readonly settings: UserSettings[]
  readonly usage: {
    readonly totalTokens: number
    readonly totalCost: number
    readonly recordCount: number
  }
}

export interface GatewayDiagnosticsRepository {
  stats(): Promise<GatewayStorageStats>
  exportAll(): Promise<GatewayDataExport>
  threadCount(): Promise<number>
}

/** Durable gateway authorities that historically lived on CortexDatabase itself. */
export interface GatewayRepositories {
  readonly workspaces: WorkspaceRepository
  readonly mcpServers: MCPServerRepository
  readonly localProfile: LocalProfileRepository
  readonly settings: UserSettingsRepository
  readonly profileMetadata: ProfileMetadataRepository
  readonly appState: AppStateRepository
  readonly auditLog: AuditLogRepository
  readonly diagnostics: GatewayDiagnosticsRepository
}
