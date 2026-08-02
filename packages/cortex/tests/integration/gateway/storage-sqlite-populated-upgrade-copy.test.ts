import Database from 'better-sqlite3'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('SQLite populated-copy upgrade journey', () => {
  let directory = ''
  let gateway: OwnwareGateway | undefined

  afterEach(async () => {
    await gateway?.stop().catch(() => {})
    gateway = undefined
    if (directory !== '') rmSync(directory, { recursive: true, force: true })
    directory = ''
  })

  it('upgrades and serves a coherent copy without mutating its v81 source', async () => {
    directory = mkdtempSync(join(tmpdir(), 'ownware-populated-upgrade-'))
    const sourcePath = join(directory, 'source-v81.db')
    const copyPath = join(directory, 'copy.db')
    const profilesDir = join(directory, 'profiles')
    const profileDir = join(profilesDir, 'copy-profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'agent.json'), JSON.stringify({
      name: 'copy-profile',
      model: 'ollama:llama3.2',
      tools: { preset: 'none' },
    }))

    const source = new Database(sourcePath)
    source.pragma('journal_mode = WAL')
    source.pragma('foreign_keys = ON')
    runMigrationsSafely(
      source,
      sourcePath,
      MIGRATIONS.filter((migration) => migration.version <= 81),
    )
    source.prepare(
      `INSERT INTO threads (id, profile_id, title, status)
       VALUES (?, ?, ?, 'completed')`,
    ).run('thread_populated_copy', 'copy-profile', 'Preserved populated copy')
    source.close()

    copyFileSync(sourcePath, copyPath)
    const sourceBefore = digest(sourcePath)

    gateway = new OwnwareGateway({
      port: 0,
      tls: false,
      profilesDir,
      dataDir: join(directory, 'data'),
      dbPath: copyPath,
    })
    await gateway.start()
    const response = await fetch(
      `http://127.0.0.1:${gateway.port}/api/v1/threads?profileId=copy-profile`,
      { headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      readonly items: ReadonlyArray<{ readonly id: string; readonly title: string | null }>
    }
    expect(body.items).toContainEqual(expect.objectContaining({
      id: 'thread_populated_copy',
      title: 'Preserved populated copy',
    }))
    await gateway.stop()
    gateway = undefined

    expect(digest(sourcePath)).toBe(sourceBefore)
    const untouched = new Database(sourcePath, { readonly: true })
    expect(untouched.pragma('user_version', { simple: true })).toBe(81)
    expect(untouched.prepare(
      `SELECT COUNT(*) AS count FROM pragma_table_info('_migrations')
       WHERE name = 'fingerprint'`,
    ).get()).toEqual({ count: 0 })
    untouched.close()

    const upgraded = new Database(copyPath, { readonly: true })
    expect(upgraded.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(upgraded.prepare(
      `SELECT title FROM threads WHERE id = 'thread_populated_copy'`,
    ).get()).toEqual({ title: 'Preserved populated copy' })
    expect(upgraded.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok')
    upgraded.close()
  }, 30_000)
})
