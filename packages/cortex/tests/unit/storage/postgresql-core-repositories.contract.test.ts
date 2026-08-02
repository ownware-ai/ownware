import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { runCoreRepositoryContract } from '../../storage/core-repositories-contract.js'
import { describe, it } from 'vitest'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()

if (TEST_URL === undefined) {
  describe.skip('core storage repository contract — postgresql', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  runCoreRepositoryContract('postgresql', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL)
    const validated = validateStoragePlan({
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    }, '/unused.db')
    if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

    type Root = { readonly core: CoreStorageRepositories }
    const open = async (): Promise<PostgreSqlStorageAdapter<Root, object>> => {
      const storage = new PostgreSqlStorageAdapter<Root, object>({
        plan: validated,
        repositories: {
          createRoot: (context) => ({ core: createPostgreSqlCoreRepositories(context) }),
          createTransaction: () => ({}),
        },
      })
      await storage.initialize()
      return storage
    }

    let storage = await open()
    return {
      repositories: storage.repositories.core,
      async reopen() {
        await storage.close()
        storage = await open()
        return storage.repositories.core
      },
      async close() {
        await storage.close().catch(() => {})
        await database.close()
      },
    }
  })
}
