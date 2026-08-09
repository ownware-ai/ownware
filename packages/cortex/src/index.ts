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

// Runtime selection — execution loop, model access route, capability evidence,
// and immutable per-thread binding are separate concepts by construction.
export {
  RuntimeSelectionSchema,
  CapabilityProvenanceSchema,
  CapabilityAssessmentSchema,
  RuntimePlanSchema,
  ThreadRuntimeBindingSchema,
  RuntimeBindingConflictError,
  resolveRuntimeSelection,
  createRuntimePlan,
  capabilityFreshness,
  bindThreadRuntime,
} from './runtime/selection.js'
export type {
  RuntimeSelection,
  CapabilityAssessment,
  RuntimePlan,
  CapabilityFreshness,
  ThreadRuntimeBinding,
} from './runtime/selection.js'

// Experimental direct Responses access for Ownware's native loop. The
// constructor accepts only the explicit direct selection and composes the
// existing OAuth credential boundary with the engine's Responses adapter.
export {
  DirectOpenAIProviderConfigurationError,
  createOpenAIDirectProvider,
} from './runtime/openai-direct/provider.js'
export type {
  CreateOpenAIDirectProviderOptions,
  DirectOpenAIAccountTransport,
  DirectOpenAIProviderConfigurationErrorCode,
  DirectOpenAITransportConfig,
} from './runtime/openai-direct/provider.js'

// Runtime execution port — native drivers translate behind this boundary;
// gateway lifecycle code consumes only canonical events and control results.
export {
  ManagedExecutionRuntime,
  RuntimeContractError,
  RuntimeExecutionError,
  createOwnwareRuntimeDriver,
} from './runtime/port.js'
export type {
  ExecutionRuntime,
  RuntimeDriver,
  RuntimeDriverEvent,
  RuntimeEventEnvelope,
  RuntimeCompletion,
  RuntimeStatus,
  RuntimePhase,
  RuntimeOutcome,
  RuntimeConsequence,
  RuntimeStartRequest,
  RuntimePermissionDecision,
  RuntimePermissionResult,
  RuntimeCancelReason,
  RuntimeCancelResult,
  RuntimeCloseResult,
  OwnwareRuntimeDriverOptions,
} from './runtime/port.js'

// Official Codex app-server process/protocol boundary. The client owns only
// version negotiation, isolated configuration, JSONL correlation, and bounded
// process lifecycle; runtime semantics stay behind RuntimeDriver.
export {
  CodexAppServerClient,
  CodexAppServerError,
  CodexProcessError,
  SUPPORTED_CODEX_VERSION_RANGE,
  parseCodexVersion,
  probeCodexVersion,
} from './runtime/codex/app-server-client.js'
export type {
  CodexAppServerStartOptions,
  CodexChildProcess,
  CodexDiagnostics,
  CodexInbound,
  CodexNotification,
  CodexServerRequest,
  CodexSpawnOptions,
  CodexSpawnProcess,
  ParsedCodexVersion,
} from './runtime/codex/app-server-client.js'

// Redacted account/login/model/quota projection over Codex-owned credentials.
export {
  CodexAccountService,
  CodexAccountProtocolError,
  CodexAccountUnavailableError,
} from './runtime/codex/account.js'

// Owner-facing, redacted gateway control plane for the official Codex route.
// Codex owns token persistence; these snapshots never expose account identity
// or reusable credentials.
export {
  CodexControlPlaneInputError,
  ManagedCodexRuntimeControlPlane,
} from './runtime/codex/control-plane.js'
export type {
  CodexControlPlaneClient,
  CodexControlPlaneInputErrorCode,
  CodexRuntimeControlPlane,
  CodexRuntimeControlPlaneOptions,
  CodexRuntimeStatus,
} from './runtime/codex/control-plane.js'
export {
  CodexProfileMappingError,
  CodexScopedToolAuthority,
  prepareCodexProfileMapping,
} from './runtime/codex/profile-mapping.js'
export type {
  BindCodexScopedToolAuthorityInput,
  CodexApprovedSource,
  CodexLocalImageAttachment,
  CodexUnknownAttachment,
  CodexProfileAttachment,
  CodexProfileMappingInput,
  CodexProfileCompatibilityStatus,
  CodexProfileCompatibilityEntry,
  CodexProfileLimitationSeverity,
  CodexProfileLimitation,
  CodexProfileCompatibilityReport,
  CodexProfileCompatibilityDecision,
  CodexTurnUserInput,
  CodexProfileWireMapping,
  CodexPreparedProfileMapping,
  CodexProfileMappingErrorCode,
} from './runtime/codex/profile-mapping.js'
export {
  CodexOfficialRunPlanError,
  composeCodexOfficialRunPlan,
} from './runtime/codex/official-run-plan.js'
export type {
  CodexOfficialRunPlan,
  CodexOfficialRunPlanErrorCode,
} from './runtime/codex/official-run-plan.js'
export type {
  CodexAccountRpc,
  CodexAccountState,
  CodexLoginState,
  CodexLoginPresentation,
  CodexModel,
  CodexModelCatalog,
  CodexQuotaState,
  CodexRateLimitBucket,
  CodexRateLimitWindow,
  CodexAccountNotification,
  CodexAccountNotificationResult,
  CodexAccountProtocolErrorCode,
  CodexAccountUnavailableErrorCode,
} from './runtime/codex/account.js'

