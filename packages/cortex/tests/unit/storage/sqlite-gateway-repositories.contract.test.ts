import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import type { GatewayRepositories } from '../../../src/storage/gateway-repositories.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteCoreRepositories } from '../../../src/storage/sqlite-core-repositories.js'
import { createSqliteGatewayRepositories } from '../../../src/storage/sqlite-gateway-repositories.js'
import {
  runGatewayRepositoryContract,
  type GatewayRepositoryHarness,
} from '../../storage/gateway-repositories-contract.js'

interface Repositories {
  readonly core: CoreStorageRepositories
  readonly gateway: GatewayRepositories
}

runGatewayRepositoryContract(
  'production SQLite',
  async (): Promise<GatewayRepositoryHarness> => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-gateway-repositories-'))
    const dbPath = join(directory, 'ownware.db')
    let adapter = open()

    function open(): SqliteStorageAdapter<Repositories, Record<string, never>> {
      return new SqliteStorageAdapter({
        dbPath,
        openMode: 'eager',
        repositories: {
          createRoot: (context) => ({
            core: createSqliteCoreRepositories(context),
            gateway: createSqliteGatewayRepositories(context),
          }),
          createTransaction: () => ({}),
        },
      })
    }

    return {
      get repositories() {
        return adapter.repositories.gateway
      },
      get core() {
        return adapter.repositories.core
      },
      async reopen() {
        await adapter.close()
        adapter = open()
      },
      async close() {
        await adapter.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  },
)
