import { describe, it } from 'vitest'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import type { GatewayRepositories } from '../../../src/storage/gateway-repositories.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import { createPostgreSqlGatewayRepositories } from '../../../src/storage/postgresql-gateway-repositories.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import {
  runGatewayRepositoryContract,
  type GatewayRepositoryHarness,
} from '../../storage/gateway-repositories-contract.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()

if (TEST_URL === undefined) {
  describe.skip('postgresql gateway repositories', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  runGatewayRepositoryContract(
    'production PostgreSQL',
    async (): Promise<GatewayRepositoryHarness> => {
      const database = await createDisposablePostgreSqlDatabase(TEST_URL)
      const plan = validateStoragePlan({
        storage: {
          kind: 'postgresql',
          runtimeConnection: { source: 'provider', resolve: () => database.url },
          tls: { mode: 'disable', allowInsecureLoopback: true },
        },
      }, '/unused.db')
      if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

      interface Root {
        readonly core: CoreStorageRepositories
        readonly gateway: GatewayRepositories
      }
      const open = async (): Promise<PostgreSqlStorageAdapter<Root, object>> => {
        const storage = new PostgreSqlStorageAdapter<Root, object>({
          plan,
          repositories: {
            createRoot: (context) => ({
              core: createPostgreSqlCoreRepositories(context),
              gateway: createPostgreSqlGatewayRepositories(context),
            }),
            createTransaction: () => ({}),
          },
        })
        await storage.initialize()
        return storage
      }

      let storage = await open()
      return {
        get repositories() {
          return storage.repositories.gateway
        },
        get core() {
          return storage.repositories.core
        },
        async reopen() {
          await storage.close()
          storage = await open()
        },
        async close() {
          await storage.close().catch(() => {})
          await database.close()
        },
      }
    },
  )
}
