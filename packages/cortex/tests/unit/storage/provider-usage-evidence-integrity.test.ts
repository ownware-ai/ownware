import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import type { PricebookEntry, UsageLedgerEntry } from '../../../src/provider-hub/schema.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqliteCoreRepositories } from '../../../src/storage/sqlite-core-repositories.js'

const NOW = '2026-08-09T04:00:00.000Z'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ownware-usage-evidence-integrity-'))
  directories.push(directory)
  return join(directory, 'ownware.db')
}

function price(): PricebookEntry {
  return {
    id: 'price:integrity',
    version: 'catalog-v1',
    currency: 'USD',
    scope: {
      providerRouteId: 'provider:api',
      modelRouteId: 'provider:model',
    },
    rates: [{ dimension: 'input_text_tokens', unitSize: 1_000, amountUsd: 0.25 }],
    effectiveFrom: null,
    effectiveUntil: null,
    source: {
      kind: 'manual',
      sourceRef: 'fixture:integrity',
      retrievedAt: NOW,
    },
  }
}

function usage(): UsageLedgerEntry {
  return {
    id: 'usage:integrity',
    occurredAt: NOW,
    providerFamilyId: 'provider',
    providerRouteId: 'provider:api',
    modelRouteId: 'provider:model',
    wireModelId: 'model',
    billingKind: 'metered',
    tokens: { inputTextTokens: 10, outputTextTokens: 2 },
    units: { requests: 1 },
    cost: {
      classification: 'estimated',
      amountUsd: 0.003,
      currency: 'USD',
      pricebookEntryId: 'price:integrity',
      pricebookVersion: 'catalog-v1',
      observedAt: NOW,
    },
    providerFacts: { requestId: 'provider-request' },
    success: true,
  }
}

function openAdapter(path: string) {
  return new SqliteStorageAdapter({
    dbPath: path,
    openMode: 'eager',
    repositories: {
      createRoot: createSqliteCoreRepositories,
      createTransaction: () => Object.freeze({}),
    },
  })
}

describe('provider usage evidence integrity', () => {
  it('enforces update and delete immutability for every evidence table', () => {
    const path = databasePath()
    const db = new Database(path)
    db.pragma('foreign_keys = ON')
    runMigrationsSafely(db, path, MIGRATIONS)
    db.prepare(`
      INSERT INTO provider_pricebook_snapshots (
        entry_id, version, payload_json, payload_sha256, recorded_at
      ) VALUES ('price-a', 'v1', '{}', ?, ?)
    `).run(`sha256:${'0'.repeat(64)}`, NOW)
    db.prepare(`
      INSERT INTO provider_usage_facts (
        id, occurred_at, provider_family_id, provider_route_id, model_route_id,
        wire_model_id, billing_kind, tokens_json, units_json,
        provider_facts_json, success, recorded_at
      ) VALUES ('usage-a', ?, 'family', 'route', 'model', 'wire', 'unknown',
        '{}', '{}', '{}', 1, ?)
    `).run(NOW, NOW)
    db.prepare(`
      INSERT INTO provider_usage_cost_observations (
        id, usage_id, observation_seq, classification, amount_usd, currency,
        observed_at, recorded_at
      ) VALUES ('cost-a', 'usage-a', 1, 'unknown', NULL, 'USD', ?, ?)
    `).run(NOW, NOW)

    const mutations = [
      'UPDATE provider_pricebook_snapshots SET recorded_at = recorded_at',
      'DELETE FROM provider_pricebook_snapshots',
      'UPDATE provider_usage_facts SET recorded_at = recorded_at',
      'DELETE FROM provider_usage_facts',
      'UPDATE provider_usage_cost_observations SET recorded_at = recorded_at',
      'DELETE FROM provider_usage_cost_observations',
    ]
    for (const sql of mutations) {
      expect(() => db.exec(sql)).toThrow('immutable provider usage evidence')
    }
    expect(db.prepare('SELECT count(*) AS count FROM provider_pricebook_snapshots').get())
      .toEqual({ count: 1 })
    expect(db.prepare('SELECT count(*) AS count FROM provider_usage_facts').get())
      .toEqual({ count: 1 })
    expect(db.prepare('SELECT count(*) AS count FROM provider_usage_cost_observations').get())
      .toEqual({ count: 1 })
    db.close()
  })

  it('fails closed when stored price bytes no longer match their immutable digest', async () => {
    const path = databasePath()
    let adapter = openAdapter(path)
    await adapter.repositories.usageEvidence.record(usage(), price())
    await adapter.close()

    const db = new Database(path)
    db.exec('DROP TRIGGER provider_pricebook_snapshots_no_update')
    db.prepare(`
      UPDATE provider_pricebook_snapshots
      SET payload_json = '{"id":"different-but-valid-json"}'
      WHERE entry_id = ? AND version = ?
    `).run(price().id, price().version)
    db.close()

    adapter = openAdapter(path)
    await expect(adapter.repositories.usageEvidence.getPriceSnapshot(
      price().id,
      price().version,
    )).rejects.toMatchObject({
      name: 'UsageEvidenceIntegrityError',
      code: 'snapshot_corrupt',
    })
    await adapter.close()
  })
})
