/**
 * Cortex Gateway — HTTP server that exposes Loom agents to web clients.
 *
 * No Express, no Fastify — Node.js built-in http only.
 */

import { createServer } from 'node:http'
import { createSecureServer } from 'node:http2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server as NetServer } from 'node:net'
import { ensureGatewayCert } from './tls.js'
import { resolve, join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_DATA_DIR_NAME } from '../constants.js'
import { Router, sendError } from './router.js'
import { GatewayState } from './state.js'
import { ProfileRegistry } from '../profile/registry.js'
import { migrateMarketplaceInstalledNames } from '../profile/ownware-bundle.js'
import { generateSessionToken } from './middleware/auth.js'
import { createPrincipalAuthMiddleware } from './auth/principal-middleware.js'
import { DelegatedPrincipalStore, ScopedPrincipalService } from './auth/scoped-principal.js'
import { RunIdempotencyStore } from './idempotency.js'
import { GatewayRunStore } from './run-store.js'
import { createHostGuard } from './middleware/host-guard.js'
import { loadOrCreateGatewayToken, gatewayTokenPath } from './token-store.js'
import { isOllamaReachable, PROVIDER_ENV_HINTS } from '@ownware/loom'
import { createRateLimiter } from './middleware/rate-limit.js'
import type { RateLimiter } from './middleware/rate-limit.js'
import { createAccessLogger } from './middleware/access-log.js'
import type { AccessLogger } from './middleware/access-log.js'
import { healthHandler, appVersionHandler, connectivityHandler } from './handlers/health.js'
import { createCapabilitiesHandler } from './handlers/capabilities.js'
import {
  createActivateCandidateHandler,
  createDeleteCandidateHandler,
  createGetCandidateHandler,
  createGetDeploymentHandler,
  createListCandidatesHandler,
  createPauseProfileHandler,
  createRollbackCandidateHandler,
  createResumeProfileHandler,
  createStageCandidateHandler,
  validateCandidate,
} from './handlers/candidates.js'
import { CandidateStore } from './candidate-store.js'
import { CandidateStager } from '../profile/candidate-stager.js'
import { CandidateRetirer } from '../profile/candidate-retirer.js'
import {
  CandidateActivator,
  CandidateDeploymentManager,
  CandidateProfileResolver,
} from '../profile/candidate-activation.js'
import { createProfileHandlers } from './handlers/profiles.js'
import { createSkillHandlers } from './handlers/profile-skills.js'
import { PendingReconciles } from './pending-reconcile.js'
import { createThreadHandlers } from './handlers/threads.js'
import { TeamModule } from '../team/module.js'
import { createTeamHandlers } from '../team/handlers.js'
import { createRunHandlers } from './handlers/run.js'
import {
  SqliteScheduleStore,
  SqliteApprovalStore,
  ScheduleRunner,
  type ScheduleDeliverySink,
} from '../schedules/index.js'
import { createCredentialHandlers } from './handlers/credentials.js'
import {
  createCredentialAuditHandlers,
  createCredentialStoreHandlers,
} from './handlers/credential-store.js'
import { CredentialAuditLog } from '../credential/audit.js'
import { bootstrapProvidersFromUnifiedStore } from '../credential/bootstrap-providers.js'
import { CredentialInjector } from '../credential/injector.js'
import { GatewayCredentialResolver } from '../credential/resolver.js'
import {
  createCredentialStore,
  runCredentialBootMigrations,
  type CredentialStore,
} from '../credential/store/index.js'
import { TrustGate } from '../credential/trust-gate.js'
import { createToolHandlers } from './handlers/tools.js'
import { createMCPHandlers } from './handlers/mcp.js'
import { createConnectorHandlers } from './handlers/connectors.js'
import { createSourcesStatusHandler } from './handlers/connector-sources-status.js'
import { featuredComposioSlugSet } from '../connector/composio/featured.js'
import { createConnectorEventsHandler } from './handlers/connector-events.js'
import { createGatewayEventsHandler } from './handlers/gateway-events.js'
import { createTaskHandlers } from './handlers/tasks.js'
import { TaskEventBus } from '../tasks/event-bus.js'
import { SqliteTaskStore } from '../tasks/store.js'
import { createScheduleHandlers } from './handlers/schedules.js'
import { createApprovalHandlers } from './handlers/approvals.js'
import { createMemorySystem, type MemorySystem } from '../memory/index.js'
import { createMemoryHandlers } from './handlers/memory.js'
import { TerminalEventBus } from '../terminal/event-bus.js'
import { TerminalSessionRegistry } from '../terminal/session-registry.js'
import { WebSearchService } from '../connector/web-search/service.js'
import { createConnectorStatusBus } from '../connector/status-bus.js'
import type { ConnectorStatusBus } from '../connector/status-bus.js'
import {
  createCredentialEventBus,
  type CredentialEventBus,
} from './credential-event-bus.js'
import { createCredentialEventsHandler } from './handlers/credential-events.js'
import {
  createWorkspaceEventBus,
  type WorkspaceEventBus,
} from './workspace-event-bus.js'
import { createWorkspaceEventsHandler } from './handlers/workspace-events.js'
import type { ConnectorToolProvider } from '../connector/providers/types.js'
import { ConnectorsToolProvider } from '../connector/providers/connectors-tool-provider.js'
import { ConnectorConnectionsStore } from '../connector/connections/store.js'
import {
  connectionSessionHandle,
  ConnectionSessionVault,
} from '../connector/connections/session-vault.js'
import { ComposioCatalogCache } from '../connector/composio/catalog-cache.js'
import { ComposioSourceProxy } from '../connector/composio/source-proxy.js'
import { ComposioToolProviderProxy } from '../connector/composio/tool-provider-proxy.js'
import { ConnectionCompletionManager } from '../connector/completion/manager.js'
import { createComposioSource } from '../connector/composio/source.js'
import { ComposioClient, isLikelyUserScopedComposioKey } from '../connector/composio/client.js'
import { resolveComposioWorkspace } from '../connector/composio/workspace.js'
import { ComposioCompletionListener } from '../connector/composio/listener.js'
import { ComposioToolProvider } from '../connector/composio/tool-adapter.js'
import { SourcePreferences } from '../connector/source-preferences.js'
import { getAliasesFor } from '../connector/aliases.js'
import { createConnectorAliasHandlers } from './handlers/connector-alias.js'
import { createConnectorConnectHandlers } from './handlers/connector-connect.js'
import { createConnectorDisconnectHandlers } from './handlers/connector-disconnect.js'
import { createConnectorRuntimeSetupHandler } from './handlers/connector-runtime-setup.js'
import { credentialVault, decrypt as decryptCredentialValue } from '../connector/credentials/vault.js'
import { InstallIdentity } from '../identity/install-identity.js'
import { createDebugHandlers } from './handlers/debug.js'
import { createWorkspaceHandlers } from './handlers/workspaces.js'
import { createDashboardHandlers } from './handlers/dashboard.js'
import { createSettingsHandlers } from './handlers/settings.js'
import { createProviderHandlers } from './handlers/providers.js'
import { createTranscribeHandlers } from './handlers/transcribe.js'
import { createSearchHandlers } from './handlers/search.js'
import { createModelCatalogHandler, createCatalogHandler } from './handlers/catalog.js'
import { VARIABLE_NAME_TO_PROVIDER_ID, llmProviderById } from './llm-providers.js'
import { createMCPRegisterHandlers } from './handlers/mcp-register.js'
import { createActivityHandlers } from './handlers/activity.js'
import { createAgentEventHandlers } from './handlers/agent-events.js'
import { createPermissionHandlers } from './handlers/permissions.js'
import { createMarketplaceHandlers } from './handlers/marketplace.js'
import { recoverInterruptedProfileUpdates } from '../profile/update/index.js'
import { createPrincipalHandlers } from './handlers/principals.js'
import { createAccessGrantHandlers } from './handlers/access-grants.js'
import { createConnectionInventoryHandler } from './handlers/connection-inventory.js'
import { createConnectionLifecycleHandlers } from './handlers/connection-lifecycle.js'
import {
  createReadSourceContentHandler,
  createSearchSourceContentHandler,
} from './handlers/source-content.js'
import { AccessGrantStore } from './access-grant-store.js'
import { AccessGrantEvaluator } from './access-grant-evaluator.js'
import { ProtectedSourceReadService } from './protected-source-read.js'
import { ProtectedSourceSearchService } from './protected-source-search.js'
import { EvidenceSearchCache } from './evidence-search-cache.js'
import { ProtectedDataViewSelectionService } from './protected-data-view-selection.js'
import { createSourceDataViewQueryHandler } from './handlers/source-data-view-query.js'
import {
  createGetSourceHandler,
  createListSourcesHandler,
  createRegisterSourceHandler,
} from './handlers/sources.js'
import { SourceStore } from './source-store.js'
import { SourceUploadStore } from './source-upload-store.js'
import { SourceJobStore } from './source-job-store.js'
import { SourceJobWorker } from './source-job-worker.js'
import { SourceDataViewStore } from './source-data-view-store.js'
import { ChannelJobStore } from './channel-job-store.js'
import { ChannelJobWorker } from './channel-job-worker.js'
import { ChannelProcedureRegistry } from './channel-procedures.js'
import { ChannelConnectToolProvider } from './channel-connect-tool.js'
import { createWhatsAppConnectProcedure } from './whatsapp-connect.js'
import type { ChannelCredentialResolver } from './channel-credentials.js'
import { SourceDeletionStore } from './source-deletion-store.js'
import { SourceDeletionWorker } from './source-deletion-worker.js'
import {
  createCancelSourceDeletionHandler,
  createGetSourceDeletionHandler,
  createRetrySourceDeletionHandler,
  createSourceDeletionHandler,
} from './handlers/source-deletions.js'
import {
  DEFAULT_SOURCE_QUOTA_LIMITS,
  SourceQuotaPolicy,
  type SourceQuotaLimits,
} from './source-quota-policy.js'
import {
  createCancelSourceJobHandler,
  createGetSourceDataViewHandler,
  createGetSourceJobHandler,
  createGetSourceResourceHandler,
  createSourceJobHandler,
  createSourcePreparationHandler,
} from './handlers/source-jobs.js'
import {
  createCompleteSourceUploadHandler,
  createGetSourceVersionHandler,
  createSourceUploadSessionHandler,
  createWriteSourceUploadChunkHandler,
} from './handlers/source-uploads.js'
import { SourceByteStore } from './source-byte-store.js'
import { SessionRunner } from './session-runner.js'
import { loadRetentionConfig, startRetentionSchedule, runRetentionOnce, type RetentionStats } from './retention.js'

// ---------------------------------------------------------------------------
// Gateway options
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  /** HTTP port. Default: 3011. Use 0 for OS-assigned port. */
  port?: number
  /**
   * Bind host. Default: OWNWARE_HOST env or 127.0.0.1 (loopback).
   *
   * THE INVARIANT: a non-loopback host forces auth ON and TLS ON. If
   * you also pass `disableAuth: true` or `tls: false`, the constructor
   * THROWS instead of serving the network unprotected. With auth
   * enabled the token persists to `<dataDir>/gateway-token` (0600) so
   * clients can discover it across restarts.
   */
  host?: string
  /**
   * Hostnames the Host-header guard accepts on non-loopback binds
   * (DNS-rebinding protection). IP literals and localhost always pass;
   * add your real DNS name(s) here when serving one.
   */
  allowedHosts?: readonly string[]
  /** Directory containing profile subdirectories. */
  profilesDir: string
  /** Enable CORS. Default: true */
  cors?: boolean
  /** Allowed CORS origins. Default: localhost-only. Use ['*'] for allow-all. */
  corsOrigins?: readonly string[]
  /** Additional profile directories to discover (e.g., global profiles). */
  additionalProfileDirs?: string[]
  /** Custom database path (default: <dataDir>/ownware.db). Used for test isolation. */
  dbPath?: string
  /** Data directory (default: OWNWARE_DATA_DIR env or ~/.ownware). */
  dataDir?: string
  /** Disable rate limiting (for testing). Default: false */
  disableRateLimit?: boolean
  /** Disable access logging (for testing). Default: false */
  disableAccessLog?: boolean
  /** Disable the durable source worker for state-machine isolation tests. */
  disableSourceWorker?: boolean
  /** Effective runtime-owned source quotas. Defaults are advertised by capabilities. */
  sourceQuotaLimits?: SourceQuotaLimits
  /**
   * Disable the session-token auth middleware entirely.
   *
   * 2026-04-11 audit Hazard 24 fix: this defaults to TRUE.
   *
   * Cortex is local-first per the root CLAUDE.md ("the app opens and
   * works immediately — no account required"). The gateway binds to
   * 127.0.0.1 by default and CORS allows only localhost origins, so
   * the only attacker model the session token defends against is
   * other local processes — and on a single-user desktop install
   * those processes already have full filesystem access to
   * `~/.ownware/credentials/` anyway. The token doesn't add real
   * security; it just blocked the desktop client (whose api-client doesn't ship
   * the header) from talking to the gateway in any non-dev config.
   *
   * Set explicitly to false (or `OWNWARE_REQUIRE_AUTH=1`) when running
   * the gateway in a multi-user environment, when binding to 0.0.0.0,
   * or when wiring real user auth on top.
   *
   * The middleware is still installed (as a no-op when disabled) so a
   * future auth strategy (Auth0, per-user tokens, OS keychain) can
   * plug in without restructuring.
   */
  disableAuth?: boolean
  /**
   * Serve HTTP/2-over-TLS with a self-signed loopback cert (default: true).
   *
   * TLS is what lets the renderer use HTTP/2, which removes the browser's
   * 6-connection-per-origin stall (gateway-perf-2026-06-13). The desktop
   * (Electron) packaging keeps this true.
   *
   * Set FALSE to serve plain HTTP/1.1:
   *   - the test harness (no browser, no 6-conn limit, avoids per-boot cert
   *     generation), and
   *   - the future BYO-cloud packaging, where a platform proxy
   *     (Vercel/CF/Fly) terminates TLS upstream and the gateway speaks plain
   *     http behind it (see root CLAUDE.md "Deployment surfaces").
   */
  tls?: boolean
}