// Official Codex run isolation, scoped Ownware tool bridge, and native
// approval translation. These are kernel security boundaries; the engine remains
// unaware of the external runtime.
export {
  CodexMcpBridgeError,
  CodexMcpToolHub,
} from './runtime/codex/mcp-tool-bridge.js'
export type {
  CodexEffectObservation,
  CodexMcpDeliveryObservation,
  CodexMcpDeliveryResult,
  CodexMcpBridgeErrorCode,
  CodexMcpInvocationReceipt,
  CodexMcpRunHandle,
  CodexMcpRunRegistration,
  CodexMcpToolHubOptions,
} from './runtime/codex/mcp-tool-bridge.js'
export {
  CodexRunIsolationError,
  enforceCodexRuntimeIsolation,
  materializeCodexRunHome,
  prepareCodexSandboxPlan,
} from './runtime/codex/run-isolation.js'
export type {
  CodexPreparedSandboxPlan,
  CodexRequestClient,
  CodexRuntimeIsolationInput,
  CodexRuntimeIsolationProof,
  CodexRunIsolationErrorCode,
  CodexSandboxDecision,
  CodexSandboxInput,
  CodexSandboxLimitation,
  CodexSandboxMode,
  CodexSandboxPlan,
  CodexSandboxReport,
  MaterializeCodexRunHomeInput,
  MaterializedCodexRunHome,
} from './runtime/codex/run-isolation.js'
export { CodexNativeApprovalBridge } from './runtime/codex/native-approval-bridge.js'
export type {
  CodexFileChangeContext,
  CodexNativeApprovalBridgeOptions,
  CodexNativeApprovalHandleResult,
  CodexNativeApprovalReview,
} from './runtime/codex/native-approval-bridge.js'
export {
  CodexThreadReferenceError,
  advanceCodexThreadReference,
  assertCodexThreadResume,
  beginCodexThreadTurn,
  completeCodexThreadTurn,
  createCodexThreadReference,
  observeCodexThreadConsequence,
  parseCodexThreadReference,
} from './runtime/codex/official-thread.js'
export {
  CodexThreadReferenceStore,
  CodexThreadReferenceStoreError,
} from './runtime/codex/thread-reference-store.js'
export {
  CodexThreadRecoveryError,
  CodexThreadRecoveryService,
} from './runtime/codex/thread-recovery.js'
export {
  CodexThreadLifecycleError,
  CodexThreadLifecycleService,
} from './runtime/codex/thread-lifecycle.js'
export type {
  CodexThreadReferenceStoreErrorCode,
} from './runtime/codex/thread-reference-store.js'
export type {
  CodexThreadRecoveryClient,
  CodexThreadRecoveryErrorCode,
  CodexThreadRecoveryResult,
  CodexThreadRecoveryServiceOptions,
  CodexThreadRecoveryStatus,
} from './runtime/codex/thread-recovery.js'
export type {
  CodexThreadInspection,
  CodexThreadLifecycleClient,
  CodexThreadLifecycleErrorCode,
  CodexThreadLifecycleResult,
} from './runtime/codex/thread-lifecycle.js'
export {
  CodexOfficialTurnBridge,
  CodexTurnProtocolError,
} from './runtime/codex/official-turn.js'
export {
  CodexOfficialRuntimeDriver,
  CodexOfficialRuntimeDriverError,
} from './runtime/codex/official-runtime-driver.js'
export type {
  CodexOfficialRuntimeClient,
  CodexOfficialRuntimeDriverErrorCode,
  CodexOfficialRuntimeDriverOptions,
} from './runtime/codex/official-runtime-driver.js'
export type {
  CodexOfficialTurnBridgeOptions,
  CodexTranslatedTurnEvent,
  CodexTurnObservation,
  CodexTurnProtocolErrorCode,
} from './runtime/codex/official-turn.js'
export type {
  CodexTerminalTurnReference,
  CodexActiveTurnReference,
  CodexThreadReference,
  CodexThreadReferenceErrorCode,
  CodexThreadReferenceInput,
} from './runtime/codex/official-thread.js'

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
export { StorageConfigurationError } from './storage/config.js'
export type {
  GatewayStorageSelection,
  PostgreSqlConnectionSource,
  PostgreSqlPoolOptions,
  PostgreSqlStorageOptions,
  PostgreSqlTlsOptions,
  SqliteStorageOptions,
  StorageConfigurationErrorCode,
  StoragePlanSummary,
} from './storage/config.js'
export {
  preflightSqliteTransferSource,
  SqliteTransferFindingsError,
  SqliteTransferPreflightError,
} from './storage/sqlite-transfer-preflight.js'
export type {
  SqliteTransferFinding,
  SqliteTransferPreflightErrorCode,
  SqliteTransferSourceOptions,
  SqliteTransferSourceReceipt,
} from './storage/sqlite-transfer-preflight.js'
export {
  preflightPostgreSqlTransferTarget,
  PostgreSqlTransferPreflightError,
} from './storage/postgresql-transfer-preflight.js'
export type {
  PostgreSqlTransferPreflightErrorCode,
  PostgreSqlTransferTargetReceipt,
  PostgreSqlTransferTargetState,
  PostgreSqlTransferRuntimeAuthority,
} from './storage/postgresql-transfer-preflight.js'
export {
  OfflineTransferError,
  transferOfflineSqliteToPostgreSql,
} from './storage/sqlite-to-postgresql-transfer.js'
export type {
  OfflineSqliteToPostgreSqlTransferOptions,
  OfflineSqliteToPostgreSqlTransferReceipt,
  OfflineTransferErrorCode,
  OfflineTransferProgress,
} from './storage/sqlite-to-postgresql-transfer.js'
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
  ModelSubstitution,
  ModelSubstitutionReason,
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
