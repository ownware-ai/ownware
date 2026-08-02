import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  StorageLifecycleError,
  StorageTransactionError,
} from '../../../src/storage/contracts.js'
import {
  SqliteStorageAdapter,
  type SqliteRootRepositoryContext,
  type SqliteTransactionRepositoryContext,
} from '../../../src/storage/sqlite-adapter.js'

interface ProbeRepository {
  create(): Promise<void>
  insert(id: string, value: string): Promise<void>
  get(id: string): Promise<string | null>
  count(): Promise<number>
}

function probe(context: SqliteTransactionRepositoryContext): ProbeRepository {
  return {
    async create() {
      context.assertActive()
      context.database.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    },
    async insert(id, value) {
      context.assertActive()
      context.database.prepare('INSERT INTO probe (id, value) VALUES (?, ?)').run(id, value)
    },
    async get(id) {
      context.assertActive()
      const row = context.database.prepare('SELECT value FROM probe WHERE id = ?')
        .get(id) as { value: string } | undefined
      return row?.value ?? null
    },
    async count() {
      context.assertActive()
      return (context.database.prepare('SELECT COUNT(*) AS count FROM probe').get() as {
        count: number
      }).count
    },
  }
}

function factories() {
  return {
    createRoot(context: SqliteRootRepositoryContext): ProbeRepository {
      context.database.exec('CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
      return probe(context)
    },
    createTransaction(context: SqliteTransactionRepositoryContext): ProbeRepository {
      return probe(context)
    },
  }
}

const write = {
  mode: 'write',
  isolation: 'serializable',
  retry: 'never',
} as const

describe('SQLite storage adapter lifecycle', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function path(name = 'storage.db'): string {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-storage-adapter-'))
    dirs.push(dir)
    return join(dir, name)
  }

  it('initializes once, reports the migrated schema, and closes idempotently', async () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'on-initialize',
      repositories: factories(),
    })
    expect(adapter.lifecycleState).toBe('new')
    expect(() => adapter.repositories).toThrow(StorageLifecycleError)
    const first = adapter.initialize()
    const second = adapter.initialize()
    expect(second).toBe(first)
    await first
    expect(adapter.lifecycleState).toBe('ready')
    await expect(adapter.health()).resolves.toMatchObject({
      kind: 'sqlite',
      state: 'ready',
      schemaVersion: MIGRATIONS.at(-1)!.version,
    })
    await adapter.close()
    await adapter.close()
    expect(adapter.lifecycleState).toBe('closed')
    await expect(adapter.health()).resolves.toMatchObject({
      state: 'unavailable',
      code: 'lifecycle_closed',
    })
  })

  it('preserves eager constructor-time open and synchronous close compatibility', () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: factories(),
    })
    expect(adapter.lifecycleState).toBe('ready')
    const handle = adapter.legacyDatabase.rawMainHandle
    adapter.closeSynchronouslyForLegacyCaller()
    adapter.closeSynchronouslyForLegacyCaller()
    expect(adapter.lifecycleState).toBe('closed')
    expect(handle.open).toBe(false)
  })

  it('commits, rolls back, saves points, and expires transaction repositories', async () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: factories(),
    })
    let expired: ProbeRepository | undefined
    await adapter.transaction(write, async (tx) => {
      expired = tx.repositories
      await tx.repositories.insert('committed', 'yes')
      await expect(tx.savepoint(async (nested) => {
        await nested.repositories.insert('savepoint-rollback', 'no')
        throw new Error('savepoint failure')
      })).rejects.toThrow('savepoint failure')
      await tx.repositories.insert('after-savepoint', 'yes')
    })
    expect(await adapter.repositories.count()).toBe(2)
    expect(await adapter.repositories.get('savepoint-rollback')).toBeNull()
    await expect(expired!.count()).rejects.toThrow(
      expect.objectContaining<Partial<StorageLifecycleError>>({
        code: 'transaction_scope_expired',
      }),
    )

    await expect(adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('rolled-back', 'no')
      throw new Error('outer failure')
    })).rejects.toThrow('outer failure')
    expect(await adapter.repositories.get('rolled-back')).toBeNull()
    await adapter.close()
  })

  it('serializes transactions, blocks native root access, and rejects nested roots', async () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: factories(),
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('first', 'one')
      await expect(adapter.repositories.count()).rejects.toThrow(
        expect.objectContaining<Partial<StorageLifecycleError>>({
          code: 'root_access_during_transaction',
        }),
      )
      await expect(adapter.transaction(write, async () => undefined)).rejects.toThrow(
        expect.objectContaining<Partial<StorageLifecycleError>>({
          code: 'nested_transaction_requires_savepoint',
        }),
      )
      await gate
    })
    const second = adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('second', 'two')
    })
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(await adapter.repositories.count()).toBe(2)
    await adapter.close()
  })

  it('waits for an active transaction before close and rejects queued work', async () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: factories(),
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const active = adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('before-close', 'durable')
      await gate
      await tx.repositories.insert('during-close', 'durable')
    })
    await Promise.resolve()
    const close = adapter.close()
    expect(adapter.lifecycleState).toBe('closing')
    const queued = adapter.transaction(write, async () => undefined)
    release()
    await active
    await expect(queued).rejects.toThrow(StorageLifecycleError)
    await close
    expect(adapter.lifecycleState).toBe('closed')
  })

  it('recovers its transaction state after an external SQLite lock', async () => {
    const dbPath = path()
    const adapter = new SqliteStorageAdapter({
      dbPath,
      openMode: 'eager',
      repositories: factories(),
    })
    adapter.legacyDatabase.rawMainHandle.pragma('busy_timeout = 1')
    const blocker = new Database(dbPath)
    blocker.exec('BEGIN IMMEDIATE')
    let callbackInvoked = false
    try {
      await expect(adapter.transaction(write, async (tx) => {
        callbackInvoked = true
        await tx.repositories.insert('blocked', 'never-written')
      })).rejects.toThrow(expect.objectContaining<Partial<StorageTransactionError>>({
        code: 'transaction_busy',
        kind: 'sqlite',
        phase: 'begin',
        retryable: true,
        callbackInvoked: false,
      }))
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }

    expect(callbackInvoked).toBe(false)
    expect(await adapter.repositories.get('blocked')).toBeNull()
    await adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('after-lock', 'written')
    })
    expect(await adapter.repositories.get('after-lock')).toBe('written')
    await adapter.close()
  })

  it('rejects malformed transaction options instead of weakening semantics', async () => {
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: factories(),
    })
    let callbackInvoked = false
    await expect(adapter.transaction({
      mode: 'write',
      isolation: 'serializable',
      retry: 'automatic',
    } as unknown as typeof write, async () => {
      callbackInvoked = true
    })).rejects.toThrow(expect.objectContaining<Partial<StorageLifecycleError>>({
      code: 'transaction_options_invalid',
    }))
    expect(callbackInvoked).toBe(false)
    await adapter.close()
  })

  it('rolls back the outer transaction if nested repository construction fails', async () => {
    const repositoryFactories = factories()
    let transactionFactoryCalls = 0
    const adapter = new SqliteStorageAdapter({
      dbPath: path(),
      openMode: 'eager',
      repositories: {
        createRoot: repositoryFactories.createRoot,
        createTransaction(context: SqliteTransactionRepositoryContext) {
          transactionFactoryCalls += 1
          if (transactionFactoryCalls === 2) throw new Error('nested factory failure')
          return repositoryFactories.createTransaction(context)
        },
      },
    })

    await expect(adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('before-nested-failure', 'rolled-back')
      await tx.savepoint(async () => undefined)
    })).rejects.toThrow('nested factory failure')
    expect(adapter.legacyDatabase.rawMainHandle.inTransaction).toBe(false)
    expect(await adapter.repositories.get('before-nested-failure')).toBeNull()

    await adapter.transaction(write, async (tx) => {
      await tx.repositories.insert('after-nested-failure', 'written')
    })
    expect(await adapter.repositories.get('after-nested-failure')).toBe('written')
    await adapter.close()
  })

  it('cancels close-during-initialize before opening SQLite', async () => {
    const dbPath = path()
    const adapter = new SqliteStorageAdapter({
      dbPath,
      openMode: 'on-initialize',
      repositories: factories(),
    })
    const initialize = adapter.initialize()
    const close = adapter.close()
    await expect(initialize).rejects.toThrow(
      expect.objectContaining<Partial<StorageLifecycleError>>({
        code: 'initialize_cancelled',
      }),
    )
    await close
    expect(adapter.lifecycleState).toBe('closed')
  })

  it('fails initialization honestly and never treats a directory as a database', async () => {
    const directoryPath = path('database-directory')
    // Replace the not-yet-created filename with an actual directory target.
    const directory = join(directoryPath, '..')
    const adapter = new SqliteStorageAdapter({
      dbPath: directory,
      openMode: 'on-initialize',
      repositories: factories(),
    })
    await expect(adapter.initialize()).rejects.toThrow()
    expect(adapter.lifecycleState).toBe('failed')
    await expect(adapter.initialize()).rejects.toThrow(
      expect.objectContaining<Partial<StorageLifecycleError>>({
        code: 'initialize_after_failure',
      }),
    )
    await adapter.close()
    expect(adapter.lifecycleState).toBe('closed')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails before creating a database in an unwritable directory',
    async () => {
      const dbPath = path('read-only/ownware.db')
      const directory = join(dbPath, '..')
      mkdirSync(directory)
      chmodSync(directory, 0o500)
      try {
        const adapter = new SqliteStorageAdapter({
          dbPath,
          openMode: 'on-initialize',
          repositories: factories(),
        })
        await expect(adapter.initialize()).rejects.toThrow()
        expect(adapter.lifecycleState).toBe('failed')
        expect(existsSync(dbPath)).toBe(false)
        await adapter.close()
      } finally {
        chmodSync(directory, 0o700)
      }
    },
  )
})