/**
 * The hosts the bind-safety invariant treats as "this machine only".
 * `0.0.0.0`/`::` bind every interface; a hostname or LAN/public IP
 * binds the network — both are non-loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]'
}

// ---------------------------------------------------------------------------
// OwnwareGateway
// ---------------------------------------------------------------------------

export class OwnwareGateway {
  // http2.Http2SecureServer and http.Server both extend net.Server; we
  // only call .listen()/.close()/.on('error')/.address() on it, so the
  // net.Server base is the right field type.
  private server: NetServer | null = null
  /** SHA-256 fingerprint of the loopback TLS cert (for Electron pin-trust). */
  private _tlsFingerprint = ''
  private shuttingDown = false
  /** Teardown for the bridge-catalog filesystem watcher (Phase 9). */
  private bridgeCatalogStop: (() => void) | null = null
  private readonly router: Router
  readonly state: GatewayState
  readonly registry: ProfileRegistry
  private readonly opts: Required<Pick<GatewayOptions, 'port' | 'profilesDir' | 'cors'>> & {
    additionalProfileDirs: string[]
    host: string
    dataDir: string
    corsOrigins: readonly string[]
    tls: boolean
    sourceWorkerEnabled: boolean
    sourceQuotaLimits: SourceQuotaLimits
  }
  private readonly _token: string
  /**
   * Resolved auth posture — set by the bind-safety invariant in the
   * constructor. False whenever the bind host is non-loopback,
   * regardless of env/opts.
   */
  private readonly authDisabled: boolean
  readonly principalService: ScopedPrincipalService
  readonly runIdempotency: RunIdempotencyStore
  readonly runStore: GatewayRunStore
  /**
   * Background run manager. Owns the generator iteration lifecycle
   * so agent runs survive SSE disconnects, tab closes, and refreshes.
   */
  readonly runner: SessionRunner
  /**
   * Disposer for the retention timer. `null` when retention is
   * disabled (the default). Set by `start()`, called in `stop()`.
   */
  private stopRetention: (() => void) | null = null
  private scheduleStore: SqliteScheduleStore | null = null
  private approvalStore: SqliteApprovalStore | null = null
  private scheduleRunner: ScheduleRunner | null = null
  /** Outbound schedule-delivery sink (Slice 8). Registered by the host
   *  process AFTER start() (e.g. `ownware serve` wiring its in-process
   *  ChannelRunner) — the runner looks it up per delivery, so late
   *  registration is fine. Null = no channel push possible. */
  private scheduleDeliverySink: ScheduleDeliverySink | null = null
  /** Stops the periodic Composio catalogue keep-warm (see start()). */
  private stopCatalogWarm: (() => void) | null = null
  /** Most recent retention stats, exposed via the admin endpoint. */
  private lastRetentionStats: RetentionStats | null = null
  /**
   * Process-wide connector status bus. One instance per gateway; every
   * emitter and the SSE fan-out handler share it.
   */
  readonly connectorStatusBus: ConnectorStatusBus
  /**
   * Process-wide credential CRUD event bus (audit #5 H1, 2026-05-16).
   * Threaded into the credential-store handler factory (so emits fire
   * on create / update / delete / validate) and into the credential-
   * events SSE handler (so subscribers receive invalidate-only hints).
   */
  readonly credentialEventBus: CredentialEventBus
  /**
   * Process-wide workspace CRUD event bus (audit #2 C2 / F1a,
   * 2026-05-16). Threaded into the workspace handler factory (so
   * emits fire on create / update / archive / delete) and into the
   * workspace-events SSE handler (so subscribers receive
   * invalidate-only hints).
   */
  readonly workspaceEventBus: WorkspaceEventBus
  /**
   * Per-thread pending-reconcile tracker. Owns both the "this thread
   * needs a reconcile on its next turn" set and the per-thread
   * `ManagedTools` snapshots that reconcile diffs against. Shared
   * across run-handler (seeds initial snapshot), profile handlers
   * (mark-on-attach/detach), and the status-bus subscriber
   * (mark-on-connector-change). See `pending-reconcile.ts`.
   */
  readonly pendingReconciles: PendingReconciles
  /**
   * Process-wide task event bus — paired with `taskStore` below. Loom's
   * `todo_write` tool writes through the store (via the per-thread
   * scoped adapter); this bus fans the resulting `tasks.updated`
   * events out to SSE clients. See `src/tasks/event-bus.ts`.
   */
  readonly taskEventBus: TaskEventBus
  /**
   * SQLite-backed task store. Passed into `run.ts` so the session
   * config carries a per-thread `TaskStore` adapter for Loom.
   */
  readonly taskStore: SqliteTaskStore
  /**
   * Memory system (memories + proposals + user identity + event bus).
   * Shared across the gateway. Passed into:
   *   - run.ts so each session is assembled with a bound `remember`
   *     tool and DB-backed memory in the system prompt.
   *   - the memory handlers so HTTP CRUD and SSE flow through the
   *     same stores + bus.
   */
  readonly memorySystem: MemorySystem
  /**
   * Per-workspace agent PTY sessions — exactly one per workspace,
   * lazy-spawned, written to only by Loom's `shell_execute` via the
   * scoped runner. Killed on gateway shutdown. (The desktop terminal
   * panel's HTTP/SSE surface was removed; the registry stays because
   * it is the engine-side shell-state substrate.)
   */
  readonly terminalEventBus: TerminalEventBus
  readonly terminalRegistry: TerminalSessionRegistry
  /**
   * Shared `WebSearchService`. The connector handlers, the status-bus
   * emitter for web-search PATCH, and `assembleAgent()` (via run.ts)
   * all use this single instance so the resolved provider on disk,
   * in the live handler, and in the next assembled session agree.
   */
  readonly webSearchService: WebSearchService
  /**
   * Per-connection OAuth / API-key state (vendor-agnostic). Composio's
   * catalogue is no longer mirrored locally — see
   * `connector/composio/catalog-cache.ts` for the live passthrough.
   */
  readonly connectorConnections: ConnectorConnectionsStore
  /**
   * Unified credential store. Single SQLite-backed source of truth
   * for every credential the gateway holds.
   */
  readonly credentialStore: CredentialStore
  /**
   * Append-only credential audit log (C28). Every reveal / validate /
   * create / update / delete writes one row. The resolver-side audit
   * (one row per resolve) waits for C22 to land.
   */
  readonly credentialAudit: CredentialAuditLog
  /**
   * Trust gate (C30). HMAC-signed approval registry. The
   * `/credentials/:id/approve` endpoint feeds responses back here;
   * the resolver-side `requestApproval()` call awaits the user
   * decision.
   */
  readonly credentialTrustGate: TrustGate
  /**
   * Gateway-side resolver (C22). Single ground-truth implementation
   * of loom's `CredentialResolver`. Wraps store + audit + spend
   * tracker + trust gate into one `resolve(name, ctx)` call.
   */
  readonly credentialResolver: GatewayCredentialResolver
  /**
   * Injector (C23). Three OS-boundary injection sites:
   * `injectEnvForChild`, `injectAuthHeader`, `runWithCredential`.
   */
  readonly credentialInjector: CredentialInjector
  /**
   * Vendor-agnostic polling engine. Composio (2b), future Pipedream,
   * etc. register listeners here. Webhook-driven sources skip this.
   */
  readonly connectionCompletionManager: ConnectionCompletionManager
  /** Encrypted, short-lived continuation material for pending OAuth sessions. */
  readonly connectionSessions: ConnectionSessionVault
  /**
   * Stable proxy registered with the connector registry at boot. The
   * gateway swaps the inner Composio source provider via `setInner()`
   * whenever the COMPOSIO_API_KEY credential changes — adding the key
   * after boot enables Composio without restart; removing the key
   * tears it down cleanly.
   */
  private readonly composioSourceProxy = new ComposioSourceProxy()
  /**
   * Stable proxy registered with `toolProviders` at boot. Same rebuild
   * lifecycle as `composioSourceProxy`.
   */
  private readonly composioToolProviderProxy = new ComposioToolProviderProxy()
  /**
   * Live Composio HTTP client + poll listener. Both `null` when
   * COMPOSIO_API_KEY is unset (or the vault equivalent is empty).
   * Swapped on every credential change — see `applyComposioKey()`.
   */
  private composioClient: ComposioClient | null = null
  private composioListener: ComposioCompletionListener | null = null
  /**
   * Shared live-catalogue cache. Both `composioSource` (UI listings)
   * and `composioToolProvider` (profile assembly) read through this
   * one cache so we never run two paginated walks at once. Null when
   * Composio is unconfigured.
   */
  private composioCatalogCache: ComposioCatalogCache | null = null
  /**
   * Tool-adapter provider. Null when Composio is unconfigured.
   */
  private composioToolProvider: ComposioToolProvider | null = null
  /**
   * Unsubscribe handle for `composioToolProvider.attachStatusBus(...)`.
   * Captured on every successful runtime build so a teardown
   * (credential cleared) doesn't leak a status-bus subscriber.
   */
  private composioStatusBusUnsub: (() => void) | null = null
  /**
   * Last COMPOSIO_API_KEY value the gateway resolved. Compared against
   * the current value on `credential.changed` events to short-circuit
   * unrelated credential edits — only an actual COMPOSIO_API_KEY
   * mutation triggers a runtime rebuild.
   */
  private lastResolvedComposioKey: string | null = null
  /**
   * Cached Composio dashboard base URL for the authenticated workspace,
   * e.g. `https://platform.composio.dev/<org_slug>/<project_slug>`.
   *
   * Resolved exactly once in `start()` (after Composio boot). Read by
   * the sources-status handler so the client's admin-setup dialog can deep-
   * link `Open Composio` straight to the workspace's `/auth-configs`
   * page. `null` when Composio is disabled OR the resolver failed —
   * frontend then falls back to the generic platform URL.
   */
  private composioDashboardBaseUrl: string | null = null
  /** Phase 2b.2b — user's per-alias source preference store. */
  private readonly sourcePreferences: SourcePreferences
  /**
   * Install-scoped identity. Single source of truth for the string used
   * as `entity_id` on every connector_connections row AND as `userId`
   * sent to Composio's API. Resolved exactly once in the constructor;
   * passed by reference to every consumer (connector source, tool
   * provider, connect/disconnect/resync handlers). Removing the four
   * inline `'cortex-default-user'` literals that used to drift.
   */
  private readonly installIdentity: InstallIdentity
  private rateLimiter: RateLimiter | null = null
  private accessLogger: AccessLogger | null = null
  /**
   * Agent Teams vertical (cortex/src/team/). Constructed in
   * registerRoutes (it shares the run-handler's toolProviders list),
   * booted in start() after profile discovery, shut down in stop().
   */
  private teamModule: TeamModule | null = null
  private sourceJobWorker: SourceJobWorker | null = null
  private sourceDeletionWorker: SourceDeletionWorker | null = null
  private readonly evidenceSearchCache = new EvidenceSearchCache()
  /**
   * Channel procedures (CC1/CC3): store + registry exist from start();
   * the worker runs only after `enableChannelProcedures()` registers the
   * per-channel plugins (wired by `ownware serve` when the shuttle
   * channel store is available).
   */
  private channelJobStore: ChannelJobStore | null = null
  private channelProcedures: ChannelProcedureRegistry | null = null
  private channelJobWorker: ChannelJobWorker | null = null
  private readonly sourceQuota: SourceQuotaPolicy

  constructor(opts: GatewayOptions) {
    const dataDir = opts.dataDir ?? process.env.OWNWARE_DATA_DIR ?? join(homedir(), DEFAULT_DATA_DIR_NAME)
    // If dbPath is explicitly set (test isolation), derive dataDir from it
    const effectiveDbPath = opts.dbPath ?? join(dataDir, 'ownware.db')

    // Port env fallback, mirroring the OWNWARE_HOST / OWNWARE_DATA_DIR /
    // OWNWARE_GATEWAY_TLS pattern above so `OWNWARE_PORT` works through
    // `ownware serve` too, not just the raw `server.js` entry. Precedence
    // matches that entry: GATEWAY_PORT, then OWNWARE_PORT. An explicit
    // opts.port always wins; a non-numeric/empty env value is ignored.
    const envPortRaw = process.env.GATEWAY_PORT ?? process.env.OWNWARE_PORT
    const envPort =
      envPortRaw !== undefined && envPortRaw.trim() !== '' && Number.isInteger(Number(envPortRaw))
        ? Number(envPortRaw)
        : undefined

    this.opts = {
      port: opts.port ?? envPort ?? 3011,
      profilesDir: resolve(opts.profilesDir),
      cors: opts.cors ?? true,
      additionalProfileDirs: opts.additionalProfileDirs ?? [],
      host: opts.host ?? process.env.OWNWARE_HOST ?? '127.0.0.1',
      dataDir,
      corsOrigins: opts.corsOrigins ?? ['http://localhost:*', 'http://127.0.0.1:*'],
      // TLS on by default (desktop). Env escape hatch mirrors the other
      // OWNWARE_* toggles; the harness sets opts.tls=false directly.
      tls: opts.tls ?? process.env.OWNWARE_GATEWAY_TLS !== '0',
      sourceWorkerEnabled: opts.disableSourceWorker !== true,
      sourceQuotaLimits: opts.sourceQuotaLimits ?? DEFAULT_SOURCE_QUOTA_LIMITS,
    }

    // ── Bind-safety invariant (S9) ────────────────────────────────────
    // Non-loopback bind ⇒ auth + TLS FORCED, or refuse to boot. There is
    // no configuration in which the full route surface serves a network
    // unauthenticated or unencrypted — the local-first "auth off by
    // default" posture (Hazard 24, below) is a LOOPBACK-ONLY deal.
    //
    // Resolve the auth flag first, exactly as documented on
    // GatewayOptions.disableAuth:
    //   1. explicit opts.disableAuth (true/false) wins
    //   2. OWNWARE_REQUIRE_AUTH=1 / OWNWARE_DISABLE_AUTH=0 opt in to auth
    //   3. otherwise → disabled (loopback local-first default)
    const envRequire = process.env.OWNWARE_REQUIRE_AUTH
    const envDisable = process.env.OWNWARE_DISABLE_AUTH
    const envSaysEnable =
      envRequire === '1' || envRequire === 'true' ||
      envDisable === '0' || envDisable === 'false'
    let authDisabled = opts.disableAuth ?? !envSaysEnable

    const hostIsLoopback = isLoopbackHost(this.opts.host)
    if (!hostIsLoopback) {
      if (opts.disableAuth === true) {
        throw new Error(
          `OwnwareGateway: refusing to bind ${this.opts.host} with auth disabled — ` +
            'every route would be open to the network. Remove disableAuth, or bind 127.0.0.1.',
        )
      }
      if (this.opts.tls === false) {
        throw new Error(
          `OwnwareGateway: refusing to bind ${this.opts.host} without TLS — ` +
            'exposed traffic must be encrypted. Remove tls:false / OWNWARE_GATEWAY_TLS=0, or bind 127.0.0.1.',
        )
      }
      authDisabled = false
    }
    this.authDisabled = authDisabled

    // With auth enabled the token must survive restarts and be
    // discoverable by clients: <dataDir>/gateway-token, 0600 (WI-2).
    // Auth-off keeps a per-boot random token (unused, but the middleware
    // hook stays wired).
    this._token = authDisabled ? generateSessionToken() : loadOrCreateGatewayToken(dataDir)
    this.router = new Router()
    this.state = new GatewayState(effectiveDbPath)
    this.sourceQuota = new SourceQuotaPolicy(
      this.state.rawDbHandle,
      this.opts.sourceQuotaLimits,
    )
    this.principalService = new ScopedPrincipalService({
      ownerToken: this._token,
      store: new DelegatedPrincipalStore(this.state.rawDbHandle),
    })
    this.runIdempotency = new RunIdempotencyStore(this.state.rawDbHandle)
    this.runStore = new GatewayRunStore(this.state.rawDbHandle, this._token)
    this.runner = new SessionRunner(this.state, this.runStore)
    this.registry = new ProfileRegistry()
    this.connectorStatusBus = createConnectorStatusBus()
    this.credentialEventBus = createCredentialEventBus()
    this.workspaceEventBus = createWorkspaceEventBus()
    this.pendingReconciles = new PendingReconciles()
    this.taskEventBus = new TaskEventBus()
    this.taskStore = new SqliteTaskStore(this.state.rawDbHandle, this.taskEventBus)
    // Per-profile scheduling store (own vertical, migration 43).
    this.scheduleStore = new SqliteScheduleStore(this.state.rawDbHandle)
    this.approvalStore = new SqliteApprovalStore(this.state.rawDbHandle)
    // Memory system — see `packages/cortex/src/memory/index.ts`. One
    // instance per gateway, sharing the main SQLite handle. Migrations
    // 018 ran on CortexDatabase construction above so the tables exist.
    this.memorySystem = createMemorySystem(this.state.rawDbHandle)
    this.terminalEventBus = new TerminalEventBus()
    this.terminalRegistry = new TerminalSessionRegistry({
      bus: this.terminalEventBus,
      workspaces: {
        getWorkspacePath: (wsId) => this.state.getWorkspace(wsId)?.path ?? null,
      },
    })
    this.webSearchService = new WebSearchService({ settings: this.state })

    // ── Phase 2a connector foundation ────────────────────────────────
    //
    // Stores operate against the shared main-db handle. Their tables
    // are created by migration 008 on CortexDatabase construction
    // above, so we can instantiate eagerly.
    this.connectorConnections = new ConnectorConnectionsStore(this.state.rawDbHandle)
    // Unified credential store — backed by migration 015's `credentials`
    // table. Eager construction is safe: migrations have already run on
    // the CortexDatabase constructor above, so the prepared statements
    // bind to a real schema.
    this.credentialStore = createCredentialStore(this.state.rawDbHandle)
    // Phase 5: audit log (migration 016) + trust gate. Audit module
    // shares the same DB handle. Trust gate generates a fresh HMAC
    // key per launch — the renderer round-trips signed approval
    // responses back to `/credentials/:id/approve`.
    this.credentialAudit = new CredentialAuditLog(this.state.rawDbHandle)
    this.credentialTrustGate = new TrustGate()
    // Phase 6/7/8: resolver + injector. Eager construction is safe —
    // store and audit are already alive above. The resolver pulls
    // its spend-tracker DB handle off the same connection; no
    // separate process or pool.
    this.credentialResolver = new GatewayCredentialResolver({
      store: this.credentialStore,
      audit: this.credentialAudit,
      spendDb: this.state.rawDbHandle,
      trustGate: this.credentialTrustGate,
    })
    this.credentialInjector = new CredentialInjector(this.credentialResolver)
    // Phase 2b.2b — per-alias source preference store (user_settings backed).
    this.sourcePreferences = new SourcePreferences(this.state)
    // Resolve install identity ONCE, here. Every other consumer reads
    // from `this.installIdentity.id` — no inline literals, no per-site
    // env reads, no defaults at call sites.
    this.installIdentity = InstallIdentity.resolve()
    this.connectionSessions = new ConnectionSessionVault({
      directory: join(this.opts.dataDir, 'connection-sessions'),
    })
    this.connectionCompletionManager = new ConnectionCompletionManager(
      this.connectorConnections,
      this.connectorStatusBus,
      {
        beforeTerminal: async ({ metadata }) => {
          const handle = connectionSessionHandle(metadata)
          if (handle !== null) await this.connectionSessions.remove(handle)
        },
      },
    )

    // Composio runtime — built once now using the boot-time key, then
    // rebuilt on every COMPOSIO_API_KEY credential change. The proxies
    // for source + tool-provider stay constant across rebuilds; only
    // their inner delegates swap. See `applyComposioKey()` for the
    // full lifecycle.
    this.applyComposioKey(this.resolveComposioKey())

    // Subscribe to credential events so a runtime credential change
    // (user adds / clears / rotates COMPOSIO_API_KEY via Settings)
    // rebuilds Composio without a gateway restart. The handler
    // short-circuits on events that don't actually change the
    // resolved Composio key value.
    this.credentialEventBus.subscribe(() => {
      this.maybeRebuildComposioRuntime()
    })

    // Re-wire loom's LLM provider registry on credential changes.
    //
    // The unified credential-store path (POST/PATCH /api/v1/credentials —
    // used by onboarding and the new Settings UI) writes the key to the
    // store but, unlike the legacy POST /api/v1/providers handler, never
    // re-registered the provider in loom. A freshly-saved key (e.g.
    // OPENROUTER_API_KEY) therefore reported `hasCredentials: true` and
    // showed its models as available, yet a run died with
    // `Unknown provider "openrouter"` until the next gateway restart —
    // the store and loom's in-memory registry were split-brained.
    //
    // Mirror the Composio listener: every mutation re-runs the idempotent
    // store→loom bootstrap so a saved provider goes live immediately.
    // `validated` doesn't touch the stored value, so skip it.
    this.credentialEventBus.subscribe((event) => {
      if (event.action === 'validated') return
      void this.refreshLlmProviderRegistry()
    })

    // Set CORS origins
    this.router.setCorsOrigin(this.opts.corsOrigins)

    // Auth was resolved up top with the bind-safety invariant (the flag
    // and the token persistence belong to the same decision). Default is
    // DISABLED on loopback (audit Hazard 24, see GatewayOptions doc);
    // FORCED ON for any non-loopback bind.
    if (!this.authDisabled) {
      console.warn(
        '[ownware] auth middleware ENABLED — clients must include ' +
          '`Authorization: Bearer <token>`. Read the token from ' +
          `\`${gatewayTokenPath(dataDir)}\` (0600) or \`gateway.token\` in-process. ` +
          'Never paste it into shared logs.',
      )
    }

    // Wire middleware chain: host guard (non-loopback) → auth → rate limit
    if (!isLoopbackHost(this.opts.host)) {
      // DNS-rebinding guard — see middleware/host-guard.ts.
      this.router.use(createHostGuard({ allowedHosts: opts.allowedHosts ?? [] }))
    }
    this.router.use(createPrincipalAuthMiddleware(
      this._token,
      this.principalService,
      { disabled: this.authDisabled },
    ))

    // Rate limiting and access logging are auto-disabled in test mode
    // (when dbPath is explicitly set). Override with explicit true/false.
    const isTestMode = !!opts.dbPath

    const enableRateLimit = opts.disableRateLimit === undefined
      ? !isTestMode
      : !opts.disableRateLimit
    if (enableRateLimit) {
      this.rateLimiter = createRateLimiter()
      this.router.use((req, res) => this.rateLimiter!.check(req, res))
    }

    const enableAccessLog = opts.disableAccessLog === undefined
      ? !isTestMode
      : !opts.disableAccessLog
    if (enableAccessLog) {
      this.accessLogger = createAccessLogger(join(dataDir, 'logs'))
    }
  }

  /** Session token for authenticating requests. */
  get token(): string {
    return this._token
  }

  /**
   * Register the outbound schedule-delivery sink (Slice 8). The host that
   * also runs the channels (e.g. `ownware serve` with shuttle's in-process
   * ChannelRunner) hands the gateway a way to push a finished scheduled
   * run's text to `schedule.deliver.{channel,target}`. Call with null to
   * unregister. Layering: the gateway only ever sees this callback — it
   * never imports a channel adapter.
   */
  setScheduleDeliverySink(sink: ScheduleDeliverySink | null): void {
    this.scheduleDeliverySink = sink
  }

  /**
   * SHA-256 fingerprint (colon-hex) of the gateway's loopback TLS cert.
   * Empty until start() has provisioned the cert. Electron pins this to
   * trust ONLY this cert for 127.0.0.1.
   */
  get tlsFingerprint(): string {
    return this._tlsFingerprint
  }

  /**
   * Agent Teams vertical — exposed for tests and ops tooling (e.g.
   * aborting one member's in-flight session). Null until
   * registerRoutes has run (i.e. before start()).
   */
  get teams(): TeamModule | null {
    return this.teamModule
  }

  /** Data directory path. */
  get dataDir(): string {
    return this.opts.dataDir
  }

  /**
   * Resolve the Composio API key from vault → env, in that order.
   *
   * Vault wins because an explicit user-configured key (via the
   * reserved id `__cortex_composio_admin`) is the strong signal; env
   * is the fallback for CI/local-dev. Either source may be absent;
   * the scaffold null-returns and logs a single warning in that case.
   *
   * Phase 2b may move this resolution into `createComposioSource`
   * itself once the UI settings path exists. For now env+vault
   * resolution lives here so the scaffold stays pure data-in /
   * provider-out.
   */
  /**
   * Alias-aware filter for the Composio tool-adapter.
   *
   * Sync decision driven by the source preference store + alias table:
   *
   *   1. `appId` not a known alias logical key     → emit (true).
   *   2. User has an explicit pref and it's NOT composio → drop (false).
   *   3. User has an explicit pref == 'composio'   → emit (true).
   *   4. No explicit pref + the app IS aliased     → emit (Composio
   *      wins the default for alias collisions). Mirrors the
   *      catalog-side flip in `source-resolver.ts`: the agent's
   *      runtime tool surface must match what the lobby shows it,
   *      else the user adds the MCP-Gmail card but the agent calls
   *      the Composio-Gmail action. Pre-2026-05-25 the default was
   *      MCP-wins; that inference no longer holds now that Composio
   *      is opt-in via a deliberate Settings → Advanced paste.
   *
   * All lookups are pure + sync.
   */
  /**
   * Does this profile declare the given connector (matching source +
   * connectorId)? Used by the status-bus subscriber to scope reconcile
   * marks — a Gmail OAuth completion should only poke threads on
   * profiles that actually declare Gmail, not every thread on the
   * install.
   *
   * Reads `config.tools.composio.toolkits` / `config.tools.mcp` from
   * the cached profile. Unknown / non-connector sources return false
   * (they have no profile-scoped declaration surface — builtins are
   * preset-driven, web-search is install-wide). Keeping this method
   * narrow lets future sources opt in explicitly.
   */
  private profileDeclaresConnector(
    profile: { config: Record<string, unknown> },
    source: string,
    connectorId: string,
  ): boolean {
    const tools = (profile.config['tools'] ?? {}) as Record<string, unknown>
    if (source === 'composio') {
      const c = (tools['composio'] ?? {}) as Record<string, unknown>
      const list = Array.isArray(c['toolkits']) ? (c['toolkits'] as unknown[]) : []
      return list.some((t) => typeof t === 'string' && t === connectorId)
    }
    if (source === 'mcp') {
      // Phase 16 (2026-05-01): the legacy `'custom_mcp'` source
      // collapsed into `'mcp'`. Only the unified label is checked here.
      const mcp = (tools['mcp'] ?? {}) as Record<string, unknown>
      return Object.prototype.hasOwnProperty.call(mcp, connectorId)
    }
    return false
  }

  private shouldComposioEmitForAppId(appId: string): boolean {
    try {
      const logicalKey = getAliasesFor(`composio:${appId}`)
      if (logicalKey === null) return true
      const pref = this.sourcePreferences.get(logicalKey)
      if (pref !== null) return pref === 'composio'
      // No user pref + aliased app → Composio wins. The earlier
      // `!isAliasLogicalKey(logicalKey)` flip dropped Composio
      // whenever an MCP counterpart existed; that's exactly the
      // collision we now want Composio to serve by default.
      return true
    } catch {
      // Fail safe: emit. Better to surface both sources than silently
      // drop tools the user needs.
      return true
    }
  }

  private resolveComposioKey(): string | null {
    // Read the COMPOSIO_API_KEY credential straight from the encrypted
    // credentials table. better-sqlite3 is sync so this fits the
    // sync-constructor seam without a separate bootstrap step.
    const row = this.state.rawDbHandle
      .prepare(
        `SELECT encrypted_value FROM credentials
         WHERE variable_name = 'COMPOSIO_API_KEY' AND status = 'ready'
         LIMIT 1`,
      )
      .get() as { encrypted_value: string } | undefined
    if (!row) return null
    const plaintext = decryptCredentialValue(row.encrypted_value)
    const trimmed = plaintext && plaintext.trim().length > 0 ? plaintext.trim() : null
    if (trimmed === null) return null
    // Defensive: if the user pasted a `uak_*` CLI key (the value
    // `composio login` writes to ~/.composio/user_data.json), every
    // SDK call will 401 — silently, because the catalog sync's
    // catch-all swallows errors. Drop Composio cleanly with a loud
    // log instead of pretending it's configured. See
    // connector-rail-2026-05-11/BUGS.md #4.
    if (isLikelyUserScopedComposioKey(trimmed)) {
      console.error(
        '[ownware] COMPOSIO_API_KEY looks like a user-scoped CLI key ' +
        '(`uak_…`). Composio requires a project-scoped key (`ak_…`). ' +
        'Get one from the Composio dashboard → API keys, or run ' +
        '`composio dev init` and copy COMPOSIO_API_KEY from the generated ' +
        '.env.local. Composio integration is disabled until the key is fixed.',
      )
      return null
    }
    return trimmed
  }

  /**
   * Re-resolve the Composio key from credentials storage and rebuild
   * the runtime if (and only if) the value has actually changed.
   * Wired to `credentialEventBus` — every credential mutation fires
   * the bus, but only an actual COMPOSIO_API_KEY change triggers a
   * rebuild here. Unrelated credential edits (user saves
   * `ANTHROPIC_API_KEY`, etc.) compare equal and short-circuit.
   */
  private maybeRebuildComposioRuntime(): void {
    const currentKey = this.resolveComposioKey()
    if (currentKey === this.lastResolvedComposioKey) return
    const transition = currentKey === null
      ? 'cleared'
      : this.lastResolvedComposioKey === null
        ? 'configured'
        : 'rotated'
    console.log(`[ownware] composio: COMPOSIO_API_KEY ${transition} — rebuilding runtime`)
    this.applyComposioKey(currentKey)
  }

  /**
   * Re-run the store→loom provider bootstrap so a credential saved via
   * the unified `/api/v1/credentials` path becomes a live loom provider
   * without a gateway restart. Idempotent — each call replaces every
   * resolver-backed registration with a fresh closure that re-resolves
   * through the gateway (audit + spend gate) on every chat call. Errors
   * are logged, never thrown: a failed re-register must not crash the
   * credential-event listener.
   */
  private async refreshLlmProviderRegistry(): Promise<void> {
    try {
      await bootstrapProvidersFromUnifiedStore({
        store: this.credentialStore,
        resolver: this.credentialResolver,
        injector: this.credentialInjector,
      })
    } catch (err) {
      console.error('[ownware] LLM provider re-registration failed:', err)
    }
  }

  /**
   * Build (or tear down) every Composio-runtime component for the
   * given key. Idempotent: callable from the constructor for boot,
   * and from `maybeRebuildComposioRuntime()` on credential changes.
   *
   * Tear-down ordering matters: unsubscribe from the status bus and
   * unregister the completion listener BEFORE nulling field
   * references — otherwise stale callbacks could fire against
   * already-null state.
   *
   * Build ordering: client → catalogue cache → source provider →
   * listener + tool provider → status-bus subscription. Each layer
   * depends on the previous; failing any layer leaves Composio fully
   * disabled (proxies stay empty) rather than half-wired.
   */
  private applyComposioKey(key: string | null): void {
    // 1. Tear down whatever was wired previously.
    if (this.composioStatusBusUnsub !== null) {
      this.composioStatusBusUnsub()
      this.composioStatusBusUnsub = null
    }
    this.connectionCompletionManager.unregisterListener('composio')
    this.composioClient = null
    this.composioCatalogCache = null
    this.composioListener = null
    this.composioToolProvider = null
    this.composioSourceProxy.setInner(null)
    this.composioToolProviderProxy.setInner(null)
    this.lastResolvedComposioKey = key

    if (key === null) return

    // 2. Build the fresh runtime.
    this.composioClient = new ComposioClient({ apiKey: key })
    this.composioCatalogCache = new ComposioCatalogCache({
      client: this.composioClient,
      // Longer than the 60s default: the global app catalogue is stable, and
      // with stale-while-revalidate + the startup/periodic warm-up the list
      // stays ready without hammering Composio. Per-install connection status
      // is re-derived per request, so a longer TTL never stales what the user
      // sees as "connected".
      ttlMs: 5 * 60_000,
    })
    const source = createComposioSource({
      apiKey: key,
      catalogCache: this.composioCatalogCache,
      connections: this.connectorConnections,
      statusBus: this.connectorStatusBus,
      profileReader: this.registry,
      entityId: this.installIdentity.id,
    })
    if (source === null) {
      // Defensive: `createComposioSource` only returns null when key /
      // cache are missing, both of which we just constructed. If we
      // hit this path, leave Composio fully disabled rather than
      // half-wired — proxies stay empty.
      this.composioClient = null
      this.composioCatalogCache = null
      return
    }
    this.composioSourceProxy.setInner(source)

    this.composioListener = new ComposioCompletionListener({ client: this.composioClient })
    this.connectionCompletionManager.registerListener(this.composioListener)
    this.composioToolProvider = new ComposioToolProvider({
      client: this.composioClient,
      catalogCache: this.composioCatalogCache,
      connections: this.connectorConnections,
      entityId: this.installIdentity.id,
      shouldEmitForAppId: (appId) => this.shouldComposioEmitForAppId(appId),
    })
    this.composioToolProviderProxy.setInner(this.composioToolProvider)
    // Bridge status-bus ready transitions to the tool provider so
    // every `composio → ready` event (fresh OAuth completion,
    // reconciler probe, etc.) warms the toolkit's action manifest.
    // Capture the unsubscribe handle so a future rebuild can tear
    // this down cleanly.
    this.composioStatusBusUnsub = this.composioToolProvider.attachStatusBus(this.connectorStatusBus)
    // Boot scan for already-ready connections — without this, rebuilds
    // that happen after the gateway is already running (credential
    // added post-boot) leave the manifest cache empty until the next
    // status transition. Fire-and-forget; errors logged inside.
    void this.composioToolProvider.warmAllReady()
    // Warm the connector CATALOGUE too (not just per-toolkit action manifests),
    // so a post-boot credential add makes the connector list ready immediately
    // rather than on the next user request. Fire-and-forget; cache swallows
    // its own errors and serves the last-good list.
    void this.composioCatalogCache?.warm()
    // Re-resolve the dashboard deep-link URL whenever we rebuild the
    // client. Without this, a user who adds COMPOSIO_API_KEY post-boot
    // gets the generic platform URL on "Open Composio" until next
    // restart. Fire-and-forget; the resolver swallows its own errors.
    void this.refreshComposioDashboardBaseUrl()
  }

  /**
   * Walk Composio's `/auth/session/info` to derive the per-workspace
   * dashboard deep-link base. Called from `applyComposioKey` on every
   * successful runtime build (boot + credential-change). The cached
   * URL is read by the sources-status handler so the client's setup
   * dialog can deep-link straight to the correct
   * `/<org>/<project>/auth-configs` page.
   */
  private async refreshComposioDashboardBaseUrl(): Promise<void> {
    if (this.composioClient === null) {
      this.composioDashboardBaseUrl = null
      return
    }
    try {
      const ws = await resolveComposioWorkspace({
        client: this.composioClient,
        envWorkspaceSlug: process.env['COMPOSIO_WORKSPACE_SLUG'],
        envProjectSlug: process.env['COMPOSIO_PROJECT_SLUG'],
      })
      this.composioDashboardBaseUrl = ws?.dashboardBaseUrl ?? null
    } catch (err) {
      console.warn(
        '[ownware] composio: unexpected workspace-resolve error (continuing):',
        err,
      )
      this.composioDashboardBaseUrl = null
    }
  }

  /**
   * Attribute a finished run's real cost back to the LLM credential
   * that backed it, so the Settings → Credentials cost panel
   * (`aggregateCost`) reflects actual spend.
   *
   * Maps `model` ("anthropic:claude-…") → providerId → canonical
   * `variableName` → the stored credential, then records one
   * post-flight true-up audit row tagged `detail.trueUp` so it sums
   * into `actual_cost_usd` without inflating the call count
   * (`aggregateCost` excludes true-up rows from `calls`).
   *
   * Best-effort: a missing provider/credential is a normal no-op (the
   * run used a key we don't track), and any failure is logged, never
   * thrown — this runs off the run-completion path.
   */
  private async attributeLlmCostToCredential(
    model: string,
    costUsd: number,
    threadId: string,
  ): Promise<void> {
    try {
      const providerId = model.includes(':') ? model.split(':')[0]! : model
      const descriptor = llmProviderById(providerId)
      if (descriptor === undefined) return
      const llmCredentials = await this.credentialStore.list({ category: 'llm' })
      const credential = llmCredentials.find(c => c.variableName === descriptor.variableName)
      if (credential === undefined) return
      this.credentialAudit.recordEvent({
        credentialId: credential.id,
        eventType: 'resolve',
        outcome: 'ok',
        agentId: 'gateway-llm',
        threadId,
        actualCostUsd: costUsd,
        detail: { trueUp: true, source: 'run-end', model },
      })
    } catch (err) {
      console.error('[gateway] LLM cost attribution failed:', err)
    }
  }

  /**
   * Start the gateway.
   * Discovers profiles, registers routes, and begins listening.
   */
  async start(): Promise<void> {
    // [boot-trace] Temporary per-phase timing to find what delays the
    // gateway becoming responsive (gateway-perf-2026-06-13). Always-on,
    // one short line per phase, logged to the gateway's stdout (visible in
    // the dev.sh terminal). Remove once boot ordering is fixed.
    const bootStart = Date.now()
    let bootLast = bootStart
    const bootLap = (label: string): void => {
      const now = Date.now()
      console.log(`[boot-trace] ${label}: ${now - bootLast}ms (total ${now - bootStart}ms)`)
      bootLast = now
    }

    // 0. Ensure the user profiles dir exists. Bundled is read-only.
    const globalProfilesDir = join(this.opts.dataDir, 'profiles')
    mkdirSync(globalProfilesDir, { recursive: true })
    const profileRecovery = await recoverInterruptedProfileUpdates(this.opts.dataDir)
    if (profileRecovery.restored > 0 || profileRecovery.finalized > 0) {
      console.log(
        `  profiles: recovered ${profileRecovery.restored} interrupted replacement(s), ` +
        `finalized ${profileRecovery.finalized} completed replacement(s)`,
      )
    }

    // Run boot-time credential migrations (currently: file vault
    // import). LLM keys live in the credentials store from the moment
    // the user adds them via Settings → Credentials; nothing imports
    // them implicitly at boot.
    // `deleteAfterImport: false` is intentional during the
    // credentials-unification transition (D8 chunks D+E not yet
    // shipped). Today's MCP source provider, mcp.ts handlers, and
    // connector-runtime-setup still read from `~/.ownware/credentials/`
    // — deleting the files on import would silently downgrade every
    // affected connector to `needs_setup` until those readers switch
    // to the SQL store. Per-row dedupe in the importer keeps re-runs
    // cheap and lossless. Once D+E land and the file vault is no
    // longer the read path, flip this back to `true` (the eventual
    // default) so the file vault winds down naturally and chunk F
    // can delete the implementation entirely.
    await runCredentialBootMigrations(
      this.state.rawDbHandle,
      this.credentialStore,
      {
        log: (msg) => console.log(msg),
        deleteAfterImport: false,
      },
    )

    // Wire every LLM provider's apiKeyProvider closure to the unified
    // resolver — every chat call flows through resolve → audit → spend
    // gate before the SDK request goes out.
    await bootstrapProvidersFromUnifiedStore({
      store: this.credentialStore,
      resolver: this.credentialResolver,
      injector: this.credentialInjector,
      log: (msg) => console.log(msg),
    })
    bootLap('credential migrations + providers')

    // 1. Discover profiles — Model C layered:
    //      builtin = packages/cortex/profiles/   (read-only catalog)
    //      user    = ~/.ownware/profiles/        (writable, shadows builtin)
    //
    //    Order within `discover` does not matter: the registry merges via
    //    explicit `source`. Builtin always loads first so the migration
    //    step below has both maps populated.
    await this.registry.discover(this.opts.profilesDir, 'builtin')

    // 1.0. Marketplace rename migration (PR B, 2026-05-19). Walks
    //      `~/.ownware/profiles/` BEFORE user discovery so the registry
    //      picks up the new folder names on its first pass. Idempotent;
    //      only touches dirs whose sidecar kind is 'ownware-marketplace'
    //      AND whose name is in MARKETPLACE_RENAME_MAP. User forks and
    //      unrelated dirs are left untouched. Failures are logged and
    //      never block boot.
    try {
      const result = await migrateMarketplaceInstalledNames(globalProfilesDir)
      if (result.renamed.length > 0) {
        console.log(
          `  profiles: migrated ${result.renamed.length} installed marketplace profile name(s) — ${result.renamed.map((r) => `${r.from}→${r.to}`).join(', ')}`,
        )
      }
      if (result.skippedTargetExists.length > 0) {
        console.warn(
          `[ownware] marketplace rename skipped (target dir already exists): ${result.skippedTargetExists.join(', ')}`,
        )
      }
      for (const f of result.failed) {
        console.warn(`[ownware] marketplace rename failed for '${f.from}': ${f.reason}`)
      }
    } catch (err) {
      console.warn('[ownware] migrateMarketplaceInstalledNames failed (continuing):', err)
    }

    await this.registry.discover(globalProfilesDir, 'user')
    for (const dir of this.opts.additionalProfileDirs) {
      await this.registry.discover(dir, 'user')
    }
    bootLap('profile discovery')

    // 1a. Warm content hashes once so `list()` returns accurate
    //     `hasUpdate` flags and the migration below has data to compare.
    await this.registry.warmHashes()
    bootLap('warmHashes')

    // 1b. Reap stale seed copies left behind by the legacy seedProfiles()
    //     boot path. Idempotent. Only deletes user dirs that have NO
    //     sidecar AND byte-match the current builtin — modified copies
    //     are preserved as user-owned forks.
    try {
      const reaped = await this.registry.migrateStaleSeeds()
      if (reaped.length > 0) {
        console.log(
          `  profiles: reaped ${reaped.length} stale seed copy/copies (${reaped.join(', ')})`,
        )
      }
    } catch (err) {
      console.warn('[ownware] migrateStaleSeeds failed (continuing):', err)
    }

    bootLap('migrateStaleSeeds')

    // 2. Sync MCP server configs from profiles to database
    await this.syncMCPServers()
    bootLap('syncMCPServers')

    // 2.0a. Preload the known-apps catalog so the connector registry's
    //       synchronous `lookupKnownAppByLogicalKey` calls (in
    //       `mcpServerToConnector` / `customRowToConnector`) hit the
    //       cache from the very first request. Without this, the first
    //       few lobby loads after boot would render with the generic
    //       `mcp` / `custom` categories until the async load finishes.
    //       Non-fatal: a load failure leaves the cache empty and the
    //       registry falls back to its prior category resolution.
    try {
      const { loadKnownApps } = await import('../connector/known-apps.js')
      await loadKnownApps()
    } catch (err) {
      console.warn('[ownware] known-apps preload failed (continuing):', err)
    }
    bootLap('known-apps catalog')

    // 2.0b. Hydrate the bridge catalog cache so dynamic bridge entries
    //       (Paper, Pencil, Figma desktop) appear in `getFeaturedServers()`
    //       from the first request. Set up a fs watcher (persistent:
    //       false, so it won't block process exit) to pick up
    //       drop/remove events live. Best-effort — failures degrade to
    //       "no bridges visible until a future refresh," not a boot
    //       failure. The watcher's stop fn is captured on the class so
    //       `stop()` can close it cleanly.
    try {
      const { refreshBridgeCache, watchBridgeCatalog } = await import(
        '../connector/bridge-catalog.js'
      )
      await refreshBridgeCache()
      this.bridgeCatalogStop = watchBridgeCatalog(() => {
        void refreshBridgeCache()
      })
    } catch (err) {
      console.warn('[ownware] bridge-catalog init failed (continuing):', err)
    }
    bootLap('bridge catalog')

    // 2a. Remove encrypted continuation material left by an interrupted
    //     gateway process before clearing its opaque database handle. A
    //     cleanup failure leaves the row pending so a later boot can retry;
    //     no secret value or identity is written to the log.
    try {
      let recovered = 0
      let cleanupFailures = 0
      for (const pending of this.connectorConnections.findPending()) {
        const handle = connectionSessionHandle(pending.metadata)
        if (handle === null) continue
        try {
          await this.connectionSessions.remove(handle)
          this.connectorConnections.markExpired(
            pending.connectionId,
            'Connection attempt was interrupted by a gateway restart. Please retry.',
          )
          recovered += 1
        } catch {
          cleanupFailures += 1
        }
      }
      if (recovered > 0) {
        console.log(`  connector connections: safely cleared ${recovered} interrupted session(s)`)
      }
      if (cleanupFailures > 0) {
        console.warn(
          `[ownware] connector connection session cleanup will retry on next boot (${cleanupFailures} row(s))`,
        )
      }
    } catch (err) {
      console.warn('[ownware] interrupted connection cleanup failed (continuing):', err)
    }

    // 2a. Expire stale `pending` connector connections left behind by
    //     a previous gateway restart. Honest v1 behaviour: without
    //     cross-restart poll persistence, an in-flight OAuth attempt
    //     that wasn't completed before shutdown must be marked so the
    //     user sees an actionable error instead of a silent stuck row.
    try {
      const expired = this.connectorConnections.expireStaleOnBoot()
      if (expired > 0) {
        console.log(
          `  connector connections: expired ${expired} stale pending row(s) from a previous restart`,
        )
      }
    } catch (err) {
      // Non-fatal: if the table is somehow missing (shouldn't be —
      // migrations ran), we log and continue booting.
      console.warn('[ownware] expireStaleOnBoot failed (continuing):', err)
    }

    // 2a.1. Self-check: any connector_connections row whose entity_id
    //       doesn't match this install's identity is unreachable by the
    //       runtime (the agent's tool list will see "not connected"
    //       even though a row exists). Schema layer prevents the
    //       primary cause (NULL entity_id) outright; this catches the
    //       residual case where the operator changed
    //       OWNWARE_COMPOSIO_USER_ID after rows were written under the
    //       old value. Loud-by-default so it doesn't silently regress
    //       to the pre-v19 user-visible bug.
    try {
      const foreign = this.connectorConnections.countForeignEntities(
        this.installIdentity.id,
      )
      if (foreign > 0) {
        console.warn(
          `[ownware] connector_connections: ${foreign} row(s) under a foreign entity_id ` +
            `are unreachable by the agent's tool list — users will see them as "not connected" until ` +
            `reconnected. Likely cause: OWNWARE_COMPOSIO_USER_ID was changed after rows ` +
            `were written.`,
        )
      }
    } catch (err) {
      console.warn('[ownware] entity_id self-check failed (continuing):', err)
    }

    // 2b. Recover orphaned threads left in 'active' status by a previous
    //     crash or unclean shutdown. No in-memory runtime survives a
    //     restart, so every 'active' thread is a zombie.
    try {
      const recoveredRuns = this.runStore.recoverInterrupted()
      if (recoveredRuns > 0) {
        console.log(`  runs: marked ${recoveredRuns} interrupted run(s) indeterminate after restart`)
      }
      const recovered = this.state.recoverOrphanedThreads()
      if (recovered > 0) {
        console.log(
          `  threads: recovered ${recovered} orphaned active thread(s) from a previous restart`,
        )
      }
    } catch (err) {
      console.warn('[ownware] recoverOrphanedThreads failed (continuing):', err)
    }

    // 2a-ws. Workspace identity for dashboard deep-links is resolved
    //        inside `applyComposioKey` — both at constructor boot AND
    //        on every runtime rebuild after a credential change, so a
    //        user who adds COMPOSIO_API_KEY post-boot gets the proper
    //        per-workspace deep-link without restart.
    //
    //        Block the start() barrier on the initial resolution if
    //        the client was wired at construction time — the boot
    //        flow downstream of here (route registration) reads the
    //        cached URL, so awaiting once at boot keeps the existing
    //        contract intact for first-request consumers.
    bootLap('connector boot checks (expire + entity + recover threads)')
    if (this.composioClient !== null) {
      await this.refreshComposioDashboardBaseUrl()
    }
    bootLap('composio dashboard url')

    // 2b. The tool-manifest warm scan for every already-ready composio
    //     connection now runs inside `applyComposioKey` (constructor +
    //     credential-change rebuild paths), so we don't duplicate it
    //     here — both code paths already cover the "boot with key set"
    //     case AND the "key added post-boot" case.

    // 2d. Bridge connector status transitions to the pending-reconcile
    //     tracker. Every `connector.status_changed` (composio toolkit
    //     finished OAuth, credential revoked, etc.) marks every
    //     thread whose profile declares that connector. The next turn
    //     for those threads runs the reconcile and the agent's tool
    //     list reflects the new state. Threads on unrelated profiles
    //     stay untouched. Subscription lifetime = gateway lifetime;
    //     unsubscribe handle intentionally dropped.
    this.connectorStatusBus.subscribe((event) => {
      try {
        const connectorId = event.connectorId
        const source = event.source
        for (const thread of this.state.listThreads(undefined, { limit: 10_000 }).items) {
          // Only mark threads whose profile declares this connector.
          // Skip threads that have never born a session (no initial
          // managed snapshot → nothing to reconcile against).
          if (!this.pendingReconciles.getManaged(thread.id)) continue
          let profile
          try { profile = this.registry.getCached(thread.profileId) }
          catch { continue }
          if (!profile) continue
          const declares = this.profileDeclaresConnector(profile, source, connectorId)
          if (declares) this.pendingReconciles.mark(thread.id)
        }
      } catch (err) {
        // Bus subscriber errors must never bring down the gateway or
        // the event fan-out. Log and continue.
        console.error('[ownware] pending-reconcile bus subscriber error:', err)
      }
    })

    bootLap('connector reconcile bus setup')

    // Recover upload staging before any route can accept more bytes. Bytes
    // beyond a durable SQLite checkpoint are crash residue and are truncated;
    // a shorter file remains untouched so the next scoped write reports the
    // explicit storage-inconsistent state rather than inventing progress.
    const sourceRecoveryStore = new SourceUploadStore(this.state.rawDbHandle, this.sourceQuota)
    const sourceRecoveryBytes = new SourceByteStore(
      join(this.opts.dataDir, 'source-storage'),
    )
    const inconsistentUploads = await sourceRecoveryBytes.recoverOpenUploads(
      sourceRecoveryStore.listOpenCheckpoints(),
    )
    if (inconsistentUploads.length > 0) {
      console.warn(
        `[ownware] source uploads: ${inconsistentUploads.length} open upload(s) have fewer staged bytes than their durable checkpoint`,
      )
    }
    bootLap('source upload recovery')

    const sourceJobRecovery = new SourceJobStore(
      this.state.rawDbHandle,
      this.sourceQuota,
    ).recoverExpiredClaims()
    if (sourceJobRecovery.requeued > 0 || sourceJobRecovery.failed > 0 ||
        sourceJobRecovery.cancelled > 0) {
      console.log(
        `  source jobs: recovered ${sourceJobRecovery.requeued} queued, ` +
        `${sourceJobRecovery.failed} failed, ${sourceJobRecovery.cancelled} cancelled`,
      )
    }
    bootLap('source job recovery')

    const sourceDataViewRecovery = new SourceDataViewStore(
      this.state.rawDbHandle,
      this.sourceQuota,
    ).recoverExpiredClaims()
    if (sourceDataViewRecovery.requeued > 0 || sourceDataViewRecovery.failed > 0) {
      console.log(
        `  source Data Views: recovered ${sourceDataViewRecovery.requeued} queued, ` +
        `${sourceDataViewRecovery.failed} failed`,
      )
    }
    bootLap('source Data View recovery')

    const sourceDeletionStore = new SourceDeletionStore(
      this.state.rawDbHandle, this.evidenceSearchCache,
    )
    const sourceDeletionRecovery = sourceDeletionStore.recoverExpiredClaims()
    if (sourceDeletionRecovery.requeued > 0 || sourceDeletionRecovery.partial > 0) {
      console.log(
        `  source deletion: recovered ${sourceDeletionRecovery.requeued} queued, ` +
        `${sourceDeletionRecovery.partial} partial`,
      )
    }
    bootLap('source deletion recovery')

    // Channel procedures (CC1): reclaim leases a crashed run left behind.
    // Parked consent gates (`waiting_for_input`) survive untouched — an
    // unanswered gate waits for its person, never times out into approval.
    // The worker itself starts with the channel procedures (CC3).
    this.channelJobStore = new ChannelJobStore(this.state.rawDbHandle)
    const channelJobRecovery = this.channelJobStore.recoverExpiredClaims()
    if (channelJobRecovery.requeued > 0 || channelJobRecovery.failed > 0 ||
        channelJobRecovery.cancelled > 0) {
      console.log(
        `  channel jobs: recovered ${channelJobRecovery.requeued} queued, ` +
        `${channelJobRecovery.failed} failed, ${channelJobRecovery.cancelled} cancelled`,
      )
    }
    this.channelProcedures = new ChannelProcedureRegistry()
    this.channelJobWorker = new ChannelJobWorker(
      this.channelJobStore,
      this.channelProcedures,
      { workerId: `gateway-channels-${process.pid}` },
    )
    bootLap('channel job recovery')

    if (this.opts.sourceWorkerEnabled) {
      this.sourceJobWorker = new SourceJobWorker(
        new SourceJobStore(this.state.rawDbHandle, this.sourceQuota),
        sourceRecoveryBytes,
        { workerId: `gateway-${process.pid}` },
        new SourceDataViewStore(this.state.rawDbHandle, this.sourceQuota),
      )
      this.sourceJobWorker.start()
      this.sourceDeletionWorker = new SourceDeletionWorker(
        sourceDeletionStore,
        sourceRecoveryBytes,
        { workerId: `gateway-deletion-${process.pid}` },
      )
      this.sourceDeletionWorker.start()
    }
    bootLap('source job worker')

    // 3. Register routes
    this.registerRoutes()
    bootLap('registerRoutes')

    // 3b. Boot the team vertical: re-register every team's conductor
    //     profile (in-memory registrations don't survive restarts) and
    //     resume runs that were active when the gateway last stopped —
    //     orphaned tasks re-queue, conductor sessions rebuild from
    //     their file checkpoints. Must run AFTER profile discovery
    //     (member profile lookups) and route registration (the module
    //     is constructed there).
    if (this.teamModule !== null) {
      try {
        await this.teamModule.boot()
      } catch (err) {
        console.error('[team] module boot failed (teams unavailable this session):', err)
      }
    }
    bootLap('team module boot')

    // 4. Start the HTTP server. Transport-agnostic request handler — the
    //    Router only uses the surface shared by http and http2-compat
    //    (url/method/headers/writeHead/write/end). HTTP/2 compat mode hands
    //    Http2ServerRequest/Response; with allowHTTP1:true an HTTP/1.1 client
    //    yields the http.* types; plain mode (tls:false) yields http.* too.
    //    We bridge the nominal types at this single seam rather than
    //    threading a union through ~50 handlers.
    const requestListener = (
      req: IncomingMessage,
      res: ServerResponse,
    ): void => {
      const start = Date.now()
      this.router.handle(req, res).catch(_err => {
        console.error('[ownware] unhandled gateway request failure')
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error', 'internal_error')
        }
      }).finally(() => {
        if (this.accessLogger) {
          this.accessLogger.log(req, res, Date.now() - start)
        }
      })
    }

    if (this.opts.tls) {
      // HTTP/2-over-TLS (desktop). TLS is required for browser h2;
      // self-signed loopback cert (./tls.ts). `allowHTTP1: true` lets any
      // HTTP/1.1-only client connect and fall back gracefully. HTTP/2
      // multiplexes unlimited streams over one connection — the fix for the
      // browser's 6-conn-per-origin stall (gateway-perf-2026-06-13).
      const tls = ensureGatewayCert(join(this.opts.dataDir, 'tls'))
      this._tlsFingerprint = tls.fingerprint256
      this.server = createSecureServer(
        { key: tls.key, cert: tls.cert, allowHTTP1: true },
        requestListener as unknown as Parameters<typeof createSecureServer>[1],
      )
    } else {
      // Plain HTTP/1.1: the test harness and the BYO-cloud packaging (where
      // a platform proxy terminates TLS upstream). No browser involved, so
      // no 6-conn stall to fix here.
      this.server = createServer(requestListener)
    }

    // 5. Register signal handlers for graceful shutdown
    const onSignal = () => { this.stop().catch(() => {}) }
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)

    return new Promise<void>((resolvePromise, reject) => {
      this.server!.on('error', reject)
      this.server!.listen(this.opts.port, this.opts.host, () => {
        bootLap('LISTENING (now accepting requests)')
        const scheme = this.opts.tls ? 'https' : 'http'
        console.log(`Ownware gateway running on ${scheme}://${this.opts.host}:${this.port}`)
        // Publish our OWN reachable address so in-process profile tools (the
        // builder's list_capabilities / propose_agent / suggest_agents and the
        // gatherer's scan_connectors) call the live gateway instead of a stale
        // hardcoded `http://127.0.0.1:3011`. Uses the real bound port
        // (`this.port`, which may have drifted off the requested one) and the
        // actual scheme (https by default). See profiles/_shared/gateway-self.ts.
        process.env.OWNWARE_GATEWAY = `${scheme}://${this.opts.host}:${this.port}`
        // Write a pidfile so the next launch's gateway-supervisor can
        // detect + reclaim an orphaned gateway whose parent Electron
        // died without sending SIGTERM. Without this, an old gateway
        // child reparents to launchd and squats on the default port,
        // forcing the new launch to fall through to 3012, 3013, … —
        // splitting the user's app state across two listeners.
        // The supervisor's reclaim is gated on a `/api/v1/health`
        // probe to ensure we never SIGTERM a non-Ownware process that
        // happens to live on our default port.
        try {
          const pidfilePath = join(this.opts.dataDir, 'gateway.pid')
          writeFileSync(
            pidfilePath,
            JSON.stringify({
              pid: process.pid,
              port: this.port,
              host: this.opts.host,
              // The desktop client's Electron main process pins this to
              // trust ONLY our loopback cert. 'scheme' marks the transport so the
              // supervisor + renderer build the right URL.
              scheme: this.opts.tls ? 'https' : 'http',
              tlsFingerprint256: this._tlsFingerprint,
              startedAt: new Date().toISOString(),
            }) + '\n',
            { mode: 0o600 },
          )
        } catch (err) {
          console.error(
            `[gateway] could not write pidfile: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        // Start the agent_events retention schedule. Env-gated — the
        // default-disabled config makes this a no-op until an operator
        // sets OWNWARE_EVENT_RETENTION_ENABLED=true. Clients MUST be
        // hydrating from /hydrate (not raw events) before retention is
        // turned on, or archived threads go blank. See gateway/CLAUDE.md.
        const retentionConfig = loadRetentionConfig()
        this.stopRetention = startRetentionSchedule(
          this.state.rawDatabase,
          this.state.eventBus,
          retentionConfig,
          stats => {
            this.lastRetentionStats = stats
            if (stats.rowsDeleted > 0) {
              console.log(
                `[retention] pruned ${stats.rowsDeleted} agent_events rows across ${stats.threadsPruned} terminal threads (cutoff ${stats.cutoffIso})`,
              )
            }
          },
        )

        // Warm the Composio connector catalogue in the background, then keep it
        // warm on an interval. This is what makes the connector list (the
        // builder's list_capabilities, the Tools lobby) ALWAYS ready and never
        // time out on a cold Composio fetch — the cache serves the last-good
        // list while it refreshes. Fire-and-forget; the cache swallows its own
        // errors. The interval (4m) sits under the 5m cache TTL so the list
        // stays fresh even when idle.
        void this.composioCatalogCache?.warm()
        const warmTimer = setInterval(() => {
          void this.composioCatalogCache?.warm()
        }, 4 * 60_000)
        // Never keep the process alive just for this timer.
        if (typeof warmTimer.unref === 'function') warmTimer.unref()
        this.stopCatalogWarm = () => clearInterval(warmTimer)

        resolvePromise()
      })
    })
  }

  /** The schedules store (read by the schedules API + tests). */
  get schedules(): SqliteScheduleStore {
    if (this.scheduleStore === null) {
      throw new Error('Gateway not started: schedules store unavailable')
    }
    return this.scheduleStore
  }

  /**
   * Enable channel connect procedures (CC3). Registers the per-channel
   * plugins against the given credential resolver and starts the channel
   * job worker. Called by `ownware serve` once the shuttle channel store
   * is available; idempotent. The resolver seam keeps the credential-
   * location decision (board §9.2) out of the procedures themselves.
   */
  enableChannelProcedures(
    resolver: ChannelCredentialResolver,
    opts: { readonly publicBaseUrl?: string } = {},
  ): void {
    if (!this.channelProcedures || !this.channelJobWorker) {
      throw new Error('Gateway not started: channel procedures unavailable')
    }
    if (this.channelProcedures.size > 0) return
    const publicBaseUrl = opts.publicBaseUrl ?? process.env.OWNWARE_WEBHOOK_PUBLIC_URL
    this.channelProcedures.register(createWhatsAppConnectProcedure({
      credentials: resolver,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    }))
    this.channelJobWorker.start()
  }

  /** Run one schedule sweep now (manual trigger / tests). */
  async tickSchedulesOnce(): Promise<void> {
    await this.scheduleRunner?.tickOnce()
  }

  /** Await in-flight scheduled dispatches (tests / graceful drain). */
  async drainSchedules(): Promise<void> {
    await this.scheduleRunner?.drain()
  }

  /**
   * Stop the gateway gracefully.
   * Saves session state, flushes access log, stops rate limiter, closes HTTP server + DB.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    if (this.sourceJobWorker) {
      await this.sourceJobWorker.stop()
      this.sourceJobWorker = null
    }
    if (this.channelJobWorker) {
      await this.channelJobWorker.stop()
      this.channelJobWorker = null
    }
    if (this.sourceDeletionWorker) {
      await this.sourceDeletionWorker.stop()
      this.sourceDeletionWorker = null
    }
    this.evidenceSearchCache.clear()

    // Close the bridge-catalog fs watcher (Phase 9). `persistent: false`
    // already keeps it from blocking exit; this just releases the handle
    // cleanly during graceful shutdown.
    if (this.bridgeCatalogStop !== null) {
      try {
        this.bridgeCatalogStop()
      } catch {
        // Best-effort — don't prevent shutdown
      }
      this.bridgeCatalogStop = null
    }

    // Abort in-flight team member sessions BEFORE draining the runner —
    // member loops are scheduler-owned (not in the runner's map) and
    // must not outlive the gateway. Board state is already durable;
    // the resume path re-queues their tasks on next boot.
    try {
      this.teamModule?.shutdown()
    } catch {
      // Best-effort — don't prevent shutdown
    }

    // Drain all active background runs. Abort them first so they
    // don't block shutdown waiting for HITL or tool execution.
    try {
      await this.runner.drainAll(/* abortFirst */ true)
    } catch {
      // Best-effort — don't prevent shutdown
    }

    // 2026-04-11 audit Hazard 21 fix: tear down every live MCP child
    // process before we close the HTTP server. Without this, killing
    // the gateway leaves orphaned `npx @modelcontextprotocol/server-*`
    // processes hanging around in the user's process list. We await
    // shutdown so SIGTERM has a chance to land before our own process
    // exits.
    try {
      await this.state.shutdownAllMCPManagers()
    } catch {
      // Best-effort — don't prevent shutdown
    }

    // Tear down every managed Chrome spawned via `browser.autoLaunch`.
    // Same rationale as MCP shutdown above: without this, SIGTERM on the
    // gateway leaves Chrome processes running in the user's process list
    // with temp user-data-dirs that are never cleaned up. We also tear
    // down any deferred launchers — sessions that registered a launcher
    // but never triggered it get an idempotent no-op kill, keeping the
    // shutdown path uniform across lazy and eager code paths.
    try {
      await this.state.shutdownAllChromeLaunches()
    } catch {
      // Best-effort — don't prevent shutdown
    }
    try {
      await this.state.shutdownAllChromeLaunchers()
    } catch {
      // Best-effort — don't prevent shutdown
    }

    // Kill every live PTY session. Without this, SIGTERM on the
    // gateway leaves orphan shell processes running under the user's
    // account, each one holding onto the workspace's cwd file handles.
    try {
      this.terminalRegistry.shutdown()
    } catch {
      // Best-effort — don't prevent shutdown
    }

    // Stop the retention timer so it doesn't fire after shutdown.
    if (this.stopRetention !== null) {
      this.stopRetention()
      this.stopRetention = null
    }
    // Stop the schedule ticker so it doesn't fire after shutdown.
    this.scheduleRunner?.stop()
    if (this.stopCatalogWarm !== null) {
      this.stopCatalogWarm()
      this.stopCatalogWarm = null
    }

    // Cancel every in-flight connection poll so timers don't keep
    // the event loop alive past close.
    try {
      this.connectionCompletionManager.cancelAll()
    } catch {
      // Best-effort — never block shutdown
    }
    try {
      let cleanupFailures = 0
      for (const pending of this.connectorConnections.findPending()) {
        const handle = connectionSessionHandle(pending.metadata)
        if (handle === null) continue
        try {
          await this.connectionSessions.remove(handle)
          this.connectorConnections.markExpired(
            pending.connectionId,
            'Connection attempt was interrupted by gateway shutdown. Please retry.',
          )
        } catch {
          cleanupFailures += 1
        }
      }
      if (cleanupFailures > 0) {
        console.warn(
          `[ownware] connector connection session cleanup will retry on next boot (${cleanupFailures} row(s))`,
        )
      }
    } catch {
      // The encrypted session remains referenced by its pending row and
      // boot cleanup retries; shutdown itself must still proceed.
    }

    // Tear down the Composio runtime (releases the status-bus
    // subscription, unregisters the completion listener). Idempotent
    // when Composio was never wired.
    if (this.composioStatusBusUnsub !== null) {
      try { this.composioStatusBusUnsub() } catch { /* shutdown best-effort */ }
      this.composioStatusBusUnsub = null
    }
    this.connectionCompletionManager.unregisterListener('composio')

    // Tell every open SSE stream this is an intentional restart before
    // we close the underlying sockets, then drop connector subscribers
    // so no listeners keep the process alive.
    await this.state.notifyShutdown()
    this.connectorStatusBus.clear()
    this.credentialEventBus.clear()
    this.workspaceEventBus.clear()

    // Stop rate limiter cleanup timer
    if (this.rateLimiter) {
      this.rateLimiter.stop()
    }

    // Flush and close access log
    if (this.accessLogger) {
      await this.accessLogger.close()
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolvePromise, reject) => {
        this.server!.close(err => {
          if (err) reject(err)
          else resolvePromise()
        })
      })
    }

    // Remove the pidfile so the next launch's supervisor doesn't try
    // to reclaim a gateway that no longer exists. Best-effort —
    // a stale pidfile is recoverable (the supervisor checks the PID
    // is alive before attempting any kill).
    try {
      unlinkSync(join(this.opts.dataDir, 'gateway.pid'))
    } catch {
      // ENOENT is the common case (already removed, or never written).
    }

    // Close database
    this.state.close()
  }

  /** Get the port the server is listening on. */
  get port(): number {
    const addr = this.server?.address()
    if (addr && typeof addr === 'object') return addr.port
    return this.opts.port
  }

  // ── MCP sync (agent.json → database) ────────────────────────────────

  /**
   * Sync MCP server configs from profile agent.json files into the
   * `mcp_servers` + `profile_mcp_servers` database tables. Runs on
   * startup so the MCP page has queryable data and so removed servers
   * don't linger in the DB after they've been pulled out of agent.json.
   *
   * Logic lives in the pure function `reconcileMCPServers`
   * (`./sync-mcp-servers.ts`) so it can be unit-tested without booting
   * the gateway. This wrapper just supplies live state + profile data.
   */
  private async syncMCPServers(): Promise<void> {
    const { reconcileMCPServers } = await import('./sync-mcp-servers.js')

    const profileEntries = this.registry.list()
    const profiles: Array<import('./sync-mcp-servers.js').ProfileForSync> = []

    for (const { name: profileId } of profileEntries) {
      try {
        const profile = await this.registry.get(profileId)
        profiles.push({
          id: profileId,
          mcp: profile.config.tools.mcp as Record<
            string,
            import('./sync-mcp-servers.js').MCPServerConfigForSync
          >,
        })
      } catch (err) {
        // Hazard 33 fix (2026-04-11): the previous catch swallowed every
        // error silently — a malformed agent.json was invisible until
        // the user tried to run it. Log the profile id + error so the
        // operator can find the broken file. The reconcile uses
        // `mcp: null` to mark a load failure so its assignments survive
        // (defensive: a transient read error must not delete user data).
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          `[ownware] syncMCPServers: skipping profile '${profileId}' — ${message}`,
        )
        profiles.push({ id: profileId, mcp: null })
      }
    }

    const result = reconcileMCPServers(profiles, this.state, {
      info: (msg) => console.log(msg),
    })

    if (
      result.createdServers > 0 ||
      result.removedAssignments > 0 ||
      result.removedOrphanedServers > 0
    ) {
      console.log(
        `[ownware] syncMCPServers: ${result.addedAssignments} assignment(s) ensured, ` +
          `${result.createdServers} server(s) created, ` +
          `${result.removedAssignments} stale assignment(s) removed, ` +
          `${result.removedOrphanedServers} orphaned server row(s) removed`,
      )
    }
  }

  // ── Route registration ─────────────────────────────────────────────

  private registerRoutes(): void {
    // All profile WRITE operations target the user dir. The bundled
    // `opts.profilesDir` is read-only and must never be mutated at runtime.
    const userProfilesDir = join(this.opts.dataDir, 'profiles')
    const candidateStore = new CandidateStore(this.state.rawDbHandle)
    const sourceStore = new SourceStore(this.state.rawDbHandle, this.sourceQuota)
    const sourceUploadStore = new SourceUploadStore(
      this.state.rawDbHandle, this.sourceQuota, this.evidenceSearchCache,
    )
    const sourceJobStore = new SourceJobStore(this.state.rawDbHandle, this.sourceQuota)
    const sourceDataViewStore = new SourceDataViewStore(
      this.state.rawDbHandle, this.sourceQuota,
    )
    const sourceByteStore = new SourceByteStore(join(this.opts.dataDir, 'source-storage'))
    const accessGrantStore = new AccessGrantStore(
      this.state.rawDbHandle, undefined, this.evidenceSearchCache,
    )
    const accessGrantHandlers = createAccessGrantHandlers({
      grants: accessGrantStore,
      idempotency: this.runIdempotency,
      authEnabled: !this.authDisabled,
    })
    const protectedSourceReads = new ProtectedSourceReadService(
      accessGrantStore,
      new AccessGrantEvaluator(accessGrantStore),
      sourceByteStore,
      // The exact current lineage/availability/deletion join is the first
      // source-read hard floor. Policy-reference labels are metadata, not
      // authority; future enforced policy may replace this producer.
      () => ({ decision: 'allow' }),
    )
    const protectedSourceSearches = new ProtectedSourceSearchService(
      accessGrantStore,
      new AccessGrantEvaluator(accessGrantStore),
      sourceByteStore,
      this.evidenceSearchCache,
      () => ({ decision: 'allow' }),
    )
    const protectedDataViewSelections = new ProtectedDataViewSelectionService(
      sourceDataViewStore,
      new AccessGrantEvaluator(accessGrantStore),
      sourceByteStore,
      // The strict current source/version/job/view lifecycle join is the
      // deployed Data View floor. Policy-reference labels remain metadata;
      // an enforced runtime policy producer must replace this callback before
      // the public contract can claim policy-rule denial.
      () => ({ decision: 'allow' }),
    )
    candidateStore.recoverInterrupted()
    const candidateResolver = new CandidateProfileResolver({
      candidatesRoot: join(this.opts.dataDir, 'profile-candidates'),
      store: candidateStore,
    })
    const candidateStager = new CandidateStager({
      candidatesRoot: join(this.opts.dataDir, 'profile-candidates'),
      store: candidateStore,
    })
    const candidateRetirer = new CandidateRetirer({
      candidatesRoot: join(this.opts.dataDir, 'profile-candidates'),
      store: candidateStore,
    })
    const candidateActivator = new CandidateActivator({
      store: candidateStore,
      resolver: candidateResolver,
    })
    const candidateDeployment = new CandidateDeploymentManager({
      store: candidateStore,
      resolver: candidateResolver,
      activeRunCount: (profileId) => this.runStore.countActiveForProfile(profileId),
    })
    const profiles = createProfileHandlers(
      this.registry,
      userProfilesDir,
      this.state,
      this.pendingReconciles,
      candidateStore,
    )
    const skills = createSkillHandlers(this.registry, userProfilesDir)
    const threads = createThreadHandlers(this.state, { runner: this.runner })

    // Build connector handlers EARLY so its `registry` is available
    // when we wire the connectors() agent-tool provider into the
    // assembler's toolProviders list (Phase 5-B.2). One
    // ConnectorRegistry instance — same source-of-truth across the
    // /connectors HTTP endpoint AND the agent's `connectors(action,
    // query?)` tool. No drift between dialog search and agent search.
    // Always register the Composio source proxy — its inner delegate
    // is null until COMPOSIO_API_KEY is configured, at which point
    // `applyComposioKey` swaps it in. This keeps the registry stable
    // across runtime credential changes (no addSource/removeSource
    // dance from the bus subscriber).
    const additionalSources = [this.composioSourceProxy]
    const connectorHandlers = createConnectorHandlers({
      profileRegistry: this.registry,
      settings: this.state,
      webSearchService: this.webSearchService,
      statusBus: this.connectorStatusBus,
      additionalSources,
      // Wire the same proxy as the dedicated paginated source so the
      // handler's `?source=composio` branch can call `listPage()`
      // without digging through the registry.
      composioSource: this.composioSourceProxy,
      sourcePreferences: this.sourcePreferences,
      // T04 — expose the state layer so CustomMCPSourceProvider can
      // surface API-registered custom MCP servers in /connectors +
      // /catalog.
      customMCPState: this.state,
      // F4.c-2 — let the registry's MCP projection read
      // `connector_connections.last_verified_at` (written by
      // `ComposioReconciler.touchVerified()`). Composio's source
      // projects this directly from the row it already holds, so
      // this lookup is consulted only on the MCP path today.
      lastVerifiedAtLookup: (id, source) =>
        this.connectorConnections.findLastVerifiedAt(id, source),
    })

    // Capture the provider list once so run-handler (fresh assembly)
    // and SessionRunner's reconcileDeps (live reconcile) use the
    // EXACT same set. Assembly and reconcile must never drift —
    // drift would mean "the tool the agent can call" silently
    // differs from "the tool the reconcile thinks exists."
    //
    // Phase 5-B.2 (2026-05-06): the unified `connectors()` agent
    // tool provider is appended unconditionally so every profile
    // session gets the tool. Composio's provider stays first (older
    // wiring); deterministic order across the array.
    // The previous `enabledSourcesProvider` closure fed the connectors()
    // agent tool's `search` action so the suggestion banners reflected
    // the user's Settings → Advanced toggles live. Search retired
    // 2026-05-12; the closure is no longer wired here. The registry-
    // source provider's own enabled gate (which determines whether
    // registry entries appear in the catalog at all) is wired
    // separately inside `createConnectorHandlers`.
    const toolProviders: readonly ConnectorToolProvider[] = [
      // Always-present proxy (see composioSourceProxy comment above).
      // Empty result when inner is null; swapped on credential change.
      this.composioToolProviderProxy,
      new ConnectorsToolProvider({
        registry: connectorHandlers.registry,
      }),
      // connect_channel (CC3): contributes the channel-connect tool once
      // enableChannelProcedures() has registered plugins (registry read
      // lazily per assembly, so late enabling still takes effect).
      new ChannelConnectToolProvider({
        jobs: this.channelJobStore!,
        procedures: this.channelProcedures!,
        wake: () => this.channelJobWorker?.wake(),
      }),
    ]
    const run = createRunHandlers(this.state, this.registry, this.runner, {
      runStore: this.runStore,
      idempotencyStore: this.runIdempotency,
      candidateResolver,
      candidateStore,
      webSearchService: this.webSearchService,
      taskStore: this.taskStore,
      credentialStore: this.credentialStore,
      terminalRegistry: this.terminalRegistry,
      pendingReconciles: this.pendingReconciles,
      memorySystem: this.memorySystem,
      // F4.b: route MCPManager state-change events through the same
      // bus the `/api/v1/connectors/events` SSE channel reads. Without
      // this wire, transport closes never hit the client's connector
      // card (audit #4).
      connectorStatusBus: this.connectorStatusBus,
      ...(toolProviders.length > 0 ? { toolProviders } : {}),
      // Draft-for-approval: a scheduled draft-approval run parks held write/send
      // tool calls here instead of executing them (Slice 8d).
      ...(this.approvalStore != null ? { approvalStore: this.approvalStore } : {}),
    })
    // Per-profile scheduling engine. Constructed here where
    // `run.startProfileRun` exists (the schedules store was built in the
    // boot store block). It boot-sweeps + ticks (~60s, .unref'd) and is
    // stopped on shutdown. With no schedules yet it sweeps an empty table.
    if (this.scheduleStore !== null) {
      this.scheduleRunner = new ScheduleRunner({
        store: this.scheduleStore,
        startProfileRun: run.startProfileRun,
        isRunning: (threadId) => this.runner.isRunning(threadId),
        // A clean run that parked ≥1 draft is classified 'needs-approval' (8d).
        ...(this.approvalStore != null
          ? { pendingApprovalsForRun: (runId: string): number => this.approvalStore!.countPendingForRun(runId) }
          : {}),
        // Outbound delivery (Slice 8): payload from the consolidated
        // messages snapshot; sink looked up per delivery so the host can
        // register it after boot (setScheduleDeliverySink).
        delivery: {
          finalText: (threadId: string): string | null => {
            try {
              const messages = this.state.getMessages(threadId)
              for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i]!
                if (m.role === 'assistant' && m.content.trim().length > 0) return m.content
              }
              return null
            } catch {
              return null // unreadable thread → status-line fallback text
            }
          },
          sink: () => this.scheduleDeliverySink,
        },
      })
      this.scheduleRunner.start()
    }

    // Install reconcile deps on the runner now that providers +
    // registry are fully resolved. Runs before any turn dispatch
    // because `registerRoutes` is called before `router.handle`
    // starts taking requests.
    this.runner.setReconcileDeps({
      pending: this.pendingReconciles,
      profileRegistry: this.registry,
      toolProviders,
    })
    // Attribute each finished run's real cost back to the backing LLM
    // credential. Fire-and-forget — the lookup is async and the sink
    // owns its own error routing; a failure here must never disturb the
    // run's completion path.
    this.runner.setLlmCostSink(({ model, costUsd, threadId }) => {
      void this.attributeLlmCostToCredential(model, costUsd, threadId)
    })
    // Agent Teams vertical. Same toolProviders as run-handler assembly
    // so member sessions see the exact tool set a solo session would.
    this.teamModule = new TeamModule({
      state: this.state,
      registry: this.registry,
      runner: this.runner,
      dataDir: this.opts.dataDir,
      toolProviders,
    })
    const teams = createTeamHandlers(this.teamModule)
    const tasks = createTaskHandlers({ store: this.taskStore, bus: this.taskEventBus })
    const schedules = createScheduleHandlers({
      store: this.schedules,
      runNow: (id) => this.scheduleRunner?.runNow(id) ?? Promise.resolve(null),
    })
    // Approvals inbox: read surface + discard (8d-3) + approve→execute (8d-4).
    // approve re-executes the EXACT held call via run.executeHeldTool with the
    // user's credentials; needs the schedule store (to resolve profile/workspace).
    const approvals =
      this.approvalStore != null && this.scheduleStore != null
        ? createApprovalHandlers({
            store: this.approvalStore,
            scheduleStore: this.scheduleStore,
            executeHeldTool: run.executeHeldTool,
          })
        : null
    const memory = createMemoryHandlers({ system: this.memorySystem })
    const tools = createToolHandlers(this.registry)
    const mcp = createMCPHandlers(this.registry, this.state, {
      statusBus: this.connectorStatusBus,
      userProfilesDir,
      pendingReconciles: this.pendingReconciles,
    })
    const debug = createDebugHandlers(this.state)
    const workspaces = createWorkspaceHandlers(this.state, {
      terminalRegistry: this.terminalRegistry,
      eventBus: this.workspaceEventBus,
    })
    const dashboard = createDashboardHandlers(this.state)
    const settings = createSettingsHandlers(this.state)
    const providers = createProviderHandlers({
      store: this.credentialStore,
      resolver: this.credentialResolver,
      injector: this.credentialInjector,
    })
    const transcribe = createTranscribeHandlers({ store: this.credentialStore })
    const searchHandlers = createSearchHandlers(this.state, this.registry)
    const activity = createActivityHandlers(this.state)
    const agentEvents = createAgentEventHandlers(this.state, this.runStore)
    const permissions = createPermissionHandlers(this.state)
    const principals = createPrincipalHandlers({
      state: this.state,
      registry: this.registry,
      service: this.principalService,
      authEnabled: !this.authDisabled,
      candidateStore,
    })

    // Health
    this.router.get('/api/v1/health', healthHandler)
    // Deliberate public contract discovery. This is not a route inventory.
    this.router.get(
      '/api/v1/capabilities',
      createCapabilitiesHandler(() => this.rateLimiter?.limits ?? {
        enabled: false,
        windowSeconds: 60,
        generalRequests: 0,
        runStarts: 0,
      }, this.sourceQuota.limits),
      { operation: 'gateway.capabilities' },
    )
    this.router.get(
      '/api/v1/connections',
      createConnectionInventoryHandler({
        connections: this.connectorConnections,
        entityId: this.installIdentity.id,
        authEnabled: !this.authDisabled,
      }),
      { operation: 'connections.list' },
    )
    const connectionLifecycle = createConnectionLifecycleHandlers({
      authEnabled: !this.authDisabled,
    })
    this.router.post(
      '/api/v1/connections',
      connectionLifecycle.start,
      { operation: 'connections.start' },
    )
    this.router.post('/api/v1/auth/delegations', principals.issue)
    this.router.post('/api/v1/auth/delegations/:tokenId/revoke', principals.revoke)
    this.router.post(
      '/api/v1/sources',
      createRegisterSourceHandler(sourceStore, this.runIdempotency),
      { operation: 'sources.register' },
    )
    this.router.get(
      '/api/v1/sources',
      createListSourcesHandler(sourceStore),
      { operation: 'sources.list' },
    )
    this.router.get(
      '/api/v1/sources/:sourceId',
      createGetSourceHandler(sourceStore),
      { operation: 'sources.read' },
    )
    const sourceDeletionStore = new SourceDeletionStore(
      this.state.rawDbHandle, this.evidenceSearchCache,
    )
    this.router.post(
      '/api/v1/sources/:sourceId/deletions',
      createSourceDeletionHandler(
        sourceDeletionStore,
        this.runIdempotency,
        () => this.sourceDeletionWorker?.wake(),
      ),
      { operation: 'source_deletions.create' },
    )
    this.router.get(
      '/api/v1/source-deletions/:jobId',
      createGetSourceDeletionHandler(sourceDeletionStore),
      { operation: 'source_deletions.read' },
    )
    this.router.post(
      '/api/v1/source-deletions/:jobId/cancel',
      createCancelSourceDeletionHandler(
        sourceDeletionStore,
        () => this.sourceDeletionWorker?.wake(),
      ),
      { operation: 'source_deletions.cancel' },
    )
    this.router.post(
      '/api/v1/source-deletions/:jobId/retry',
      createRetrySourceDeletionHandler(
        sourceDeletionStore,
        () => this.sourceDeletionWorker?.wake(),
      ),
      { operation: 'source_deletions.retry' },
    )
    this.router.post(
      '/api/v1/sources/:sourceId/upload-sessions',
      createSourceUploadSessionHandler(
        sourceStore, sourceUploadStore, this.runIdempotency,
      ),
      { operation: 'source_uploads.create' },
    )
    this.router.patch(
      '/api/v1/source-uploads/:uploadId',
      createWriteSourceUploadChunkHandler(sourceUploadStore, sourceByteStore),
      { operation: 'source_uploads.write' },
    )
    this.router.post(
      '/api/v1/source-uploads/:uploadId/complete',
      createCompleteSourceUploadHandler(sourceUploadStore, sourceByteStore),
      { operation: 'source_uploads.complete' },
    )
    this.router.get(
      '/api/v1/sources/:sourceId/versions/:sourceVersionId',
      createGetSourceVersionHandler(sourceUploadStore),
      { operation: 'source_versions.read' },
    )
    this.router.post(
      '/api/v1/sources/:sourceId/versions/:sourceVersionId/jobs',
      createSourceJobHandler(
        sourceJobStore,
        this.runIdempotency,
        () => this.sourceJobWorker?.wake(),
      ),
      { operation: 'source_jobs.create' },
    )
    this.router.post(
      '/api/v1/sources/:sourceId/versions/:sourceVersionId/preparations',
      createSourcePreparationHandler(
        sourceJobStore,
        sourceDataViewStore,
        this.runIdempotency,
        () => this.sourceJobWorker?.wake(),
      ),
      { operation: 'source_preparations.create' },
    )
    this.router.get(
      '/api/v1/source-resources/:resourceId',
      createGetSourceResourceHandler(sourceJobStore),
      { operation: 'source_resources.read' },
    )
    this.router.get(
      '/api/v1/source-data-views/:dataViewId',
      createGetSourceDataViewHandler(sourceDataViewStore),
      { operation: 'source_data_views.read' },
    )
    this.router.post(
      '/api/v1/source-data-views/:dataViewId/query',
      createSourceDataViewQueryHandler(protectedDataViewSelections),
      { operation: 'source_data_views.query' },
    )
    this.router.post(
      '/api/v1/source-resources/:resourceId/access-grants',
      accessGrantHandlers.create,
      { operation: 'access_grants.create' },
    )
    this.router.post(
      '/api/v1/source-data-views/:dataViewId/access-grants',
      accessGrantHandlers.createDataView,
      { operation: 'access_grants.create' },
    )
    this.router.get(
      '/api/v1/access-grants',
      accessGrantHandlers.list,
      { operation: 'access_grants.list' },
    )
    this.router.get(
      '/api/v1/access-grants/:grantId',
      accessGrantHandlers.read,
      { operation: 'access_grants.read' },
    )
    this.router.post(
      '/api/v1/access-grants/:grantId/revoke',
      accessGrantHandlers.revoke,
      { operation: 'access_grants.revoke' },
    )
    this.router.post(
      '/api/v1/source-resources/:resourceId/content',
      createReadSourceContentHandler(protectedSourceReads),
      { operation: 'source_content.read' },
    )
    this.router.post(
      '/api/v1/source-resources/:resourceId/content/search',
      createSearchSourceContentHandler(protectedSourceSearches),
      { operation: 'source_content.search' },
    )
    this.router.get(
      '/api/v1/source-jobs/:jobId',
      createGetSourceJobHandler(sourceJobStore, sourceDataViewStore),
      { operation: 'source_jobs.read' },
    )
    this.router.post(
      '/api/v1/source-jobs/:jobId/cancel',
      createCancelSourceJobHandler(
        sourceJobStore,
        sourceDataViewStore,
        () => this.sourceJobWorker?.wake(),
      ),
      { operation: 'source_jobs.cancel' },
    )
    this.router.post('/api/v1/candidates/validate', validateCandidate, { operation: 'candidates.validate' })
    this.router.post(
      '/api/v1/candidates/stage',
      createStageCandidateHandler(candidateStager),
      { operation: 'candidates.stage' },
    )
    this.router.post(
      '/api/v1/candidates/activate',
      createActivateCandidateHandler(candidateActivator),
      { operation: 'candidates.activate' },
    )
    this.router.post(
      '/api/v1/candidates/rollback',
      createRollbackCandidateHandler(candidateActivator),
      { operation: 'candidates.rollback' },
    )
    this.router.get(
      '/api/v1/profile-candidates/:candidateId',
      createGetCandidateHandler(candidateStore),
      { operation: 'candidates.read' },
    )
    this.router.delete(
      '/api/v1/profile-candidates/:candidateId',
      createDeleteCandidateHandler(candidateRetirer, candidateStore),
      { operation: 'candidates.delete' },
    )
    this.router.get(
      '/api/v1/profiles/:profileId/candidates',
      createListCandidatesHandler(candidateStore),
      { operation: 'candidates.list' },
    )
    this.router.get(
      '/api/v1/profiles/:profileId/deployment',
      createGetDeploymentHandler(candidateStore, this.runStore),
      { operation: 'profiles.deployment.read' },
    )
    this.router.post(
      '/api/v1/profiles/:profileId/pause',
      createPauseProfileHandler(candidateDeployment, this.runIdempotency),
      { operation: 'profiles.pause' },
    )
    this.router.post(
      '/api/v1/profiles/:profileId/resume',
      createResumeProfileHandler(candidateDeployment, this.runIdempotency),
      { operation: 'profiles.resume' },
    )
    // Canonical product catalog — cortex-owned, read by every client.

    // Multiplexed gateway invalidation SSE channel (production-perf
    // audit, 2026-05-17 → -18). One connection carries
    // `connector.status_changed`, `credential.changed`, and
    // `workspace.changed` envelopes — the three always-on app-root
    // channels the client used to open separately. Saves 2 HTTP/1.1 slots
    // per client window. The client's `useGatewayEvents` reads it and
    // routes each envelope through the existing coalescer. The
    // per-resource endpoints below (`/credentials/events`,
    // `/connectors/events`, `/workspaces/events`) stay registered for
    // back-compat; new clients should use this one.
    const gatewayEventsHandler = createGatewayEventsHandler({
      connectorBus: this.connectorStatusBus,
      credentialBus: this.credentialEventBus,
      workspaceBus: this.workspaceEventBus,
      // Team vertical hints (board changes, catalog changes) ride the
      // same multiplexed channel — constructed earlier in this method.
      ...(this.teamModule !== null ? { teamBus: this.teamModule.events } : {}),
      state: this.state,
    })
    this.router.get('/api/v1/events', gatewayEventsHandler.streamGatewayEvents)

    // Profiles
    this.router.get('/api/v1/profiles', profiles.listProfiles, { operation: 'profiles.list' })
    // Static `/profiles/zones` MUST precede `/profiles/:profileId` — the
    // router matches in registration order, so otherwise "zones" would be
    // captured as a profileId.
    this.router.get('/api/v1/profiles/zones', profiles.getAllProfileZones)
    this.router.get('/api/v1/profiles/:profileId', profiles.getProfile)
    this.router.get('/api/v1/profiles/:profileId/zones', profiles.getProfileZones)
    this.router.post('/api/v1/profiles', profiles.createProfile)
    this.router.put('/api/v1/profiles/:profileId', profiles.updateProfile)
    this.router.post('/api/v1/profiles/:profileId/reload', profiles.reloadProfile)
    this.router.post('/api/v1/profiles/generate', profiles.generateProfile)
    this.router.post('/api/v1/profiles/:profileId/files', profiles.uploadProfileFile)
    this.router.get('/api/v1/profiles/:profileId/files', profiles.listProfileFiles)
    this.router.delete('/api/v1/profiles/:profileId', profiles.deleteProfile)
    this.router.post('/api/v1/profiles/:profileId/duplicate', profiles.duplicateProfile)
    // Marketplace — preview / install / update / uninstall / index +
    // Ownware-curated bundle endpoints.
    const marketplace = createMarketplaceHandlers({
      dataDir: this.opts.dataDir,
      registry: this.registry,
      ownwareBundleDir: this.opts.profilesDir,
      canUninstallProfile: (profileId) =>
        candidateStore.getActive(profileId) === null &&
        this.runStore.countActiveForProfile(profileId) === 0 &&
        !this.state.hasActiveRuntime(profileId),
      ...(process.env['OWNWARE_BUNDLE_VERSION'] !== undefined
        ? { ownwareBundleVersion: process.env['OWNWARE_BUNDLE_VERSION'] }
        : {}),
    })
    this.router.post('/api/v1/marketplace/preview', marketplace.preview)
    this.router.post('/api/v1/marketplace/install', marketplace.install)
    this.router.get('/api/v1/marketplace/repos/:repoId/update', marketplace.checkUpdate)
    this.router.post('/api/v1/marketplace/repos/:repoId/update', marketplace.applyUpdate)
    this.router.delete('/api/v1/marketplace/repos/:repoId', marketplace.uninstall)
    this.router.get('/api/v1/marketplace/index', marketplace.index)
    // Ownware Verified — bundled marketplace items shipped with the app
    this.router.get('/api/v1/marketplace/ownware', marketplace.ownwareList)
    this.router.get('/api/v1/marketplace/ownware/:name', marketplace.ownwareDetail)
    this.router.post('/api/v1/marketplace/ownware/:name/install', marketplace.ownwareInstall)
    this.router.post('/api/v1/marketplace/ownware/:name/update', marketplace.ownwareUpdate)
    this.router.delete('/api/v1/marketplace/ownware/:name', marketplace.ownwareUninstall)
    // T03 — Composio toolkit attach/detach, parallel to /profiles/:id/mcp below.
    this.router.post('/api/v1/profiles/:profileId/composio', profiles.addComposioToProfile)
    this.router.delete('/api/v1/profiles/:profileId/composio/:toolkit', profiles.removeComposioFromProfile)
    // Skills — install via URL / pasted content / github-folder; toggle active;
    // remove by slug; browse a repo.
    this.router.post('/api/v1/profiles/:profileId/skills', skills.installSkill)
    this.router.patch('/api/v1/profiles/:profileId/skills/:slug', skills.setSkillActive)
    this.router.delete('/api/v1/profiles/:profileId/skills/:slug', skills.removeSkill)
    this.router.get('/api/v1/profiles/:profileId/skills/browse', skills.browseSkills)

    // Threads
    this.router.get('/api/v1/threads', threads.listThreads)
    this.router.post('/api/v1/threads', threads.createThread)
    this.router.get('/api/v1/threads/:threadId', threads.getThread)
    this.router.patch('/api/v1/threads/:threadId', threads.patchThread)
    this.router.delete('/api/v1/threads/:threadId', threads.deleteThread)
    this.router.get('/api/v1/threads/:threadId/messages', threads.getMessages)
    this.router.get('/api/v1/threads/:threadId/hydrate', threads.hydrateThread)
    this.router.get('/api/v1/threads/:threadId/export', threads.exportThread)

    // Ownware Design — per-design metadata (migration 033, slice 7b).
    // Plain REST over `designs` + `thread_designs`. No streaming.
    // Agent Teams (cortex/src/team/ vertical)
    this.router.get('/api/v1/teams', teams.listTeams)
    this.router.post('/api/v1/teams', teams.createTeam)
    this.router.get('/api/v1/teams/:teamId', teams.getTeam)
    this.router.patch('/api/v1/teams/:teamId', teams.updateTeam)
    this.router.delete('/api/v1/teams/:teamId', teams.deleteTeam)
    this.router.post('/api/v1/teams/:teamId/runs', teams.createRun)
    this.router.get('/api/v1/teams/:teamId/runs', teams.listRuns)
    this.router.get('/api/v1/threads/:threadId/team-board', teams.getBoardForThread)
    this.router.post('/api/v1/team-runs/:runId/cancel', teams.cancelRun)

    // Tasks — the agent's TODO list, written by Loom's `todo_write`
    // tool via a per-thread store adapter, surfaced here for the client
    // (workspace panels T03/T04). SSE stream carries
    // `tasks.updated` events with the full refreshed list.
    this.router.get('/api/v1/threads/:threadId/tasks', tasks.listTasks)
    this.router.patch('/api/v1/threads/:threadId/tasks/:taskId', tasks.updateTaskStatus)
    this.router.get('/api/v1/threads/:threadId/tasks/events', tasks.streamTaskEvents)

    // (The desktop workspace build-board HTTP surface was removed with the
    // legacy desktop shell. Agent Teams' board is separate — see team/.)

    // Per-profile scheduling ("Ownware Calendar") — CRUD + pause/resume +
    // run-now + run history.
    this.router.post('/api/v1/schedules', schedules.createSchedule)
    this.router.get('/api/v1/schedules', schedules.listSchedules)
    // Literal routes BEFORE the `:id` param route, or ":id" swallows them.
    this.router.get('/api/v1/schedules/occurrences', schedules.listOccurrences)
    this.router.get('/api/v1/schedules/runs', schedules.listRecentRuns)
    this.router.post('/api/v1/schedules/preview', schedules.previewSchedule)
    this.router.get('/api/v1/schedules/:id', schedules.getSchedule)
    this.router.patch('/api/v1/schedules/:id', schedules.updateSchedule)
    this.router.delete('/api/v1/schedules/:id', schedules.deleteSchedule)
    this.router.post('/api/v1/schedules/:id/pause', schedules.pauseSchedule)
    this.router.post('/api/v1/schedules/:id/resume', schedules.resumeSchedule)
    this.router.post('/api/v1/schedules/:id/run-now', schedules.runNowSchedule)
    this.router.get('/api/v1/schedules/:id/runs', schedules.listScheduleRuns)

    // Approvals inbox (Slice 8d-3). Literal `/count` BEFORE `/:id`.
    if (approvals != null) {
      this.router.get('/api/v1/approvals/count', approvals.countApprovals)
      this.router.get('/api/v1/approvals', approvals.listApprovals)
      this.router.get('/api/v1/approvals/:id', approvals.getApproval)
      this.router.post('/api/v1/approvals/:id/discard', approvals.discardApproval)
      this.router.post('/api/v1/approvals/:id/approve', approvals.approveApproval)
    }

    // Memory system — DB-backed continuous learning.
    // Memories are scoped per-profile; the user identity layer is global.
    // SSE channel ships invalidation hints only — clients refetch via
    // HTTP to read the data.
    this.router.get('/api/v1/profiles/:profileId/memories', memory.listMemories)
    this.router.post('/api/v1/profiles/:profileId/memories', memory.createMemory)
    this.router.patch('/api/v1/memories/:id', memory.updateMemory)
    this.router.delete('/api/v1/memories/:id', memory.deleteMemory)
    this.router.get('/api/v1/profiles/:profileId/memories/proposals', memory.listProposalsForProfile)
    this.router.get('/api/v1/threads/:threadId/memories/proposals', memory.listProposalsForThread)
    this.router.post('/api/v1/memories/proposals/:id/accept', memory.acceptProposal)
    this.router.post('/api/v1/memories/proposals/:id/reject', memory.rejectProposal)
    this.router.get('/api/v1/user/identity', memory.getIdentity)
    this.router.put('/api/v1/user/identity', memory.putIdentity)
    this.router.get('/api/v1/memory/events', memory.streamMemoryEvents)

    // (The desktop terminal-panel and files-panel HTTP surfaces were removed
    // with the legacy desktop shell. The agent PTY registry stays — it is the
    // engine-side substrate `shell_execute` persists into per workspace.)

    // Run — POST /run starts a background agent, returns { threadId }.
    // Client connects to GET /threads/:tid/agents/root/events for SSE.
    this.router.post('/api/v1/run', run.run, { operation: 'runs.start' })
    // Literal route must precede /runs/:runId or "active" is parsed as an ID.
    this.router.get('/api/v1/runs/active', run.listActiveRuns)
    this.router.get('/api/v1/runs/:runId', run.getRun, { operation: 'runs.snapshot' })
    this.router.get('/api/v1/runs/:runId/events', agentEvents.streamRunEvents, { operation: 'runs.events' })
    this.router.post('/api/v1/threads/:threadId/resume', run.resume, { operation: 'runs.resume.legacy' })
    this.router.post(
      '/api/v1/runs/:runId/permissions/:requestId/decision',
      run.decidePermission,
      { operation: 'runs.resume' },
    )
    this.router.post('/api/v1/runs/:runId/cancel', run.cancelRun, { operation: 'runs.abort' })
    this.router.post('/api/v1/threads/:threadId/abort', run.abort, { operation: 'runs.abort.legacy' })
    this.router.get('/api/v1/threads/:threadId/workspace-roots', run.listWorkspaceRoots)
    this.router.delete('/api/v1/threads/:threadId/workspace-roots', run.revokeWorkspaceRoot)

    // Credential HITL — the client POSTs the user's value here when the
    // agent yielded a credential.request. The handler encrypts-and-stores
    // into the vault, adds the handle to the per-thread runtime, and
    // resolves the blocked Promise so the agent loop resumes. See
    // packages/cortex/src/gateway/handlers/credentials.ts for the
    // response shape + security invariants (no value echo).
    const credentials = createCredentialHandlers(this.state)
    this.router.post('/api/v1/threads/:threadId/credential', credentials.respond)
    this.router.post('/api/v1/threads/:threadId/credential/deny', credentials.deny)
    this.router.get('/api/v1/threads/:threadId/credential/pending', credentials.list)

    // Unified credential store endpoints (board: credentials-unification —
    // C07/C08/C12–C16/C28/C30/C31–C33). Response shape is `Credential`
    // per the `credential/schema.ts` Zod schema — masked hint, never
    // plaintext. The audit log + trust gate are passed in so the
    // mutating handlers (validate, reveal, create, update, delete)
    // record audit rows, and the approve handler can resolve trust-gate
    // requests.
    //
    //   GET    /credentials               C07 — flat list, masked
    //   GET    /credentials/:id           C08 — one row, masked
    //   POST   /credentials               C12 — create (409 on duplicate)
    //   PATCH  /credentials/:id           C13 — tri-state patch incl. value rotation
    //   DELETE /credentials/:id           C14 — soft-delete; ?hard=true purges
    //   POST   /credentials/:id/validate  C15 — real provider call (LLM)
    //   POST   /credentials/:id/reveal    C16 — basic reveal; C30 hardens
    //   POST   /credentials/:id/approve   C30 — trust-gate response
    //   GET    /credentials/:id/audit     C31 — paginated audit log
    //   GET    /credentials/:id/cost      C32 — cost rollup (LLM)
    //   GET    /credentials/:id/usage     C33 — top consumers + call count
    const credentialStoreHandlers = createCredentialStoreHandlers(
      this.credentialStore,
      {
        audit: this.credentialAudit,
        trustGate: this.credentialTrustGate,
        eventBus: this.credentialEventBus,
      },
    )
    const credentialAuditHandlers = createCredentialAuditHandlers(
      this.credentialStore,
      this.credentialAudit,
    )
    this.router.get('/api/v1/credentials', credentialStoreHandlers.list)
    // Credential CRUD SSE channel (audit #5 H1, 2026-05-16). MUST be
    // registered BEFORE `GET /api/v1/credentials/:id` — the router
    // iterates in registration order and the `:id` pattern would
    // otherwise shadow `/events`, dispatching to `getOne` with
    // params.id === 'events' and returning a 400/404.
    const credentialEventsHandler = createCredentialEventsHandler({
      bus: this.credentialEventBus,
      state: this.state,
    })
    this.router.get(
      '/api/v1/credentials/events',
      credentialEventsHandler.streamCredentialEvents,
    )
    this.router.get('/api/v1/credentials/:id', credentialStoreHandlers.getOne)
    this.router.post('/api/v1/credentials', credentialStoreHandlers.create)
    this.router.patch('/api/v1/credentials/:id', credentialStoreHandlers.update)
    this.router.delete('/api/v1/credentials/:id', credentialStoreHandlers.remove)
    this.router.post('/api/v1/credentials/:id/validate', credentialStoreHandlers.validate)
    this.router.post('/api/v1/credentials/:id/reveal', credentialStoreHandlers.reveal)
    this.router.post('/api/v1/credentials/:id/approve', credentialStoreHandlers.approve)
    this.router.get('/api/v1/credentials/:id/audit', credentialAuditHandlers.listAudit)
    this.router.get('/api/v1/credentials/:id/cost', credentialAuditHandlers.cost)
    this.router.get('/api/v1/credentials/:id/usage', credentialAuditHandlers.usage)

    // Agent events — per-(thread, agent) replay + live tail.
    // Drives the client's "View thread" modal for sub-agents. The modal
    // opens a SECOND SSE connection here while the main chat continues
    // on POST /api/v1/run, so each agent's full event log can be
    // rendered independently.
    this.router.get('/api/v1/threads/:threadId/agents', agentEvents.listThreadAgents)
    this.router.get(
      '/api/v1/threads/:threadId/agents/:agentId/events',
      agentEvents.streamAgentEvents,
      { operation: 'runs.events' },
    )
    this.router.get('/api/v1/threads/:threadId/agents/:agentId/events/history', agentEvents.getAgentEventHistory)

    // Retention admin — force a retention pass and read the last result.
    // Intended for ops-driven cleanup and integration tests. Honours the
    // same env-gated config as the scheduler; if retention is disabled,
    // a POST still runs one pass (so tests can exercise the logic
    // without setting global env vars) but logs a hint.
    this.router.post('/api/v1/admin/retention/run', async (_req, res) => {
      try {
        const config = loadRetentionConfig()
        const effectiveConfig = config.enabled
          ? config
          : { ...config, enabled: true }
        const stats = runRetentionOnce(
          this.state.rawDatabase,
          this.state.eventBus,
          effectiveConfig,
        )
        this.lastRetentionStats = stats
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ config: effectiveConfig, stats }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: 'retention_failed',
          message: err instanceof Error ? err.message : String(err),
        }))
      }
    })
    this.router.get('/api/v1/admin/retention/status', async (_req, res) => {
      const config = loadRetentionConfig()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        config,
        lastStats: this.lastRetentionStats,
        eventRowCount: this.state.rawDatabase.countAgentEvents(),
      }))
    })

    // Permission history — full audit log of every permission decision
    // the user has made across every thread. Drives the client's Settings →
    // Permissions page.
    this.router.get('/api/v1/permissions', permissions.listPermissions)
    this.router.get('/api/v1/permissions/rules', permissions.listPermissionRules)
    // S6 (2026-05-14): the canonical write path for revoking saved
    // permission rules. The client's Settings → Permissions Rules tab uses
    // this; never writes to ~/.ownware/permissions/<id>.json directly.
    this.router.delete('/api/v1/permissions/rules', permissions.revokePermissionRule)
    this.router.get('/api/v1/permissions/workspace-roots', permissions.listAllWorkspaceRoots)

    // Tools
    this.router.get('/api/v1/profiles/:profileId/tools', tools.getProfileTools)
    // T21 (2026-04-22): GET /api/v1/tools/catalog removed.
    // Replaced by GET /api/v1/catalog?source=builtin (see below). The
    // grouped Connector.actions array now carries `isReadOnly` and
    // `requiresPermission` per action so consumers that previously
    // needed the flat ToolInfo[] view can flatten the catalog response.

    // Connectors — unified view across built-in + MCP (+ future Composio).
    // The web_search connector is pluggable (DuckDuckGo / Brave / Tavily) —
    // the factory wires three handlers: list, provider-list subroute,
    // provider-switch PATCH. User's provider choice persists in
    // user_settings; API keys persist in the credential vault under
    // reserved ids `builtin:web_search:<providerId>`.
    //
    // Note: `connectorHandlers` itself was constructed earlier in this
    // method so its `registry` could thread into the toolProviders
    // array (Phase 5-B.2). Routes are registered here.
    this.router.get('/api/v1/connectors', connectorHandlers.listConnectors)
    this.router.get('/api/v1/connectors/:id/providers', connectorHandlers.listProviders)
    this.router.patch('/api/v1/connectors/:id/provider', connectorHandlers.setProvider)

    // T01 — unified catalog endpoint for the client's "Add Tool" modal.
    // Shares the same ConnectorRegistry as /connectors; layers source/
    // featured/q filters + ETag on top. Intentionally separate from
    // /connectors so each endpoint has its own opinionated defaults
    // (lobby defaults featured=true; catalog defaults featured=false).
    this.router.get(
      '/api/v1/catalog',
      createCatalogHandler({ registry: connectorHandlers.registry }),
    )

    // Session 1.5a — per-source status endpoint. The client renders the
    // Composio section as a disabled empty-state when the key isn't set.
    const sourcesStatusHandler = createSourcesStatusHandler({
      isComposioEnabled: this.composioSourceProxy.hasInner(),
      webSearchService: this.webSearchService,
      // `featuredCount` is a static import (the hardcoded featured-set
      // module). `totalCount` is no longer surfaced — Composio's
      // catalogue is fetched live now, so a "total" would force a
      // synchronous walk on every health ping. The client's sources panel
      // shows just "Connected to Composio" without a count.
      getComposioFeaturedCount: () => featuredComposioSlugSet().size,
      getComposioDashboardBaseUrl: () => this.composioDashboardBaseUrl ?? undefined,
    })
    this.router.get('/api/v1/connectors/sources/status', sourcesStatusHandler)

    // Phase 2b.2b — alias source override.
    const aliasHandlers = createConnectorAliasHandlers({
      registry: connectorHandlers.registry,
      preferences: this.sourcePreferences,
    })
    this.router.patch(
      '/api/v1/connectors/alias/:logicalKey/source',
      aliasHandlers.setAliasSource,
    )

    // Source-aware connect dispatcher (Phase 2b.1).
    //
    // Composio: create a Composio-managed link, persist pending, dispatch
    // to the poller. MCP/builtin: honest 400 pointing to the correct
    // flow.
    // Composio deps resolve the runtime LIVE via getters, NOT a snapshot
    // captured here at route registration. Before this, the connect
    // handler was wired with `composio` only when a key existed at boot;
    // a key saved later (via the unified /credentials path) rebuilt the
    // runtime + proxies through `applyComposioKey` but never reached this
    // handler, so connect kept returning 501 "COMPOSIO_API_KEY is unset"
    // until a gateway restart. The getters read the gateway's current
    // `composioClient` / `composioCatalogCache`, which `applyComposioKey`
    // swaps on every credential change — same live-rebuild contract the
    // source/tool-provider proxies already honor.
    const gateway = this
    const connectorConnect = createConnectorConnectHandlers({
      registry: connectorHandlers.registry,
      connections: this.connectorConnections,
      completionManager: this.connectionCompletionManager,
      connectionSessions: this.connectionSessions,
      composio: {
        get client() {
          return gateway.composioClient
        },
        defaultUserId: this.installIdentity.id,
        get catalogCache() {
          return gateway.composioCatalogCache ?? undefined
        },
      },
    })
    this.router.post('/api/v1/connectors/:id/connect', connectorConnect.connect)

    // Runtime-setup trigger: spawns the connector's setupCommand (e.g.
    // `uvx linkedin-scraper-mcp --login`) and waits for completion. On
    // exit 0, writes the setup-completed marker → status flips ready.
    const connectorRuntimeSetup = createConnectorRuntimeSetupHandler({
      registry: connectorHandlers.registry,
      statusBus: this.connectorStatusBus,
    })
    this.router.post('/api/v1/connectors/:id/runtime-setup', connectorRuntimeSetup)

    // Inverse of the POST: revoke a live connection. Today only
    // Composio travels through here — MCP disconnect keeps its
    // transport-specific endpoints. See handler docstring for why.
    const connectorDisconnect = createConnectorDisconnectHandlers({
      registry: connectorHandlers.registry,
      connections: this.connectorConnections,
      statusBus: this.connectorStatusBus,
      completionManager: this.connectionCompletionManager,
      connectionSessions: this.connectionSessions,
      entityId: this.installIdentity.id,
      // Live getter — see the connect handler above. A key saved after
      // boot must reach disconnect too, without a restart.
      composio: {
        get client() {
          return gateway.composioClient
        },
      },
    })
    this.router.delete('/api/v1/connectors/:id/connect', connectorDisconnect.disconnect)

    // Connector status SSE channel. Source-agnostic: any connector
    // emitting a status transition through `ConnectorStatusBus` lands
    // here. Used by the client to refresh the connectors view in real time
    // without polling.
    const connectorEvents = createConnectorEventsHandler({
      statusBus: this.connectorStatusBus,
      state: this.state,
    })
    this.router.get('/api/v1/connectors/events', connectorEvents.streamConnectorEvents)

    // Models — `hasCredentials` derives from the unified credentials
    // store. Each LLM credential's `variableName` maps to one provider
    // ID via the same descriptor list used by the `/providers` handlers.
    // Ollama is keyless: it counts as configured when a local server
    // answers the 300ms reachability probe (availability, not a key).
    this.router.get(
      '/api/v1/models',
      createModelCatalogHandler({
        listConfiguredProviders: async () => {
          const llmCredentials = await this.credentialStore.list({ category: 'llm' })
          const fromVault = llmCredentials
            .map((c) => VARIABLE_NAME_TO_PROVIDER_ID[c.variableName ?? ''])
            .filter((p): p is string => typeof p === 'string')
          // Env keys count too: loom registers providers from the
          // environment at boot, so runs genuinely work with just an
          // exported key — the catalog must not claim otherwise.
          const fromEnv = Object.entries(PROVIDER_ENV_HINTS)
            .filter(([, envVar]) => Boolean(process.env[envVar]))
            .map(([providerId]) => providerId)
          const configured = new Set([...fromVault, ...fromEnv])
          if (await isOllamaReachable()) configured.add('ollama')
          return [...configured]
        },
      }),
    )

    // T21 (2026-04-22): GET /api/v1/mcp/featured removed.
    //   → use GET /api/v1/catalog?source=mcp&featured=true.
    // T21 (2026-04-22): GET /api/v1/mcp/marketplace + /:serverId removed.
    //   → use GET /api/v1/catalog?source=mcp + GET /api/v1/connectors/:id.

    // MCP — Credentials
    this.router.post('/api/v1/mcp/credentials/:serverId', mcp.saveCredentials)
    this.router.get('/api/v1/mcp/credentials/:serverId', mcp.checkCredentials)
    this.router.delete('/api/v1/mcp/credentials/:serverId', mcp.deleteCredentials)

    // MCP — Profile MCP management
    // T21 (2026-04-22): GET /api/v1/profiles/:profileId/mcp removed.
    //   → use GET /api/v1/connectors?profileId=X&source=mcp.
    // POST + DELETE survive — they write profile/agent.json and have no
    // equivalent on the unified surface.
    this.router.post('/api/v1/profiles/:profileId/mcp', mcp.addMCPToProfile)
    this.router.delete('/api/v1/profiles/:profileId/mcp/:serverId', mcp.removeMCPFromProfile)

    // T04 — custom MCP server registration. Persists to the existing
    // mcp_servers table with the `custom` registry-id marker. Security:
    // the register handler NEVER spawns the command or resolves PATH;
    // execution happens only when a profile references the server id
    // and the assembler builds a Session.
    const mcpRegisterHandlers = createMCPRegisterHandlers({
      state: this.state,
      vault: credentialVault,
    })
    this.router.post('/api/v1/mcp/register', mcpRegisterHandlers.registerServer)
    this.router.delete('/api/v1/mcp/register/:id', mcpRegisterHandlers.unregisterServer)

    // MCP — Live connection test
    this.router.post('/api/v1/mcp/connect/:serverId', mcp.connectServer)

    // MCP — OAuth2 flow
    this.router.post('/api/v1/mcp/oauth/start/:serverId', mcp.startOAuth)
    this.router.get('/api/v1/mcp/oauth/status/:serverId', mcp.oauthStatus)
    this.router.post('/api/v1/mcp/oauth/wait/:serverId', mcp.oauthWait)
    this.router.post('/api/v1/mcp/oauth/cancel/:serverId', mcp.oauthCancel)

    // T21 (2026-04-22): GET /api/v1/mcp/servers removed.
    //   → use GET /api/v1/connectors?source=mcp.

    // Workspaces — project-folder registry. A workspace gives an HTTP
    // run a filesystem root (`workspaceId` on POST /run → workspacePath
    // → the agent's zone boundary + shell cwd). Platform surface, kept.
    // (The desktop-only browse/history/file-tree extras were removed.)
    this.router.get('/api/v1/workspaces', workspaces.list)
    this.router.post('/api/v1/workspaces', workspaces.create)
    // Workspace CRUD SSE channel (audit #2 C2 / F1a, 2026-05-16). MUST
    // be registered BEFORE `GET /api/v1/workspaces/:workspaceId` — the
    // router iterates in registration order and the `:workspaceId`
    // pattern would otherwise shadow `/events`, dispatching to `get`
    // with params.workspaceId === 'events' and returning a 404. Same
    // gotcha that bit the credential channel in Chunk #16.
    const workspaceEventsHandler = createWorkspaceEventsHandler({
      bus: this.workspaceEventBus,
      state: this.state,
    })
    this.router.get(
      '/api/v1/workspaces/events',
      workspaceEventsHandler.streamWorkspaceEvents,
    )
    this.router.get('/api/v1/workspaces/:workspaceId', workspaces.get)
    this.router.put('/api/v1/workspaces/:workspaceId', workspaces.update)
    this.router.delete('/api/v1/workspaces/:workspaceId', workspaces.remove)
    this.router.get('/api/v1/workspaces/:workspaceId/threads', workspaces.listThreads)

    // (The desktop pane substrate — pane CRUD/layout/SSE — was removed
    // with the legacy desktop shell.)

    // Dashboard
    this.router.get('/api/v1/dashboard', dashboard.getDashboard)
    this.router.get('/api/v1/dashboard/kpis', dashboard.getKPIs)
    this.router.get('/api/v1/dashboard/usage-chart', dashboard.getUsageChart)
    this.router.get('/api/v1/dashboard/profile-breakdown', dashboard.getProfileBreakdown)
    this.router.get('/api/v1/dashboard/recent-activity', dashboard.getRecentActivity)

    // Activity feed
    this.router.get('/api/v1/activity', activity.getActivity)

    // Storage + Data
    this.router.get('/api/v1/storage/stats', dashboard.getStorageStats)
    this.router.post('/api/v1/storage/clear-cache', dashboard.clearCache)
    this.router.post('/api/v1/data/export', dashboard.exportData)

    // Settings
    this.router.get('/api/v1/settings', settings.getSettings)
    this.router.put('/api/v1/settings/:section', settings.putSettingsSection)

    // Providers
    this.router.get('/api/v1/providers', providers.listProviders)
    this.router.post('/api/v1/providers', providers.saveProvider)
    this.router.post('/api/v1/providers/validate', providers.validateProvider)
    this.router.delete('/api/v1/providers/:provider', providers.deleteProvider)
    this.router.get('/api/v1/providers/:provider/key', providers.getProviderKeyFull)

    // Speech-to-text dictation (Path A)
    this.router.get('/api/v1/speech/capabilities', transcribe.capabilities)
    this.router.post('/api/v1/transcribe', transcribe.transcribe)

    // Search
    this.router.get('/api/v1/search', searchHandlers.search)

    // App info
    this.router.get('/api/v1/app/version', appVersionHandler)
    this.router.get('/api/v1/connectivity', connectivityHandler)

    // Debug
    this.router.get('/api/v1/debug/events', debug.getEvents)
    this.router.get('/api/v1/debug/events/:threadId/timeline', debug.getTimeline)
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMainModule = import.meta.url === `file://${process.argv[1]}`

