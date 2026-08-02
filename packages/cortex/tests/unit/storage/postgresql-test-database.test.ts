import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

async function settleDriverEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

describePostgreSql('disposable PostgreSQL database cleanup', () => {
  it('waits for normal client shutdown without force-killing parallel sockets', async () => {
    const databases = await Promise.all(Array.from({ length: 4 }, () =>
      createDisposablePostgreSqlDatabase(TEST_URL!)))
    const clients = databases.map((database) => new Client({
      connectionString: database.url,
      ssl: false,
      application_name: 'ownware-disposable-cleanup-regression',
    }))
    const driverErrors: unknown[] = []
    for (const client of clients) client.on('error', (error) => driverErrors.push(error))
    try {
      await Promise.all(clients.map((client) => client.connect()))
      const cleanup = Promise.all(databases.map((database) => database.close()))
      await settleDriverEvents()
      await Promise.all(clients.map((client) => client.end()))
      await cleanup
      await settleDriverEvents()
      expect(driverErrors).toEqual([])
    } finally {
      await Promise.all(clients.map((client) => client.end().catch(() => {})))
      await Promise.all(databases.map((database) => database.close().catch(() => {})))
    }
  })

  it('reports a bounded active-session leak and permits cleanup after the leak closes', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!, {
      cleanupTimeoutMs: 75,
    })
    const leaked = new Client({
      connectionString: database.url,
      ssl: false,
      application_name: 'ownware-disposable-cleanup-leak',
    })
    const driverErrors: unknown[] = []
    leaked.on('error', (error) => driverErrors.push(error))
    try {
      await leaked.connect()
      await expect(database.close()).rejects.toThrow(
        'Disposable PostgreSQL database cleanup remained blocked for 75 ms; ' +
        'observed 1 active session(s).',
      )
      expect(driverErrors).toEqual([])
      await leaked.end()
      await database.close()
      await settleDriverEvents()
      expect(driverErrors).toEqual([])
    } finally {
      await leaked.end().catch(() => {})
      await database.close().catch(() => {})
    }
  })
})
