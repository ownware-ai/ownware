import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'
import type { SourceRepositories } from '../../../src/storage/source-repositories.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteSourceRepositories } from '../../../src/storage/sqlite-source-repositories.js'
import {
  runSourceRepositoryContract,
  type SourceRepositoryHarness,
  type SourceRepositoryPeer,
} from '../../storage/source-repositories-contract.js'

interface Repositories {
  readonly sources: SourceRepositories
}

const quotaLimits: SourceQuotaLimits = {
  workspace: limits(),
  profile: limits(),
}

runSourceRepositoryContract(
  'production SQLite',
  async (): Promise<SourceRepositoryHarness> => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-source-repositories-'))
    const dbPath = join(directory, 'ownware.db')
    const peers = new Set<SqliteStorageAdapter<Repositories, Record<string, never>>>()
    let adapter = open()

    function open(): SqliteStorageAdapter<Repositories, Record<string, never>> {
      return new SqliteStorageAdapter({
        dbPath,
        openMode: 'eager',
        repositories: {
          createRoot: (context) => ({
            sources: createSqliteSourceRepositories(context, { quotaLimits }),
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
        return adapter.repositories.sources
      },
      async openPeer(): Promise<SourceRepositoryPeer> {
        const peer = open()
        peers.add(peer)
        return {
          repositories: peer.repositories.sources,
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

function limits() {
  return {
    maxSourceRegistrations: 4,
    maxRetainedAndReservedBytes: 1024,
    maxActiveUploadSessions: 8,
    maxNonterminalJobs: 8,
    maxDerivedResources: 8,
  }
}
