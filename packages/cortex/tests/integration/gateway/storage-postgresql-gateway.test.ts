import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OwnwareGateway, type GatewayOptions } from '../../../src/gateway/server.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

describePostgreSql('PostgreSQL-backed public gateway', () => {
  let root: string
  let database: Awaited<ReturnType<typeof createDisposablePostgreSqlDatabase>>
  let gateway: OwnwareGateway | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ownware-postgresql-gateway-'))
    const profile = join(root, 'profiles', 'mini')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'agent.json'), JSON.stringify({
      name: 'mini',
      tools: { preset: 'none' },
    }))
    database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  })

  afterEach(async () => {
    await gateway?.stop().catch(() => {})
    await database.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  function options(): GatewayOptions {
    return {
      port: 0,
      tls: false,
      profilesDir: join(root, 'profiles'),
      dataDir: join(root, 'data'),
      disableRateLimit: true,
      disableAccessLog: true,
      disableSourceWorker: true,
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve: () => database.url },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    }
  }

  it('starts, serves, persists core and gateway state, closes and reopens one authority', async () => {
    gateway = new OwnwareGateway(options())
    expect(gateway.state.storageKind).toBe('postgresql')
    expect(gateway.state.storageLifecycleState).toBe('new')
    expect(() => gateway!.state.rawDbHandle).toThrow('only with SQLite')

    await gateway.start()
    await expect(gateway.state.storageHealth()).resolves.toMatchObject({
      kind: 'postgresql',
      state: 'ready',
      schemaVersion: 91,
    })
    const health = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/health`)
    expect(health.status).toBe(200)

    const workspace = await gateway.state.createWorkspace(join(root, 'project'), 'PG Project')
    const thread = await gateway.state.createThread('mini', 'PostgreSQL thread', workspace.id)
    await gateway.state.addMessage(thread.id, {
      id: 'pg-message',
      role: 'user',
      content: 'durable PostgreSQL message',
      timestamp: '2026-08-02T10:00:00.000Z',
    })
    await gateway.state.setSetting('storage-contract', 'postgresql')
    await gateway.state.addAuditLog({
      action: 'storage.started',
      entityType: 'gateway',
      entityId: 'postgresql',
    })
    await gateway.state.platformRepositories.userIdentity.set({ name: 'PG Owner' })

    const stats = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/storage/stats`)
    expect(stats.status).toBe(200)
    const statsBody = await stats.json() as {
      readonly dbSizeBytes: number
      readonly threadCount: number
      readonly messageCount: number
    }
    expect(statsBody).toMatchObject({
      threadCount: 1,
      messageCount: 1,
    })
    expect(statsBody.dbSizeBytes).toBeGreaterThan(0)

    await gateway.stop()
    expect(gateway.state.storageLifecycleState).toBe('closed')

    gateway = new OwnwareGateway(options())
    await gateway.start()
    await expect(gateway.state.getWorkspace(workspace.id)).resolves.toMatchObject({
      name: 'PG Project',
    })
    await expect(gateway.state.getThread(thread.id)).resolves.toMatchObject({
      title: 'PostgreSQL thread',
      workspaceId: workspace.id,
    })
    await expect(gateway.state.getMessages(thread.id)).resolves.toMatchObject([
      { id: 'pg-message', content: 'durable PostgreSQL message' },
    ])
    await expect(gateway.state.getSetting('storage-contract')).resolves.toMatchObject({
      value: 'postgresql',
    })
    await expect(gateway.state.platformRepositories.userIdentity.get()).resolves.toMatchObject({
      name: 'PG Owner',
    })
  })
})
