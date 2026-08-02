import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { POSTGRESQL_BASELINE_SQL } from '../../../src/storage/postgresql-baseline.js'
import {
  postgreSqlCatalogMatchesBaselineV82,
} from '../../../src/storage/postgresql-catalog-certification.js'
import { inspectPostgreSqlBaseline } from '../../../src/storage/postgresql-schema.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

describePostgreSql('PostgreSQL exact schema catalog', () => {
  it('recognizes the compiled baseline directly from authoritative catalogs', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const client = new Client({ connectionString: database.url, ssl: false })
    try {
      await client.connect()
      await client.query('CREATE SCHEMA ownware AUTHORIZATION CURRENT_USER')
      await client.query('SET search_path TO ownware, pg_catalog')
      await client.query(POSTGRESQL_BASELINE_SQL)
      await expect(inspectPostgreSqlBaseline(client)).resolves.toBe('matches')
      await expect(postgreSqlCatalogMatchesBaselineV82(client)).resolves.toBe(true)
    } finally {
      await client.end().catch(() => {})
      await database.close()
    }
  })
})
