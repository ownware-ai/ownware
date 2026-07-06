/**
 * Connector Module
 *
 * MCP server discovery, credential management, and lifecycle.
 */

// Types
export type {
  MCPRegistryEntry,
  MCPEnvVar,
  MCPCategory,
  MCPCredentials,
  ProfileMCPServer,
  EnvVarStatus,
} from './types.js'

// Registry
export {
  fetchMCPRegistry,
  getRegistryEntry,
  clearRegistryCache,
} from './mcp/registry.js'

// Credentials — legacy MCP-scoped facade
export {
  MCPCredentialStore,
  credentialStore,
} from './mcp/credentials.js'

// Credentials — generalized vault (canonical)
export {
  CredentialVault,
  credentialVault,
} from './credentials/vault.js'
export type { CredentialBundle } from './credentials/vault.js'

// Unified connector types + Zod schemas
export {
  ConnectorSchema,
  ConnectorListSchema,
  ConnectorSourceSchema,
  ConnectorStatusSchema,
  ConnectorCategorySchema,
  ConnectorAvailableModeSchema,
  ConnectorTokenInputSchema,
  ConnectorOAuthPresetSchema,
  AuthModeSchema,
  ConnectorNotReadyErrorSchema,
  ConnectorsQuerySchema,
} from './schema.js'
export type {
  Connector,
  ConnectorSource,
  ConnectorStatus,
  ConnectorCategory,
  ConnectorAvailableMode,
  ConnectorTokenInput,
  ConnectorOAuthPreset,
  AuthMode,
  ConnectorNotReadyError,
  ConnectorsQuery,
} from './schema.js'

// Agent-tool result schemas. The `ConnectorSearchResult*` and
// `ConnectorSourceSuggestion*` exports retired 2026-05-16 (slice G)
// alongside the search action.
export {
  ConnectorCardSchema,
  ConnectorAttachedItemSchema,
  ConnectorAttachedListResultSchema,
  ConnectorStatusResultSchema,
  ConnectorAgentToolResultSchema,
  connectorToCard,
} from './agent-tool-results.js'
export type {
  ConnectorCard,
  ConnectorAttachedItem,
  ConnectorAttachedListResult,
  ConnectorStatusResult,
  ConnectorAgentToolResult,
} from './agent-tool-results.js'

// Agent tool — Phase 5-B (2026-05-06)
export { createConnectorsTool } from './agent-tool.js'
export type { ConnectorsToolDeps } from './agent-tool.js'

// Agent tool provider — Phase 5-B.2 (2026-05-06) — wires the
// connectors() tool into a profile session via the assembler's
// toolProviders option.
export { ConnectorsToolProvider } from './providers/connectors-tool-provider.js'
export type { ConnectorsToolProviderOptions } from './providers/connectors-tool-provider.js'

// MCP registry source provider — Phase 6-C.1 (2026-05-07) — opt-in
// catalog source backed by registry.modelcontextprotocol.io. Not
// auto-registered; the gateway adds it to the ConnectorRegistry only
// when the user enables the source via Settings → Advanced.
export {
  MCPRegistrySourceProvider,
  registryEntryToConnector,
} from './providers/mcp-registry-source-provider.js'
export type { MCPRegistrySourceProviderOptions } from './providers/mcp-registry-source-provider.js'

// Status bus — source-agnostic fan-out of status transitions
export {
  ConnectorStatusBus,
  ConnectorStatusEventSchema,
  createConnectorStatusBus,
} from './status-bus.js'
export type {
  ConnectorStatusEvent,
  ConnectorStatusListener,
  Unsubscribe as ConnectorStatusUnsubscribe,
  EmitInput as ConnectorStatusEmitInput,
} from './status-bus.js'

// Connector registry + stub-tool factory
export { ConnectorRegistry } from './registry.js'
export type { ConnectorSourceProvider, ConnectorRegistryOptions } from './registry.js'
export { createStubTool } from './stub-tool.js'
export type { StubToolSpec } from './stub-tool.js'

// Phase 2a — connections store (vendor-agnostic OAuth state)
export { ConnectorConnectionsStore } from './connections/store.js'
export type {
  ConnectionRow,
  ConnectionStatus,
  UpsertPendingInput,
  MarkReadyInput,
  MarkFailedInput,
} from './connections/store.js'

// Composio live-catalogue cache (replaces the dropped composio_catalog
// SQLite table). Shared by the source provider + tool adapter.
export { ComposioCatalogCache } from './composio/catalog-cache.js'
export type { ComposioCatalogCacheOptions } from './composio/catalog-cache.js'

// Phase 2a — completion framework
export { ConnectionPoller, DEFAULT_POLLER_CONFIG } from './completion/poller.js'
export type { PollerConfig } from './completion/poller.js'
export { ConnectionCompletionManager } from './completion/manager.js'
export type { ConnectionCompletionManagerOptions } from './completion/manager.js'
export { ConnectionCheckResultSchema } from './completion/types.js'
export type {
  ConnectionCheckResult,
  ConnectionCompletionListener,
} from './completion/types.js'

// Phase 2a — provider framework (generalizes M1.5 webSearchService injection)
export type {
  ConnectorToolProvider,
  ConnectorToolProviderContext,
  ConnectorToolProviderResult,
} from './providers/types.js'
export { WebSearchToolProvider } from './providers/web-search-provider.js'

// Phase 2a — typed error hierarchy
export {
  ConnectorError,
  ConnectorAuthExpiredError,
  ConnectorRateLimitedError,
  ConnectorNetworkError,
  ConnectorValidationError,
  ConnectorVendorError,
  ConnectorNotConfiguredError,
  ConnectorErrorMetadataSchema,
  ConnectorErrorCodeSchema,
  isConnectorError,
} from './errors.js'
export type {
  ConnectorErrorMetadata,
  ConnectorErrorCode,
  ConnectorErrorContext,
} from './errors.js'

