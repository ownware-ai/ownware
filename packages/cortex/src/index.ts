/**
 * @ownware/cortex — Agent Operating System Kernel
 *
 * Profiles, process management, and the bridge between
 * agent definitions and the Loom runtime.
 *
 * @example Load and run a profile
 * ```ts
 * import { loadProfile, assembleAgent } from '@ownware/cortex'
 * import { Session } from '@ownware/loom'
 *
 * const profile = await loadProfile('./profiles/my-agent')
 * const { config, tools, provider } = await assembleAgent(profile)
 *
 * const session = new Session({ config, provider, tools })
 * for await (const event of session.submitMessage('Hello!')) {
 *   if (event.type === 'text.delta') process.stdout.write(event.text)
 * }
 * ```
 *
 * @packageDocumentation
 */

// Profile schema
export {
  ProfileSchema,
  ProfilePanePolicySchema,
  ProfilePanePresetSchema,
} from './profile/schema.js'
export type { ProfileConfig } from './profile/schema.js'
export type {
  HookConfig,
  MCPServerConfig,
  CustomToolRef,
  ToolsConfig,
  MemoryConfig,
  SkillsConfig,
  ContextConfig,
  WorkspaceConfig,
  SandboxConfig,
  SecurityConfig,
  ZonesConfig,
  ZoneOverrideConfig,
  ExecutionConfig,
  ProfilePanePolicy,
  ProfilePanePreset,
  SubagentSpec,
  ProfileCompactionConfig,
  CheckpointConfig,
  HooksConfig,
} from './profile/schema.js'

// Profile loader
export { loadProfile } from './profile/loader.js'
export type { LoadedProfile } from './profile/loader.js'

// Profile registry
export { ProfileRegistry } from './profile/registry.js'

// Profile assembler
export { assembleAgent } from './profile/assembler.js'
export type { AssembledAgent, AssembleOptions } from './profile/assembler.js'

// Profile hook binding — declarative agent.json hooks → Loom HookRuntime
export { buildHookBinding, hookBindingOptionsFromEnv, HookConfigError } from './profile/hooks.js'
export type {
  HookBinding,
  HookBindingOptions,
  HookApprovalRequest,
  HookApprovalDecision,
} from './profile/hooks.js'

// Tool policy
export { applyToolPolicy, matchesGlob } from './profile/tool-policy.js'

// SOUL validation — deterministic post-write gate for generated SOULs
export { validateSoul } from './profile/soul-validate.js'
export type { SoulToolsConfig, SoulValidationInput, SoulValidationResult } from './profile/soul-validate.js'

// Understanding digest — the canonical `UnderstandingSlice` contract a
// source-reading sub-agent produces (one slice per writer), merged additively
// by the understanding-store. (The old typed `ProfileSpec` envelope was
// superseded by this slice approach and removed 2026-06-24 — one canonical home.)
export { UsageEntrySchema, SourceChipSchema, UnderstandingSliceSchema, mergeSlices } from './profile/understanding.js'
export type { UsageEntry, SourceChip, UnderstandingSlice } from './profile/understanding.js'
// Understanding store — the additive, race-free on-disk profile.json (per-writer slices)
export { writeUnderstandingSlice, readUnderstanding, understandingSlicesDir } from './profile/understanding-store.js'

// (The product catalog exports were removed with the legacy desktop shell.)

// Persistent permission store
export { PermissionStore, permissionStore } from './permissions/index.js'
export type { SavedPermissionRule, ProfilePermissions } from './permissions/index.js'

// Custom tool loader
export { loadCustomTools } from './profile/custom-tools.js'

// Environment variable resolution
export { resolveEnvVars, resolveEnvString } from './profile/env.js'

// Timeout parsing
export { parseTimeout } from './profile/timeout.js'

// Context helpers
export {
  getGitContext,
  getOsContext,
  getDateContext,
  getProjectContext,
} from './profile/context.js'

