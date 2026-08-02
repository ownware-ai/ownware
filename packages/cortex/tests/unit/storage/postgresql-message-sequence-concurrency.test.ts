import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan } from '../../../src/storage/config.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

interface RootRepositories {
  readonly core: CoreStorageRepositories
}

const FACTORIES: PostgreSqlRepositoryFactories<RootRepositories, object> = {
  createRoot: (context) => ({ core: createPostgreSqlCoreRepositories(context) }),
  createTransaction: () => ({}),
}

function adapter(url: string): PostgreSqlStorageAdapter<RootRepositories, object> {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { maxConnections: 12 },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return new PostgreSqlStorageAdapter({ plan: selected, repositories: FACTORIES })
}

describePostgreSql('PostgreSQL durable message sequencing', () => {
  it('serializes concurrent same-thread appends into one contiguous committed order', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = adapter(database.url)
    const inspector = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await inspector.connect()
      const thread = await storage.repositories.core.threads.create('message-sequence')
      const ids = Array.from({ length: 32 }, (_, index) =>
        `message-${String(31 - index).padStart(2, '0')}`)
      const timestamp = '2026-08-02T00:00:00.000Z'

      await Promise.all(ids.map((id) => storage.repositories.core.messages.add(thread.id, {
        id,
        role: 'assistant',
        content: id,
        timestamp,
      })))

      const raw = (await inspector.query<{
        readonly id: string
        readonly message_seq: string
      }>(`
        SELECT message.id, message.message_seq::text AS message_seq
        FROM ownware.messages AS message
        WHERE message.thread_id = $1 ORDER BY message.message_seq
      `, [thread.id])).rows
      expect(raw.map(({ message_seq }) => Number(message_seq)))
        .toEqual(Array.from({ length: ids.length }, (_, index) => index + 1))
      expect(new Set(raw.map(({ id }) => id))).toEqual(new Set(ids))
      expect((await storage.repositories.core.messages.list(thread.id)).map(({ id }) => id))
        .toEqual(raw.map(({ id }) => id))
      await expect(storage.repositories.core.threads.get(thread.id)).resolves.toMatchObject({
        messageCount: ids.length,
      })
    } finally {
      await storage.close().catch(() => {})
      await inspector.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)

  it('leaves no sequence or aggregate effect after failed appends and refuses unsafe overflow', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = adapter(database.url)
    const inspector = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await inspector.connect()
      const thread = await storage.repositories.core.threads.create('message-sequence-failure')
      const message = (id: string) => ({
        id,
        role: 'user' as const,
        content: id,
        timestamp: '2026-08-02T00:00:00.000Z',
      })

      await storage.repositories.core.messages.add(thread.id, message('message-first'))
      await expect(storage.repositories.core.messages.add(
        thread.id,
        message('message-first'),
      )).rejects.toMatchObject({ code: 'write_failed' })
      await expect(storage.repositories.core.messages.add(
        'missing-thread',
        message('message-missing-thread'),
      )).rejects.toMatchObject({ code: 'write_failed' })
      await storage.repositories.core.messages.add(thread.id, message('message-second'))

      expect((await inspector.query(`
        SELECT message.id, message.message_seq::text AS message_seq
        FROM ownware.messages AS message
        WHERE message.thread_id = $1 ORDER BY message.message_seq
      `, [thread.id])).rows).toEqual([
        { id: 'message-first', message_seq: '1' },
        { id: 'message-second', message_seq: '2' },
      ])
      await expect(storage.repositories.core.threads.get(thread.id)).resolves.toMatchObject({
        messageCount: 2,
      })

      await inspector.query(`
        UPDATE ownware.messages SET message_seq = 9007199254740991
        WHERE id = 'message-second'
      `)
      await expect(storage.repositories.core.messages.add(
        thread.id,
        message('message-overflow'),
      )).rejects.toThrow('Message sequence exhausted the safe integer domain.')
      await expect(storage.repositories.core.threads.get(thread.id)).resolves.toMatchObject({
        messageCount: 2,
      })
      expect((await inspector.query(`
        SELECT count(*)::text AS count FROM ownware.messages
        WHERE thread_id = $1
      `, [thread.id])).rows).toEqual([{ count: '2' }])
    } finally {
      await storage.close().catch(() => {})
      await inspector.end().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)
})
