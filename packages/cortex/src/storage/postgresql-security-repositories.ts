import { createPostgreSqlJobReceiptRepository } from './postgresql-job-receipt-repository.js'
import { createPostgreSqlActivityLedgerRepository } from './postgresql-activity-ledger-repository.js'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import type {
  SecurityRepositories,
  SecurityTransactionRepositories,
} from './security-repositories.js'
import type {
  PostgreSqlRootRepositoryContext,
  PostgreSqlTransactionRepositoryContext,
} from './postgresql-adapter.js'
import { createPostgreSqlAccessGrantRepository } from './postgresql-access-grant-repository.js'
import { createPostgreSqlCredentialRepository } from './postgresql-credential-repository.js'
import { createPostgreSqlThreadInTransaction } from './postgresql-core-repositories.js'
import { repositoryCall } from './postgresql-repository.js'
import {
  createPostgreSqlCodexReferenceRepository,
  createPostgreSqlCredentialAuditRepository,
  createPostgreSqlCredentialMigrationRepository,
  createPostgreSqlCredentialSpendRepository,
  createPostgreSqlOAuthRefreshRepository,
  createPostgreSqlPrincipalRepository,
  createPostgreSqlThreadBindingRepository,
} from './postgresql-security-foundation.js'
import {
  createPostgreSqlIdempotencyRepository,
  createPostgreSqlRunRepository,
} from './postgresql-run-repositories.js'
import { createPostgreSqlEffectReceiptRepository } from './postgresql-effect-receipt-repository.js'
import { createPostgreSqlEgressReceiptRepository } from './postgresql-egress-receipt-repository.js'
import { createPostgreSqlSkillActivationReceiptRepository } from './postgresql-skill-activation-repository.js'
import { createPostgreSqlEffectReversalRepository } from './postgresql-effect-reversal-repository.js'
import { threadPrincipalScopeDigest } from '../gateway/thread-principal-binding.js'

export interface PostgreSqlSecurityRepositoryOptions {
  readonly permissionHashSecret: string
  readonly evidenceSearchCache?: EvidenceSearchCache
  readonly idempotencyLeaseOwner?: string
  readonly oauthRefreshOwner?: string
}

/** Complete PostgreSQL implementation of the security repository contract. */
export function createPostgreSqlSecurityRepositories(
  context: PostgreSqlRootRepositoryContext,
  options: PostgreSqlSecurityRepositoryOptions,
): SecurityRepositories {
  const credentials = createPostgreSqlCredentialRepository(context)
  return {
    credentials,
    credentialAudit: createPostgreSqlCredentialAuditRepository(context),
    credentialSpend: createPostgreSqlCredentialSpendRepository(context),
    credentialMigrations: createPostgreSqlCredentialMigrationRepository(context, credentials),
    principals: createPostgreSqlPrincipalRepository(context),
    threadBindings: createPostgreSqlThreadBindingRepository(context),
    runs: createPostgreSqlRunRepository(context, options.permissionHashSecret),
    effectReceipts: createPostgreSqlEffectReceiptRepository(context),
    activityLedger: createPostgreSqlActivityLedgerRepository(context),
    jobReceipts: createPostgreSqlJobReceiptRepository(context),
    egressReceipts: createPostgreSqlEgressReceiptRepository(context),
    skillActivationReceipts: createPostgreSqlSkillActivationReceiptRepository(context),
    effectReversals: createPostgreSqlEffectReversalRepository(context),
    idempotency: createPostgreSqlIdempotencyRepository(context, options.idempotencyLeaseOwner),
    accessGrants: createPostgreSqlAccessGrantRepository(context, options.evidenceSearchCache),
    oauthRefresh: createPostgreSqlOAuthRefreshRepository(context, options.oauthRefreshOwner),
    codexThreadReferences: createPostgreSqlCodexReferenceRepository(context),
  }
}

export function createPostgreSqlSecurityTransactionRepositories(
  context: PostgreSqlTransactionRepositoryContext,
): SecurityTransactionRepositories {
  return {
    threadAuthority: {
      createAndBind(profileId, workspaceId, principalKey) {
        return repositoryCall(
          context,
          'thread_bindings',
          'create_thread_and_bind',
          'write_failed',
          async (client) => {
            if (!('release' in client)) throw new Error('transaction client is unavailable')
            const thread = await createPostgreSqlThreadInTransaction(
              client,
              profileId,
              workspaceId,
            )
            const digest = threadPrincipalScopeDigest(principalKey)
            const binding = await client.query(`
              INSERT INTO ownware.thread_principal_bindings (
                thread_id, principal_scope_digest, created_at
              ) VALUES ($1, $2, $3) ON CONFLICT (thread_id) DO NOTHING
              RETURNING thread_id
            `, [thread.id, digest, Date.now()])
            if (binding.rowCount !== 1) throw new Error('thread authority binding failed')
            return thread
          },
        )
      },
    },
  }
}
