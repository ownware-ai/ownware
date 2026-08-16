import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from './sqlite-driver.js'
import { CredentialAuditLog } from '../credential/audit.js'
import { DbOAuthRefreshCoordinator } from '../credential/oauth-refresh-coordinator.js'
import { checkSpendCap } from '../credential/spend-tracker.js'
import {
  createCredentialStore,
  runCredentialBootMigrations,
} from '../credential/store/index.js'
import {
  AccessGrantStore,
  AccessGrantStoreError,
} from '../gateway/access-grant-store.js'
import {
  DelegatedPrincipalStore,
  PrincipalAuthError,
} from '../gateway/auth/scoped-principal.js'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import { RunIdempotencyStore } from '../gateway/idempotency.js'
import {
  GatewayRunStore,
  ProfileRunNotAcceptingError,
} from '../gateway/run-store.js'
import {
  EffectReceiptStore,
  EffectReceiptStoreError,
} from '../gateway/effect-receipt-store.js'
import {
  EgressReceiptStore,
  EgressReceiptStoreError,
} from '../gateway/egress-receipt-store.js'
import { ThreadPrincipalBindingStore } from '../gateway/thread-principal-binding.js'
import type { Thread } from '../gateway/types.js'
import {
  CodexThreadReferenceStore,
  CodexThreadReferenceStoreError,
} from '../runtime/codex/thread-reference-store.js'
import {
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import type {
  CredentialSpendRepository,
  SecurityRepositories,
  SecurityTransactionRepositories,
} from './security-repositories.js'
import type {
  SqliteRootRepositoryContext,
  SqliteTransactionRepositoryContext,
} from './sqlite-adapter.js'

export interface SqliteSecurityRepositoryOptions {
  readonly permissionHashSecret: string
  readonly evidenceSearchCache?: EvidenceSearchCache
  readonly idempotencyLeaseOwner?: string
  readonly oauthRefreshOwner?: string
}

function isPreservedDomainError(error: unknown): boolean {
  return error instanceof StorageLifecycleError ||
    error instanceof StorageRepositoryError ||
    error instanceof AccessGrantStoreError ||
    error instanceof PrincipalAuthError ||
    error instanceof ProfileRunNotAcceptingError ||
    error instanceof EffectReceiptStoreError ||
    error instanceof EgressReceiptStoreError ||
    error instanceof CodexThreadReferenceStoreError
}

function sqliteCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? '')
    : ''
}

function repositoryCall<T>(
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: () => T,
): T {
  try {
    assertActive()
    return fn()
  } catch (error) {
    if (isPreservedDomainError(error)) throw error
    const codeValue = sqliteCode(error)
    throw new StorageRepositoryError(
      code,
      'sqlite',
      domain,
      operation,
      codeValue === 'SQLITE_BUSY' || codeValue === 'SQLITE_LOCKED',
    )
  }
}

async function repositoryCallAsync<T>(
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    assertActive()
    return await fn()
  } catch (error) {
    if (isPreservedDomainError(error)) throw error
    const codeValue = sqliteCode(error)
    throw new StorageRepositoryError(
      code,
      'sqlite',
      domain,
      operation,
      codeValue === 'SQLITE_BUSY' || codeValue === 'SQLITE_LOCKED',
    )
  }
}

