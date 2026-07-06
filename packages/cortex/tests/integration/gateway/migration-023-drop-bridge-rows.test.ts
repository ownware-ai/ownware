/**
 * Tests for migration 023 — drop legacy bridge rows from mcp_servers.
 *
 * Seeds the pre-023 state with a mix of rows (legacy bridge, Spotlight
 * detected non-bridge, user-registered), runs the migration, asserts
 * only the bridge rows are gone, all other rows preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dbPath: string
let dbDir: string
let db: Database.Database

beforeEach(async () => {
  dbDir = await mkdtemp(join(tmpdir(), 'cortex-mig023-'))
  dbPath = join(dbDir, 'test.db')
  db = new Database(dbPath)
  // Apply 1..22 to set up the pre-023 baseline.
  for (const m of MIGRATIONS) {
    if (m.version >= 23) break
    db.exec(m.sql)
    db.prepare(
      'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
    ).run(m.version, m.name, Date.now())
  }
})

afterEach(async () => {
  db.close()
  await rm(dbDir, { recursive: true, force: true })
})

function applyMigration023(): void {
  const m = MIGRATIONS.find((x) => x.version === 23)
  if (!m) throw new Error('migration 023 not found in MIGRATIONS')
  db.exec(m.sql)
}

function seedServer(opts: {
  id: string
  name?: string
  transport: string
  url?: string | null
  command?: string | null
  registryId: string | null
}): void {
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, url, command, registry_id) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.name ?? opts.id,
    opts.transport,
    opts.url ?? null,
    opts.command ?? null,
    opts.registryId,
  )
}

function listServerIds(): string[] {
  return (db.prepare('SELECT id FROM mcp_servers ORDER BY id').all() as { id: string }[]).map(
    (r) => r.id,
  )
}

describe('migration 023 — drop legacy bridge rows', () => {
  it('deletes a 127.0.0.1 detected http row (the bridge case)', () => {
    seedServer({
      id: 'paper',
      transport: 'http',
      url: 'http://127.0.0.1:29979/mcp',
      registryId: 'detected',
    })
    expect(listServerIds()).toEqual(['paper'])
    applyMigration023()
    expect(listServerIds()).toEqual([])
  })

  it('deletes a localhost detected http row', () => {
    seedServer({
      id: 'pencil',
      transport: 'http',
      url: 'http://localhost:18080/mcp',
      registryId: 'detected',
    })
    applyMigration023()
    expect(listServerIds()).toEqual([])
  })

  it('preserves a non-bridge detected row (Spotlight-imported public URL)', () => {
    seedServer({
      id: 'figma-detected',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      registryId: 'detected',
    })
    applyMigration023()
    expect(listServerIds()).toEqual(['figma-detected'])
  })

  it('preserves a detected stdio row (Claude Desktop import)', () => {
    seedServer({
      id: 'fs-from-claude',
      transport: 'stdio',
      command: 'npx',
      registryId: 'detected',
    })
    applyMigration023()
    expect(listServerIds()).toEqual(['fs-from-claude'])
  })

  it('preserves a user-registered row even if it points at localhost', () => {
    // User explicitly registered a local-bound MCP server via /mcp/register.
    // registry_id='custom' (not 'detected') means user-owned — keep.
    seedServer({
      id: 'my-local',
      transport: 'http',
      url: 'http://127.0.0.1:9000/mcp',
      registryId: 'custom',
    })
    applyMigration023()
    expect(listServerIds()).toEqual(['my-local'])
  })

  it('preserves rows with NULL registry_id (legacy unmarked installs)', () => {
    seedServer({
      id: 'unmarked',
      transport: 'http',
      url: 'http://127.0.0.1:1111/mcp',
      registryId: null,
    })
    applyMigration023()
    expect(listServerIds()).toEqual(['unmarked'])
  })

  it('is idempotent — second run is a no-op', () => {
    seedServer({
      id: 'paper',
      transport: 'http',
      url: 'http://127.0.0.1:29979/mcp',
      registryId: 'detected',
    })
    applyMigration023()
    expect(listServerIds()).toEqual([])
    applyMigration023()
    expect(listServerIds()).toEqual([])
  })

  it('mixed rows — only the bridge row is deleted', () => {
    seedServer({
      id: 'paper',
      transport: 'http',
      url: 'http://127.0.0.1:29979/mcp',
      registryId: 'detected',
    })
    seedServer({
      id: 'figma-remote',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      registryId: 'detected',
    })
    seedServer({
      id: 'my-custom',
      transport: 'stdio',
      command: 'npx',
      registryId: 'custom',
    })
    applyMigration023()
    expect(listServerIds()).toEqual(['figma-remote', 'my-custom'])
  })
})
