/**
 * Tests for migration 022 — DB-level dedup of duplicate mcp_servers
 * rows by logical key.
 *
 * Seeds a pre-022 database state with the production "3 Figma rows"
 * scenario, runs migrations, then asserts the expected post-state:
 * one winning row, all profile assignments preserved on the winner,
 * loser rows gone.
 *
 * Real SQLite via better-sqlite3.
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
  dbDir = await mkdtemp(join(tmpdir(), 'cortex-mig022-'))
  dbPath = join(dbDir, 'test.db')
  db = new Database(dbPath)
  // Apply migrations 1..21 to set up the pre-022 baseline schema.
  // Migration 022 itself is applied per-test so we can seed the
  // pre-state in between.
  for (const m of MIGRATIONS) {
    if (m.version >= 22) break
    db.exec(m.sql)
  }
  // Track applied versions in _migrations.
  for (const m of MIGRATIONS) {
    if (m.version >= 22) break
    db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      m.version,
      m.name,
      Date.now(),
    )
  }
})

afterEach(async () => {
  db.close()
  await rm(dbDir, { recursive: true, force: true })
})

function applyMigration022(): void {
  const m = MIGRATIONS.find(x => x.version === 22)
  if (!m) throw new Error('migration 022 not found in MIGRATIONS')
  db.exec(m.sql)
}

function listServers(): Array<{ id: string; registry_id: string | null; name: string }> {
  return db.prepare('SELECT id, registry_id, name FROM mcp_servers ORDER BY id').all() as Array<{
    id: string
    registry_id: string | null
    name: string
  }>
}

function listAssignments(): Array<{ profile_id: string; server_id: string }> {
  return db
    .prepare('SELECT profile_id, server_id FROM profile_mcp_servers ORDER BY profile_id, server_id')
    .all() as Array<{ profile_id: string; server_id: string }>
}

function seedServer(
  id: string,
  registryId: string | null,
  name = id,
  transport = 'http',
  url = 'https://example.com/mcp',
): void {
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, url, registry_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, transport, url, registryId)
}

function seedAssignment(profileId: string, serverId: string): void {
  db.prepare(
    `INSERT INTO profile_mcp_servers (profile_id, server_id) VALUES (?, ?)`,
  ).run(profileId, serverId)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration 022 — dedup mcp_servers by logical key', () => {
  it('no-op when there are no duplicate logical keys', () => {
    seedServer('paper', 'detected', 'Paper')
    seedServer('pencil', 'detected', 'Pencil')
    seedServer('my-server-c4vrjq3w', 'custom', 'My Server')
    seedAssignment('coder', 'paper')
    seedAssignment('coder', 'pencil')

    applyMigration022()

    const servers = listServers()
    expect(servers.map(s => s.id).sort()).toEqual([
      'my-server-c4vrjq3w',
      'paper',
      'pencil',
    ])
    expect(listAssignments().length).toBe(2)
  })

  it('the production "3 Figma rows" scenario: 1 detected + 1 custom → 1 winner', () => {
    seedServer('figma', 'detected', 'Figma', 'http', 'https://mcp.figma.com/mcp')
    seedServer('figma-c4vrjq3w', 'custom', 'Figma', 'http', 'https://mcp.figma.com/mcp')
    seedAssignment('coder', 'figma')
    seedAssignment('reviewer', 'figma-c4vrjq3w')

    applyMigration022()

    const servers = listServers()
    expect(servers.length).toBe(1)
    // Detected wins over custom.
    expect(servers[0]!.id).toBe('figma')
    expect(servers[0]!.registry_id).toBe('detected')

    // Both profile assignments preserved on the winner.
    const assignments = listAssignments()
    expect(assignments.length).toBe(2)
    expect(assignments.map(a => `${a.profile_id}:${a.server_id}`).sort()).toEqual([
      'coder:figma',
      'reviewer:figma',
    ])
  })

  it('two custom rows for the same logical app collapse to one', () => {
    seedServer('figma-c4vrjq3w', 'custom', 'Figma')
    seedServer('figma-2abcdefg', 'custom', 'Figma alt')
    seedAssignment('coder', 'figma-c4vrjq3w')
    seedAssignment('reviewer', 'figma-2abcdefg')

    applyMigration022()

    const servers = listServers()
    expect(servers.length).toBe(1)
    // Within-tier tie-break: alphabetical by id.
    expect(servers[0]!.id).toBe('figma-2abcdefg')
    expect(listAssignments().length).toBe(2)
  })

  // Note: a custom row and a detected row CANNOT both have id='figma' —
  // mcp_servers.id is the PRIMARY KEY. The dedup matters only when ids
  // differ but logicalKey collides (the auto-suffix-strip case below).

  it('vendor_account_id wins within-tier (live OAuth connection preserved)', () => {
    // Two custom Figma rows; one has a live Composio connection. That
    // row should win even though the other is alphabetically first.
    seedServer('figma-aaaaaaaa', 'custom', 'Figma A')
    seedServer('figma-zzzzzzzz', 'custom', 'Figma Z')
    db.prepare(
      `INSERT INTO connector_connections
        (connection_id, connector_id, source, entity_id, status, initiated_at, vendor_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'conn-1',
      'figma-zzzzzzzz',
      'mcp',
      'cortex-default-user',
      'ready',
      Date.now(),
      'composio-acct-123',
    )

    applyMigration022()

    const servers = listServers()
    expect(servers.length).toBe(1)
    // The Z-suffixed row wins because it has the vendor connection.
    expect(servers[0]!.id).toBe('figma-zzzzzzzz')
  })

  it('assignment dedup: winner already has the assignment (no PK violation)', () => {
    // The winner is already assigned to a profile that the loser is
    // also assigned to. The migration must not error out on the
    // composite-PK collision; it uses INSERT OR IGNORE.
    seedServer('figma', 'detected', 'Figma')
    seedServer('figma-c4vrjq3w', 'custom', 'Figma')
    seedAssignment('coder', 'figma')          // winner already assigned
    seedAssignment('coder', 'figma-c4vrjq3w') // loser also assigned to same profile

    applyMigration022()

    const assignments = listAssignments()
    expect(assignments.length).toBe(1)
    expect(assignments[0]!.server_id).toBe('figma')
  })

  it('does NOT touch rows whose registry_id is NULL (profile-sync rows)', () => {
    // Profile-sync rows (registry_id NULL) are handled by the boot
    // reconcile (Phase 5.2), not this migration.
    seedServer('synced-server', null, 'Synced')
    seedAssignment('coder', 'synced-server')

    applyMigration022()

    const servers = listServers()
    expect(servers.find(s => s.id === 'synced-server')).toBeDefined()
  })

  it('does NOT collapse rows of DIFFERENT logical keys', () => {
    seedServer('figma', 'detected', 'Figma')
    seedServer('slack', 'detected', 'Slack')
    seedServer('paper-2abcdefg', 'custom', 'Paper')
    seedServer('pencil-3abcdefg', 'custom', 'Pencil')

    applyMigration022()

    const servers = listServers()
    expect(servers.length).toBe(4)
  })

  it('idempotent: running migration 022 twice on already-deduped data is a no-op', () => {
    seedServer('figma', 'detected', 'Figma')
    seedServer('figma-c4vrjq3w', 'custom', 'Figma')

    applyMigration022()
    const after1 = listServers()

    applyMigration022()
    const after2 = listServers()

    expect(after1).toEqual(after2)
    expect(after2.length).toBe(1)
  })

  it('handles the auto-suffix regex edge cases', () => {
    // 'figma-2abcdefg' → strip → 'figma'
    // 'figma-2abcdef' (7 chars) → don't strip → 'figma-2abcdef'
    // 'figma-9abcdefg' (contains '9') → don't strip → 'figma-9abcdefg'
    seedServer('figma', 'detected', 'Figma')                  // logical='figma'
    seedServer('figma-2abcdefg', 'custom', 'Figma A')          // logical='figma' (strip)
    seedServer('figma-2abcdef', 'custom', 'Figma B')           // logical='figma-2abcdef' (no strip — 7 chars)
    seedServer('figma-9abcdefg', 'custom', 'Figma C')          // logical='figma-9abcdefg' (no strip — '9' not in alphabet)

    applyMigration022()

    const servers = listServers()
    // 4 rows → 3 logical keys → 'figma' group has 2 → collapses to 1.
    // figma-2abcdef + figma-9abcdefg are unique logicals → preserved.
    expect(servers.length).toBe(3)
    const ids = servers.map(s => s.id).sort()
    expect(ids).toContain('figma')
    expect(ids).toContain('figma-2abcdef')
    expect(ids).toContain('figma-9abcdefg')
  })
})
