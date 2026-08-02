import { describe, it } from 'vitest'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlSourceRepositories } from '../../../src/storage/postgresql-source-repositories.js'
import type { SourceRepositories } from '../../../src/storage/source-repositories.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import {
  runSourceRepositoryContract,
  type SourceRepositoryHarness,
  type SourceRepositoryPeer,
} from '../../storage/source-repositories-contract.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const quotaLimits: SourceQuotaLimits = {
  workspace: limits(),
  profile: limits(),
}

if (TEST_URL === undefined) {
  describe.skip('postgresql source repository contract', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  runSourceRepositoryContract(
    'production PostgreSQL',
    async (): Promise<SourceRepositoryHarness> => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL)
      const plan = validateStoragePlan({
        storage: {
          kind: 'postgresql',
          runtimeConnection: { source: 'provider', resolve: () => database.url },
          tls: { mode: 'disable', allowInsecureLoopback: true },
        },
      }, '/unused.db')
      if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

      interface Root { readonly sources: SourceRepositories }
      const peers = new Set<PostgreSqlStorageAdapter<Root, object>>()
      const open = async (): Promise<PostgreSqlStorageAdapter<Root, object>> => {
        const storage = new PostgreSqlStorageAdapter<Root, object>({
          plan,
          repositories: {
            createRoot: (context) => ({
              sources: createPostgreSqlSourceRepositories(context, { quotaLimits }),
            }),
            createTransaction: () => ({}),
          },
        })
        await storage.initialize()
        return storage
      }

      let storage = await open()
      async function closePeer(peer: PostgreSqlStorageAdapter<Root, object>): Promise<void> {
        if (!peers.delete(peer)) return
        await peer.close()
      }
      return {
        get repositories() {
          return storage.repositories.sources
        },
        async openPeer(): Promise<SourceRepositoryPeer> {
          const peer = await open()
          peers.add(peer)
          return {
            repositories: peer.repositories.sources,
            close: () => closePeer(peer),
          }
        },
        async reopen() {
          await storage.close()
          storage = await open()
        },
        async close() {
          await Promise.all([...peers].map(closePeer))
          await storage.close().catch(() => {})
          await database.close()
        },
      }
    },
  )
}

function limits() {
  return {
    maxSourceRegistrations: 4,
    maxRetainedAndReservedBytes: 1024,
    maxActiveUploadSessions: 8,
    maxNonterminalJobs: 8,
    maxDerivedResources: 8,
  }
}
