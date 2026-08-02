import { describe, it } from 'vitest'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import {
  createPostgreSqlSecurityRepositories,
  createPostgreSqlSecurityTransactionRepositories,
} from '../../../src/storage/postgresql-security-repositories.js'
import type {
  SecurityRepositories,
  SecurityTransactionRepositories,
} from '../../../src/storage/security-repositories.js'
import {
  runSecurityRepositoryContract,
  type SecurityRepositoryHarness,
  type SecurityRepositoryPeer,
} from '../../storage/security-repositories-contract.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const permissionHashSecret = 'contract-permission-secret'

interface RootRepositories {
  readonly core: CoreStorageRepositories
  readonly security: SecurityRepositories
}

if (TEST_URL === undefined) {
  describe.skip('security storage repository contract — postgresql', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  runSecurityRepositoryContract(
    'postgresql',
    async (): Promise<SecurityRepositoryHarness> => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL)
      const previousMasterKey = process.env['OWNWARE_MASTER_KEY']
      process.env['OWNWARE_MASTER_KEY'] = 'cd'.repeat(32)
      __resetMasterKeyCacheForTests()
      const validated = validateStoragePlan({
        storage: {
          kind: 'postgresql',
          runtimeConnection: { source: 'provider', resolve: () => database.url },
          tls: { mode: 'disable', allowInsecureLoopback: true },
        },
      }, '/unused.db')
      if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

      const peers = new Set<PostgreSqlStorageAdapter<RootRepositories, SecurityTransactionRepositories>>()

      async function open(
        idempotencyLeaseOwner: string,
        oauthRefreshOwner: string,
      ): Promise<PostgreSqlStorageAdapter<RootRepositories, SecurityTransactionRepositories>> {
        const adapter = new PostgreSqlStorageAdapter<RootRepositories, SecurityTransactionRepositories>({
          plan: validated,
          repositories: {
            createRoot: (context) => ({
              core: createPostgreSqlCoreRepositories(context),
              security: createPostgreSqlSecurityRepositories(context, {
                permissionHashSecret,
                idempotencyLeaseOwner,
                oauthRefreshOwner,
              }),
            }),
            createTransaction: createPostgreSqlSecurityTransactionRepositories,
          },
        })
        await adapter.initialize()
        return adapter
      }

      let adapter = await open('contract-idempotency-primary', 'contract-oauth-primary')

      async function closePeer(
        peer: PostgreSqlStorageAdapter<RootRepositories, SecurityTransactionRepositories>,
      ): Promise<void> {
        if (!peers.delete(peer)) return
        await peer.close()
      }

      return {
        get repositories() { return adapter.repositories.security },
        get core() { return adapter.repositories.core },
        createDelegatedThread(profileId, workspaceId, principalKey) {
          return adapter.transaction(
            { mode: 'write', isolation: 'serializable', retry: 'never' },
            (transaction) => transaction.repositories.threadAuthority.createAndBind(
              profileId,
              workspaceId,
              principalKey,
            ),
          )
        },
        async openPeer(options): Promise<SecurityRepositoryPeer> {
          const peer = await open(options.idempotencyLeaseOwner, options.oauthRefreshOwner)
          peers.add(peer)
          return { repositories: peer.repositories.security, close: () => closePeer(peer) }
        },
        async reopen() {
          await adapter.close()
          adapter = await open('contract-idempotency-reopened', 'contract-oauth-reopened')
        },
        async close() {
          await Promise.all([...peers].map(closePeer))
          await adapter.close().catch(() => {})
          await database.close()
          if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
          else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
          __resetMasterKeyCacheForTests()
        },
      }
    },
  )
}