// Phase 2a — Composio source scaffold (graceful-degradation factory)
export { createComposioSource } from './composio/source.js'
export type { ComposioSourceOptions } from './composio/source.js'

// Phase 2b.1 — Composio HTTP client + completion listener
export {
  ComposioClient,
  ComposioToolkitSummarySchema,
  ComposioToolkitDetailSchema,
  ComposioAuthConfigSchema,
  ComposioAuthConfigListSchema,
  ComposioConnectionLinkSchema,
  ComposioConnectedAccountSchema,
  ComposioConnectedAccountListSchema,
  ComposioConnectedAccountStatusSchema,
  ComposioToolSchema,
  ComposioToolListSchema,
  ComposioExecuteResponseSchema,
  ComposioToolkitListSchema,
  ComposioAuthSchemeSchema,
} from './composio/client.js'
export type {
  ComposioClientOptions,
  ComposioToolkitSummary,
  ComposioToolkitDetail,
  ComposioAuthConfig,
  ComposioConnectionLink,
  ComposioConnectedAccount,
  ComposioConnectedAccountStatus,
  ComposioTool,
  ComposioExecuteResponse,
  CreateConnectionLinkInput,
  ListToolkitsParams,
  ListAuthConfigsParams,
  ListConnectedAccountsParams,
  ListToolsParams,
  ExecuteToolInput,
} from './composio/client.js'
export { ComposioCompletionListener } from './composio/listener.js'
export type { ComposioCompletionListenerOptions } from './composio/listener.js'

// F4.c-1 (2026-05-16) — periodic vendor-side reconciliation for
// Composio. Flips locally-ready connections to `auth_error` when the
// vendor revokes/expires them; updates `last_verified_at` on each
// successful confirmation.
export {
  ComposioReconciler,
  DEFAULT_RECONCILE_INTERVAL_MS as DEFAULT_COMPOSIO_RECONCILE_INTERVAL_MS,
  DEFAULT_STALE_TOLERANCE_MS as DEFAULT_COMPOSIO_STALE_TOLERANCE_MS,
} from './composio/reconciler.js'
export type {
  ComposioReconcilerOptions,
  ReconcileTickResult as ComposioReconcileTickResult,
} from './composio/reconciler.js'

// Composio tool adapter + featured
export {
  ComposioToolProvider,
  COMPOSIO_RESULT_MAX_BYTES,
  buildToolName as buildComposioToolName,
  mapExecuteErrorToResult as mapComposioExecuteErrorToResult,
  truncateToBytes as truncateComposioResultToBytes,
} from './composio/tool-adapter.js'
export type { ComposioToolProviderOptions } from './composio/tool-adapter.js'
export {
  FEATURED_COMPOSIO_TOOLKITS,
  getFeaturedComposioToolkits,
  getFeaturedComposioToolkit,
  featuredComposioSlugSet,
} from './composio/featured.js'
export type {
  FeaturedComposioToolkit,
  ComposioFeaturedCategory,
} from './composio/featured.js'

// Web-search pluggable connector (M1.5+)
export {
  WEB_SEARCH_PROVIDERS,
  DEFAULT_PROVIDER_ID as WEB_SEARCH_DEFAULT_PROVIDER_ID,
  PAID_PROVIDER_ORDER as WEB_SEARCH_PAID_PROVIDER_ORDER,
  WEB_SEARCH_VAULT_PREFIX,
  vaultIdFor as webSearchVaultIdFor,
  getWebSearchProvider,
  WebSearchProviderSchema,
  WebSearchAuthSchema,
} from './web-search/providers.js'
export type { WebSearchProvider, WebSearchAuth } from './web-search/providers.js'
export { resolveWebSearchProvider } from './web-search/resolver.js'
export type {
  WebSearchResolveInput,
  WebSearchResolveResult,
  WebSearchResolveSource,
  WebSearchStatus,
} from './web-search/resolver.js'
export {
  WebSearchService,
  WEB_SEARCH_SETTING_KEY,
  __resetWebSearchStartupLogForTests,
} from './web-search/service.js'
export type {
  WebSearchServiceOptions,
  WebSearchSettingsStore,
} from './web-search/service.js'
export { buildWebSearchConnector } from './web-search/connector.js'
export {
  ConnectorProviderSummarySchema,
  ConnectorProviderAuthSchema,
} from './schema.js'
export type { ConnectorProviderSummary } from './schema.js'

// Featured (curated)
export {
  FEATURED_SERVERS,
  getFeaturedServers,
  getFeaturedServer,
  getFeaturedCategories,
} from './mcp/featured.js'
export type { FeaturedMCPServer, FeaturedCategory } from './mcp/featured.js'

// OAuth presets + validators (Cortex owns provider-specific OAuth
// config — Loom only exposes generic PKCE primitives)
export {
  OAUTH_PRESETS,
  getOAuthPreset,
  isPresetConfigured,
} from './mcp/oauth-presets.js'
export {
  validateClientId,
} from './mcp/oauth-validators.js'
export type {
  ValidationResult,
  ValidationErrorCode,
} from './mcp/oauth-validators.js'

// Phase 2b.2b — alias resolution + preferences
export {
  CONNECTOR_ALIASES,
  getAliasesFor,
  getCanonicalIdsFor,
  isAliasLogicalKey,
  listAliasLogicalKeys,
} from './aliases.js'
export {
  resolveSourceForLogicalKey,
  SOURCE_DETERMINISTIC_ORDER,
} from './source-resolver.js'
export {
  SourcePreferences,
  sourcePreferenceKey,
} from './source-preferences.js'
export type { SourcePreferencesStore } from './source-preferences.js'
