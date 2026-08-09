import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqlitePluginRepository } from '../../../src/storage/sqlite-plugin-repository.js'
import type { PluginRepository } from '../../../src/storage/plugin-repository.js'
import {
  runPluginRepositoryContract,
  type PluginRepositoryHarness,
} from '../../storage/plugin-repository-contract.js'

runPluginRepositoryContract('production SQLite', async (): Promise<PluginRepositoryHarness> => {
  const directory = mkdtempSync(join(tmpdir(), 'ownware-plugin-repository-'))
  const dbPath = join(directory, 'ownware.db')
  type Root = { readonly plugins: PluginRepository }
  let adapter = open()

  function open() {
    return new SqliteStorageAdapter<Root, object>({
      dbPath,
      openMode: 'eager',
      repositories: {
        createRoot: context => ({ plugins: createSqlitePluginRepository(context) }),
        createTransaction: () => ({}),
      },
    })
  }

  return {
    get repository() {
      return adapter.repositories.plugins
    },
    async reopen() {
      await adapter.close()
      adapter = open()
      return adapter.repositories.plugins
    },
    async close() {
      await adapter.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
})
