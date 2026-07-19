import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let dir = ''
let profilesDir = ''
let dataDir = ''
let gateway: OwnwareGateway | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-identity-warning-'))
  profilesDir = join(dir, 'profiles')
  dataDir = join(dir, 'data')
  mkdirSync(profilesDir, { recursive: true })
})

afterEach(async () => {
  if (gateway !== null) await gateway.stop()
  gateway = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('connector install identity boot warning', () => {
  it('reports unreachable rows without printing the install identity', async () => {
    const installIdentityCanary = 'private-install-identity-never-log'
    vi.stubEnv('OWNWARE_COMPOSIO_USER_ID', installIdentityCanary)

    const database = new CortexDatabase(join(dataDir, 'ownware.db'))
    database.rawMainHandle.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status, initiated_at
      ) VALUES (?, ?, 'composio', ?, 'ready', ?)
    `).run('foreign_ready', 'gmail', 'different-install', 1_750_000_000_000)
    database.close()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    gateway = new OwnwareGateway({
      port: 0,
      profilesDir,
      dataDir,
      tls: false,
      disableSourceWorker: true,
    })
    await gateway.start()

    const output = warn.mock.calls
      .map((call) => call.map((value) => String(value)).join(' '))
      .join('\n')
    expect(output).toContain(
      'connector_connections: 1 row(s) under a foreign entity_id',
    )
    expect(output).not.toContain(installIdentityCanary)
  })
})