// Gateway
export { OwnwareGateway } from './gateway/server.js'
export type { GatewayOptions } from './gateway/server.js'
export { GatewayState } from './gateway/state.js'
export { Router } from './gateway/router.js'
export type {
  // Core entities
  Thread,
  ThreadMessage,
  AttachmentMeta,
  ToolCallRecord,
  SubAgentRecord,
  PermissionRecord,
  Workspace,
  WorkspaceDetail,
  WorkspaceProfileEntry,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  // MCP
  MCPServerRecord,
  CreateMCPServerRequest,
  AssignMCPServerRequest,
  MCPServerInfo,
  MCPMarketplaceEntry,
  MCPMarketplaceEnvVar,
  ProfileMCPStatus,
  SaveCredentialsRequest,
  AddMCPToProfileRequest,
  // Profiles
  ProfileSummary,
  ProfileDetail,
  ProfileMetadata,
  CreateProfileRequest,
  UpdateProfileRequest,
  GenerateProfileRequest,
  ProfileFileRequest,
  // Run
  RunRequest,
  ResumeRequest,
  FileAttachmentInput,
  // Catalog
  ToolInfo,
  ModelInfo,
  // Dashboard
  DashboardStats,
  DashboardProfileEntry,
  DashboardWorkspaceEntry,
  DashboardRange,
  DashboardKPICard,
  DashboardKPIs,
  ProfileBreakdownRow,
  RecentActivityRow,
  KpiCard,
  KpiResponse,
  UsageBucket,
  UsageChartResponse,
  UsageChartFullResponse,
  ProfileBreakdownEntry,
  RecentActivityEntry,
  // Activity
  ActivityRecord,
  ActivityEntry,
  ActivityFeedResponse,
  // Storage / data
  StorageStats,
  StorageStatsResponse,
  ClearCacheResponse,
  DataExportResponse,
  // Settings & providers
  SettingsResponse,
  ProviderInfo,
  UserSettings,
  // Local profile / app
  LocalProfile,
  AppState,
  AppVersion,
  AuditLogEntry,
  // Search
  SearchResult,
  // File tree
  FileTreeNode,
  // Connectivity
  ConnectivityStatus,
  // Pagination
  PaginatedResult,
  // Errors
  ApiError,
} from './gateway/types.js'

// Validation schemas (Zod)
export {
  CreateThreadSchema,
  UpdateThreadSchema,
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  CreateProfileSchema,
  UpdateProfileSchema,
  GenerateProfileSchema,
  ProfileFileSchema,
  CreateMCPServerSchema,
  SaveCredentialsSchema,
  AddMCPToProfileSchema,
  CreateLocalProfileSchema,
  UpdateLocalProfileSchema,
  SetSettingSchema,
  SetProviderKeySchema,
  SetProfileMetadataSchema,
  SetAppStateSchema,
  SaveSettingsSchema,
  SaveProviderSchema,
  ValidateProviderSchema,
} from './gateway/validation/schemas.js'

// Gateway event contract — re-exports Loom core events + gateway wrappers
export type {
  // Loom core events (re-exported from @ownware/loom via events.ts)
  LoomEvent,
  StopReason,
  TurnUsage,
  SessionStartEvent,
  SessionEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  TextDeltaEvent,
  TextCompleteEvent,
  ThinkingDeltaEvent,
  ThinkingCompleteEvent,
  ToolCallStartEvent,
  ToolCallArgsDeltaEvent,
  ToolCallProgressEvent,
  ToolCallEndEvent,
  CompactionStartEvent,
  CompactionEndEvent,
  ContextPressureEvent,
  CacheStatusEvent,
  RecoveryEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  AgentSpawnEvent,
  AgentCompleteEvent,
  CheckpointSavedEvent,
  SecurityBlockEvent,
  SecurityRedactEvent,
  AuditEvent,
  ErrorEvent,
  // Gateway wrappers
  StreamStartEvent,
  StreamReplayCompleteEvent,
  StreamShutdownEvent,
  StreamDoneEvent,
  // Unified gateway event
  GatewayEvent,
} from './gateway/events.js'

// Connector — MCP registry + credentials
export {
  fetchMCPRegistry,
  getRegistryEntry,
  clearRegistryCache,
  MCPCredentialStore,
  credentialStore,
} from './connector/index.js'
export type {
  MCPRegistryEntry,
  MCPEnvVar,
  MCPCategory,
  MCPCredentials,
  ProfileMCPServer,
  EnvVarStatus,
} from './connector/types.js'

// (The desktop `open_pane` tool exports were removed with the legacy
// desktop shell.)
