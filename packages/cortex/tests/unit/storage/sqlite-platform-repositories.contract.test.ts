import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryEventBus } from '../../../src/memory/event-bus.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import type { PlatformRepositories } from '../../../src/storage/platform-repositories.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteCoreRepositories } from '../../../src/storage/sqlite-core-repositories.js'
import { createSqlitePlatformRepositories } from '../../../src/storage/sqlite-platform-repositories.js'
import { TaskEventBus } from '../../../src/tasks/event-bus.js'
import {
  runPlatformRepositoryContract,
  type PlatformRepositoryHarness,
  type PlatformRepositoryPeer,
} from '../../storage/platform-repositories-contract.js'

interface Repositories {
  readonly core: CoreStorageRepositories
  readonly platform: PlatformRepositories
}

runPlatformRepositoryContract(
  'production SQLite',
  async (): Promise<PlatformRepositoryHarness> => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-platform-repositories-'))
    const dbPath = join(directory, 'ownware.db')
    const peers = new Set<SqliteStorageAdapter<Repositories, Record<string, never>>>()
    let adapter = open()

    function open(): SqliteStorageAdapter<Repositories, Record<string, never>> {
      const taskEvents = new TaskEventBus()
      const memoryEvents = new MemoryEventBus()
      return new SqliteStorageAdapter({
        dbPath,
        openMode: 'eager',
        repositories: {
          createRoot: (context) => ({
            core: createSqliteCoreRepositories(context),
            platform: createSqlitePlatformRepositories(context, { taskEvents, memoryEvents }),
          }),
          createTransaction: () => ({}),
        },
      })
    }

    async function closePeer(
      peer: SqliteStorageAdapter<Repositories, Record<string, never>>,
    ): Promise<void> {
      if (!peers.delete(peer)) return
      await peer.close()
    }

    return {
      get repositories() {
        return adapter.repositories.platform
      },
      get core() {
        return adapter.repositories.core
      },
      async openPeer(): Promise<PlatformRepositoryPeer> {
        const peer = open()
        peers.add(peer)
        return {
          repositories: peer.repositories.platform,
          close: () => closePeer(peer),
        }
      },
      async reopen() {
        await adapter.close()
        adapter = open()
      },
      async close() {
        await Promise.all([...peers].map(closePeer))
        await adapter.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  },
)