export function createSqliteSecurityRepositories(
  context: SqliteRootRepositoryContext,
  options: SqliteSecurityRepositoryOptions,
): SecurityRepositories {
  const { database, assertActive } = context
  const credentialStore = createCredentialStore(database)
  const audit = new CredentialAuditLog(database)
  const principals = new DelegatedPrincipalStore(database)
  const bindings = new ThreadPrincipalBindingStore(database)
  const runs = new GatewayRunStore(database, options.permissionHashSecret)
  const effectReceipts = new EffectReceiptStore(database)
  const egressReceipts = new EgressReceiptStore(database)
  const idempotency = new RunIdempotencyStore(database, options.idempotencyLeaseOwner)
  const grants = new AccessGrantStore(
    database,
    undefined,
    options.evidenceSearchCache,
  )
  const refresh = new DbOAuthRefreshCoordinator(database, options.oauthRefreshOwner)
  const codexReferences = new CodexThreadReferenceStore(database)

  const credentials = {
    name: credentialStore.name,
    categories: credentialStore.categories,
    save: (input: Parameters<typeof credentialStore.save>[0]) =>
      repositoryCallAsync(assertActive, 'credentials', 'save', 'write_failed', () =>
        credentialStore.save(input)),
    get: (id: string) =>
      repositoryCallAsync(assertActive, 'credentials', 'get', 'read_failed', () =>
        credentialStore.get(id)),
    list: (filter?: Parameters<typeof credentialStore.list>[0]) =>
      repositoryCallAsync(assertActive, 'credentials', 'list', 'read_failed', () =>
        credentialStore.list(filter)),
    update: (
      id: string,
      input: Parameters<typeof credentialStore.update>[1],
    ) => repositoryCallAsync(assertActive, 'credentials', 'update', 'write_failed', () =>
      credentialStore.update(id, input)),
    updateIfUnchanged: (
      id: string,
      expected: Parameters<typeof credentialStore.updateIfUnchanged>[1],
      input: Parameters<typeof credentialStore.updateIfUnchanged>[2],
    ) => repositoryCallAsync(
      assertActive,
      'credentials',
      'update_if_unchanged',
      'write_failed',
      () => credentialStore.updateIfUnchanged(id, expected, input),
    ),
    delete: (id: string) =>
      repositoryCallAsync(assertActive, 'credentials', 'delete', 'write_failed', () =>
        credentialStore.delete(id)),
    decrypt: (id: string) =>
      repositoryCallAsync(assertActive, 'credentials', 'decrypt', 'read_failed', () =>
        credentialStore.decrypt(id)),
  }

  return {
    credentials,
    credentialAudit: {
      async recordEvent(input) {
        return repositoryCall(assertActive, 'credential_audit', 'record', 'write_failed', () =>
          audit.recordEvent(input))
      },
      async listEventsForCredential(credentialId, listOptions) {
        return repositoryCall(assertActive, 'credential_audit', 'list', 'read_failed', () =>
          audit.listEventsForCredential(credentialId, listOptions))
      },
      async aggregateUsage(credentialId, aggregateOptions) {
        return repositoryCall(
          assertActive,
          'credential_audit',
          'aggregate_usage',
          'read_failed',
          () => audit.aggregateUsage(credentialId, aggregateOptions),
        )
      },
      async aggregateCost(credentialId, aggregateOptions) {
        return repositoryCall(
          assertActive,
          'credential_audit',
          'aggregate_cost',
          'read_failed',
          () => audit.aggregateCost(credentialId, aggregateOptions),
        )
      },
    },
    credentialSpend: createSqliteCredentialSpendRepository(database, assertActive),
    credentialMigrations: {
      run(migrationOptions) {
        return repositoryCallAsync(
          assertActive,
          'credential_migrations',
          'run',
          'write_failed',
          () => runCredentialBootMigrations(database, credentials, migrationOptions),
        )
      },
    },
    principals: {
      async insert(principal) {
        repositoryCall(assertActive, 'principals', 'insert', 'write_failed', () =>
          principals.insert(principal))
      },
      async find(tokenId) {
        return repositoryCall(assertActive, 'principals', 'find', 'read_failed', () =>
          principals.find(tokenId))
      },
      async revoke(tokenId, reason, revokedAt) {
        return repositoryCall(assertActive, 'principals', 'revoke', 'write_failed', () =>
          principals.revoke(tokenId, reason, revokedAt))
      },
    },
    threadBindings: {
      async bind(threadId, principalKey, now) {
        return repositoryCall(assertActive, 'thread_bindings', 'bind', 'write_failed', () =>
          bindings.bind(threadId, principalKey, now))
      },
      async allows(threadId, principalKey) {
        return repositoryCall(assertActive, 'thread_bindings', 'allows', 'read_failed', () =>
          bindings.allows(threadId, principalKey))
      },
    },
    runs: {
      async create(input, now) {
        return repositoryCall(assertActive, 'runs', 'create', 'write_failed', () =>
          runs.create(input, now))
      },
      async countActiveForProfile(profileId) {
        return repositoryCall(assertActive, 'runs', 'count_active', 'read_failed', () =>
          runs.countActiveForProfile(profileId))
      },
      async get(runId) {
        return repositoryCall(assertActive, 'runs', 'get', 'read_failed', () => runs.get(runId))
      },
      async markRunning(runId, now) {
        repositoryCall(assertActive, 'runs', 'mark_running', 'write_failed', () =>
          runs.markRunning(runId, now))
      },
      async advanceConsequence(runId, consequence, now) {
        repositoryCall(assertActive, 'runs', 'advance_consequence', 'write_failed', () =>
          runs.advanceConsequence(runId, consequence, now))
      },
      async requestCancel(runId, now) {
        return repositoryCall(assertActive, 'runs', 'request_cancel', 'write_failed', () =>
          runs.requestCancel(runId, now))
      },
      async markTerminal(runId, status, input) {
        repositoryCall(assertActive, 'runs', 'mark_terminal', 'write_failed', () =>
          runs.markTerminal(runId, status, input))
      },
      async recoverInterrupted(now) {
        return repositoryCall(assertActive, 'runs', 'recover_interrupted', 'write_failed', () =>
          runs.recoverInterrupted(now))
      },
      async recordPermissionRequest(input, now) {
        return repositoryCall(assertActive, 'runs', 'record_permission', 'write_failed', () =>
          runs.recordPermissionRequest(input, now))
      },
      async getPermissionRequest(runId, requestId) {
        return repositoryCall(assertActive, 'runs', 'get_permission', 'read_failed', () =>
          runs.getPermissionRequest(runId, requestId))
      },
      async consumePermissionApproval(input, now) {
        return repositoryCall(assertActive, 'runs', 'consume_permission', 'write_failed', () =>
          runs.consumePermissionApproval(input, now))
      },
      async decidePermission(runId, requestId, operationHash, decision, now) {
        return repositoryCall(assertActive, 'runs', 'decide_permission', 'write_failed', () =>
          runs.decidePermission(runId, requestId, operationHash, decision, now))
      },
      async expirePermission(runId, requestId, operationHash, now) {
        return repositoryCall(assertActive, 'runs', 'expire_permission', 'write_failed', () =>
          runs.expirePermission(runId, requestId, operationHash, now))
      },
      async markWaiting(runId, now) {
        repositoryCall(assertActive, 'runs', 'mark_waiting', 'write_failed', () =>
          runs.markWaiting(runId, now))
      },
      async markRunningAfterDecision(runId, now) {
        repositoryCall(assertActive, 'runs', 'mark_running_after_decision', 'write_failed', () =>
          runs.markRunningAfterDecision(runId, now))
      },
    },
    effectReceipts: {
      async observe(input, now) {
        return repositoryCall(assertActive, 'effect_receipts', 'observe', 'write_failed', () =>
          effectReceipts.observe(input, now))
      },
      async listForRun(runId, page) {
        return repositoryCall(assertActive, 'effect_receipts', 'list', 'read_failed', () =>
          effectReceipts.listForRun(runId, page))
      },
      async markPendingUnknownForRun(runId, authorityRef, now) {
        return repositoryCall(assertActive, 'effect_receipts', 'reconcile_run', 'write_failed', () =>
          effectReceipts.markPendingUnknownForRun(runId, authorityRef, now))
      },
      async reconcileInterrupted(authorityRef, now) {
        return repositoryCall(
          assertActive,
          'effect_receipts',
          'reconcile_interrupted',
          'write_failed',
          () => effectReceipts.reconcileInterrupted(authorityRef, now),
        )
      },
    },
    egressReceipts: {
      async observe(input, now) {
        return repositoryCall(assertActive, 'egress_receipts', 'observe', 'write_failed', () =>
          egressReceipts.observe(input, now))
      },
      async listForRun(runId, page) {
        return repositoryCall(assertActive, 'egress_receipts', 'list', 'read_failed', () =>
          egressReceipts.listForRun(runId, page))
      },
      async markPendingUnknownForRun(runId, reasonCode, now) {
        return repositoryCall(assertActive, 'egress_receipts', 'reconcile_run', 'write_failed', () =>
          egressReceipts.markPendingUnknownForRun(runId, reasonCode, now))
      },
      async reconcileInterrupted(reasonCode, now) {
        return repositoryCall(assertActive, 'egress_receipts', 'reconcile_interrupted', 'write_failed', () =>
          egressReceipts.reconcileInterrupted(reasonCode, now))
      },
    },
    idempotency: {
      async claim(input, now) {
        return repositoryCall(assertActive, 'idempotency', 'claim', 'write_failed', () =>
          idempotency.claim(input, now))
      },
      async complete(input, now) {
        repositoryCall(assertActive, 'idempotency', 'complete', 'write_failed', () =>
          idempotency.complete(input, now))
      },
      async markIndeterminate(input, now) {
        repositoryCall(assertActive, 'idempotency', 'mark_indeterminate', 'write_failed', () =>
          idempotency.markIndeterminate(input, now))
      },
      async abandon(input) {
        repositoryCall(assertActive, 'idempotency', 'abandon', 'write_failed', () =>
          idempotency.abandon(input))
      },
      async linkRun(recordId, runId) {
        repositoryCall(assertActive, 'idempotency', 'link_run', 'write_failed', () =>
          idempotency.linkRun(recordId, runId))
      },
      async linkSourceMutation(recordId, sourceId, kind, now) {
        repositoryCall(assertActive, 'idempotency', 'link_source_mutation', 'write_failed', () =>
          idempotency.linkSourceMutation(recordId, sourceId, kind, now))
      },
    },
    accessGrants: {
      async create(input, now) {
        return repositoryCall(assertActive, 'access_grants', 'create', 'write_failed', () =>
          grants.create(input, now))
      },
      async createPreparedTextAccessGrant(input, now) {
        return repositoryCall(
          assertActive,
          'access_grants',
          'create_prepared_text',
          'write_failed',
          () => grants.createPreparedTextAccessGrant(input, now),
        )
      },
      async createDataViewQueryWindowGrant(input, now) {
        return repositoryCall(
          assertActive,
          'access_grants',
          'create_data_view_window',
          'write_failed',
          () => grants.createDataViewQueryWindowGrant(input, now),
        )
      },
      async getPreparedTextReadTargetScoped(workspaceId, profileId, resourceId) {
        return repositoryCall(
          assertActive,
          'access_grants',
          'get_prepared_text_target_scoped',
          'read_failed',
          () => grants.getPreparedTextReadTargetScoped(workspaceId, profileId, resourceId),
        )
      },
      async getPreparedTextReadTargetForOwner(resourceId) {
        return repositoryCall(
          assertActive,
          'access_grants',
          'get_prepared_text_target_owner',
          'read_failed',
          () => grants.getPreparedTextReadTargetForOwner(resourceId),
        )
      },
      async getDataViewQueryTargetForOwner(dataViewId) {
        return repositoryCall(
          assertActive,
          'access_grants',
          'get_data_view_target_owner',
          'read_failed',
          () => grants.getDataViewQueryTargetForOwner(dataViewId),
        )
      },
      async getCurrentForOwner(grantId) {
        return repositoryCall(assertActive, 'access_grants', 'get_current_owner', 'read_failed', () =>
          grants.getCurrentForOwner(grantId))
      },
      async getSourceIdentityForOwner(grantId) {
        return repositoryCall(assertActive, 'access_grants', 'get_source_identity', 'read_failed', () =>
          grants.getSourceIdentityForOwner(grantId))
      },
      async listCurrentForOwner(page, now) {
        return repositoryCall(assertActive, 'access_grants', 'list_current_owner', 'read_failed', () =>
          grants.listCurrentForOwner(page, now))
      },
      async revoke(input, now) {
        return repositoryCall(assertActive, 'access_grants', 'revoke', 'write_failed', () =>
          grants.revoke(input, now))
      },
      async findLiveCandidates(input, now) {
        return repositoryCall(assertActive, 'access_grants', 'find_live_candidates', 'read_failed', () =>
          grants.findLiveCandidates(input, now))
      },
    },
    oauthRefresh: {
      async tryAcquire(credentialId, now, leaseMs) {
        return repositoryCall(assertActive, 'oauth_refresh', 'try_acquire', 'write_failed', () =>
          refresh.tryAcquire(credentialId, now, leaseMs))
      },
      async renew(lease, now, leaseMs) {
        return repositoryCall(assertActive, 'oauth_refresh', 'renew', 'write_failed', () =>
          refresh.renew(lease, now, leaseMs))
      },
      async release(lease) {
        return repositoryCall(assertActive, 'oauth_refresh', 'release', 'write_failed', () =>
          refresh.release(lease))
      },
      async inspect(credentialId) {
        return repositoryCall(assertActive, 'oauth_refresh', 'inspect', 'read_failed', () =>
          refresh.inspect(credentialId))
      },
    },
    codexThreadReferences: {
      async load(localThreadId) {
        return repositoryCall(
          assertActive,
          'codex_thread_references',
          'load',
          'read_failed',
          () => codexReferences.load(localThreadId),
        )
      },
      async save(input) {
        return repositoryCall(
          assertActive,
          'codex_thread_references',
          'save',
          'write_failed',
          () => codexReferences.save(input),
        )
      },
    },
  }
}

