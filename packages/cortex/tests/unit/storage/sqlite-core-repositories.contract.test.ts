import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteCoreRepositories } from '../../../src/storage/sqlite-core-repositories.js'
import {
  runCoreRepositoryContract,
  type CoreRepositoryHarness,
} from '../../storage/core-repositories-contract.js'

runCoreRepositoryContract('production SQLite', async (): Promise<CoreRepositoryHarness> => {
  const directory = mkdtempSync(join(tmpdir(), 'cortex-core-repositories-'))
  const dbPath = join(directory, 'ownware.db')
  let adapter = open()

  function open() {
    return new SqliteStorageAdapter({
      dbPath,
      openMode: 'eager',
      repositories: {
        createRoot: createSqliteCoreRepositories,
        createTransaction: () => Object.freeze({}),
      },
    })
  }

  return {
    get repositories() {
      return adapter.repositories
    },
    async reopen() {
      await adapter.close()
      adapter = open()
      return adapter.repositories
    },
    async close() {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
})
