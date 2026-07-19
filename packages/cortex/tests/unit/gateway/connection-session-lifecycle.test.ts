import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'

let root = ''
let dataDir = ''
let profilesDir = ''
let gateway: OwnwareGateway | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'connection-session-lifecycle-'))
  dataDir = join(root, 'data')
  profilesDir = join(root, 'profiles')
  mkdirSync(profilesDir, { recursive: true })
  vi.stubEnv('OWNWARE_SKIP_MCP_REGISTRY', '1')
  vi.stubEnv('OWNWARE_DATA_DIR', dataDir)
  vi.stubEnv('OWNWARE_COMPOSIO_USER_ID', 'synthetic-install')
  __resetMasterKeyCacheForTests()
})

afterEach(async () => {
  if (gateway !== null) await gateway.stop()
  gateway = null
  vi.unstubAllEnvs()
  __resetMasterKeyCacheForTests()
  if (root) rmSync(root, { recursive: true, force: true })
})

function createGateway(): OwnwareGateway {
  return new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir,
    tls: false,
    disableSourceWorker: true,
  })
}

async function seedPendingSession(target: OwnwareGateway, connectionId: string) {
  const expiresAt = Date.now() + 60_000
  const handle = await target.connectionSessions.create({
    connectionId,
    connectorId: 'synthetic-connector',
    source: 'composio',
    entityId: 'synthetic-install',
    authorizationUrl: 'https://auth.example/continue?secret=synthetic',
    linkToken: 'synthetic-secret-link-token',
    expiresAt,
  })
  target.connectorConnections.upsertPending({
    connectionId,
    connectorId: 'synthetic-connector',
    source: 'composio',
    entityId: 'synthetic-install',
    expiresAt,
    metadata: { sessionHandle: handle },
  })
  return handle
}

describe('gateway connection-session lifecycle', () => {
  it('verifiably deletes an interrupted encrypted session before boot clears its handle', async () => {
    gateway = createGateway()
    const handle = await seedPendingSession(gateway, 'connection-before-boot')
    const encryptedPath = join(dataDir, 'connection-sessions', `${handle}.json`)
    expect(existsSync(encryptedPath)).toBe(true)

    await gateway.start()

    expect(existsSync(encryptedPath)).toBe(false)
    expect(gateway.connectorConnections.findByConnectionId('connection-before-boot'))
      .toMatchObject({ status: 'expired', metadata: null })
  })

  it('verifiably deletes pending sessions during graceful shutdown', async () => {
    gateway = createGateway()
    await gateway.start()
    const handle = await seedPendingSession(gateway, 'connection-before-stop')
    const encryptedPath = join(dataDir, 'connection-sessions', `${handle}.json`)
    expect(existsSync(encryptedPath)).toBe(true)

    await gateway.stop()
    gateway = null

    expect(existsSync(encryptedPath)).toBe(false)
    const reopened = new CortexDatabase(join(dataDir, 'ownware.db'))
    const row = reopened.rawMainHandle.prepare(
      'SELECT status, metadata_json FROM connector_connections WHERE connection_id = ?',
    ).get('connection-before-stop')
    expect(row).toEqual({ status: 'expired', metadata_json: null })
    reopened.close()
  })
})
