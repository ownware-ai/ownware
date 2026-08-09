import { describe, it } from 'vitest'
import { PostgreSqlStorageAdapter } from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import { createPostgreSqlPluginRepository } from '../../../src/storage/postgresql-plugin-repository.js'
import type { PluginRepository } from '../../../src/storage/plugin-repository.js'
import { runPluginRepositoryContract } from '../../storage/plugin-repository-contract.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()

if (TEST_URL === undefined) {
  describe.skip('plugin repository contract — postgresql', () => {
    it('requires OWNWARE_TEST_POSTGRES_URL', () => {})
  })
} else {
  runPluginRepositoryContract('postgresql', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL)
    const plan = validateStoragePlan({
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    }, '/unused.db')
    if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')

    type Root = { readonly plugins: PluginRepository }
    const open = async () => {
      const adapter = new PostgreSqlStorageAdapter<Root, object>({
        plan,
        repositories: {
          createRoot: context => ({ plugins: createPostgreSqlPluginRepository(context) }),
          createTransaction: () => ({}),
        },
      })
      await adapter.initialize()
      return adapter
    }

    let adapter = await open()
    return {
      get repository() {
        return adapter.repositories.plugins
      },
      async reopen() {
        await adapter.close()
        adapter = await open()
        return adapter.repositories.plugins
      },
      async close() {
        await adapter.close().catch(() => {})
        await database.close()
      },
    }
  })
}