if (isMainModule) {
  const portIdx = process.argv.indexOf('--port')
  const envPort = process.env['GATEWAY_PORT'] ?? process.env['OWNWARE_PORT']
  const port = portIdx >= 0
    ? parseInt(process.argv[portIdx + 1]!)
    : envPort != null ? parseInt(envPort) : 3011

  const profilesIdx = process.argv.indexOf('--profiles')
  // Default profile-dir resolution must work for BOTH entry points:
  //   Dev   : cortex/dist/gateway/server.js → '../../profiles' = cortex/profiles ✓
  //   Bundle: cortex/dist/gateway-bundle.mjs → '../../profiles' = parent of cortex ✗
  // Try the bundle-shallow path first, then fall back to the dev-deep
  // path. Whichever resolves to an existing directory wins. The
  // supervisor passes --profiles explicitly in production so this
  // fallback only matters when someone runs the bundle by hand.
  const defaultProfilesDir = (() => {
    const shallow = resolve(import.meta.dirname, '../profiles')   // bundle layout
    const deep = resolve(import.meta.dirname, '../../profiles')   // dev layout
    try {
      // Prefer the shallow path if it exists — that's the bundled
      // production layout.
      if (existsSync(shallow)) return shallow
    } catch { /* fall through */ }
    return deep
  })()
  const profilesDir = profilesIdx >= 0
    ? resolve(process.argv[profilesIdx + 1]!)
    : defaultProfilesDir

  // --no-auth CLI flag is a convenience for local dev; equivalent to
  // exporting OWNWARE_DISABLE_AUTH=1 before running the gateway.
  // Only pass disableAuth when explicitly set — otherwise let the env
  // var logic in the constructor decide (opts.disableAuth ?? ...).
  const noAuthFlag = process.argv.includes('--no-auth')

  // Surface a boot failure as a single structured line the desktop client's supervisor
  // parses, so the user sees the REAL reason (e.g. a MigrationSafetyError:
  // "your data was restored, will fix on next update") on the crash screen
  // instead of a generic "backend stopped". Handles BOTH the synchronous
  // constructor throw (DB/migration failure runs in `new OwnwareGateway`) and
  // async start failures.
  const emitFatal = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err)
    const category =
      err != null && typeof err === 'object' && 'category' in err
        ? String((err as { readonly category: unknown }).category)
        : 'unknown'
    // Single line, tab-delimited: __GATEWAY_FATAL__\t<category>\t<message>
    console.error(`__GATEWAY_FATAL__\t${category}\t${message.replace(/\s+/g, ' ').trim()}`)
    process.exit(1)
  }
  try {
    const gateway = new OwnwareGateway({
      port,
      profilesDir,
      ...(noAuthFlag ? { disableAuth: true } : {}),
    })
    gateway.start().catch(emitFatal)
  } catch (err) {
    emitFatal(err)
  }
}
