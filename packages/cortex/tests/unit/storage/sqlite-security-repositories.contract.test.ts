import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import type {
  SecurityRepositories,
  SecurityTransactionRepositories,
} from '../../../src/storage/security-repositories.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteCoreRepositories } from '../../../src/storage/sqlite-core-repositories.js'
import {
  createSqliteSecurityRepositories,
  createSqliteSecurityTransactionRepositories,
} from '../../../src/storage/sqlite-security-repositories.js'
import {
  runSecurityRepositoryContract,
  type SecurityRepositoryHarness,
  type SecurityRepositoryPeer,
} from '../../storage/security-repositories-contract.js'

interface Repositories {
  readonly core: CoreStorageRepositories
  readonly security: SecurityRepositories
}

const permissionHashSecret = 'contract-permission-secret'

runSecurityRepositoryContract(
  'production SQLite',
  async (): Promise<SecurityRepositoryHarness> => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-security-repositories-'))
    const dbPath = join(directory, 'ownware.db')
    const previousMasterKey = process.env['OWNWARE_MASTER_KEY']
    process.env['OWNWARE_MASTER_KEY'] = 'ab'.repeat(32)
    __resetMasterKeyCacheForTests()
    const peers = new Set<SqliteStorageAdapter<Repositories, SecurityTransactionRepositories>>()
    let adapter = open('contract-idempotency-primary', 'contract-oauth-primary')

    function open(
      idempotencyLeaseOwner: string,
      oauthRefreshOwner: string,
    ): SqliteStorageAdapter<Repositories, SecurityTransactionRepositories> {
      return new SqliteStorageAdapter({
        dbPath,
        openMode: 'eager',
        repositories: {
          createRoot: (context) => ({
            core: createSqliteCoreRepositories(context),
            security: createSqliteSecurityRepositories(context, {
              permissionHashSecret,
              idempotencyLeaseOwner,
              oauthRefreshOwner,
            }),
          }),
          createTransaction: createSqliteSecurityTransactionRepositories,
        },
      })
    }

    async function closePeer(
      peer: SqliteStorageAdapter<Repositories, SecurityTransactionRepositories>,
    ): Promise<void> {
      if (!peers.delete(peer)) return
      await peer.close()
    }

    return {
      get repositories() {
        return adapter.repositories.security
      },
      get core() {
        return adapter.repositories.core
      },
      createDelegatedThread(profileId, workspaceId, principalKey) {
        return adapter.transaction(
          { mode: 'write', isolation: 'serializable', retry: 'never' },
          (tx) => tx.repositories.threadAuthority.createAndBind(
            profileId,
            workspaceId,
            principalKey,
          ),
        )
      },
      async openPeer(options): Promise<SecurityRepositoryPeer> {
        const peer = open(options.idempotencyLeaseOwner, options.oauthRefreshOwner)
        peers.add(peer)
        return {
          repositories: peer.repositories.security,
          close: () => closePeer(peer),
        }
      },
      async reopen() {
        await adapter.close()
        adapter = open('contract-idempotency-reopened', 'contract-oauth-reopened')
      },
      async close() {
        await Promise.all([...peers].map(closePeer))
        await adapter.close()
        if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
        else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
        __resetMasterKeyCacheForTests()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  },
)