/** Test/transition helper for an already-open isolated SQLite database. */
export function createSqliteCredentialSpendRepository(
  database: SqliteDatabase,
  assertActive: () => void = () => {},
): CredentialSpendRepository {
  return {
    async check(credentialId, cap, estimatedCostUsd, now) {
      return repositoryCall(
        assertActive,
        'credential_spend',
        'check',
        'read_failed',
        () => checkSpendCap(database, credentialId, cap, estimatedCostUsd, now),
      )
    },
  }
}

export function createSqliteSecurityTransactionRepositories(
  context: SqliteTransactionRepositoryContext,
): SecurityTransactionRepositories {
  return {
    threadAuthority: {
      async createAndBind(profileId, workspaceId, principalKey) {
        return repositoryCall(
          context.assertActive,
          'thread_bindings',
          'create_thread_and_bind',
          'write_failed',
          () => createThreadAndBind(context, profileId, workspaceId, principalKey),
        )
      },
    },
  }
}

function createThreadAndBind(
  context: SqliteTransactionRepositoryContext,
  profileId: string,
  workspaceId: string | undefined,
  principalKey: string,
): Thread {
  const id = `thread_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const now = new Date().toISOString()
  context.database.prepare(`
    INSERT INTO threads (
      id, profile_id, workspace_id, title, status, message_count,
      total_tokens, total_cost, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, 'active', 0, 0, 0, ?, ?)
  `).run(id, profileId, workspaceId ?? null, now, now)
  if (workspaceId !== undefined) {
    context.database.prepare(`
      INSERT INTO workspace_profiles (
        workspace_id, profile_id, thread_count, last_used_at
      ) VALUES (?, ?, 1, ?)
      ON CONFLICT(workspace_id, profile_id) DO UPDATE SET
        thread_count = thread_count + 1,
        last_used_at = excluded.last_used_at
    `).run(workspaceId, profileId, now)
  }
  const bindings = new ThreadPrincipalBindingStore(context.database)
  if (!bindings.bind(id, principalKey, Date.parse(now))) {
    throw new StorageRepositoryError(
      'write_failed',
      'sqlite',
      'thread_bindings',
      'create_thread_and_bind',
      false,
    )
  }
  return {
    id,
    profileId,
    workspaceId: workspaceId ?? null,
    title: null,
    status: 'active',
    messageCount: 0,
    totalTokens: 0,
    totalCost: 0,
    model: null,
    lastMessagePreview: null,
    createdAt: now,
    updatedAt: now,
  }
}
