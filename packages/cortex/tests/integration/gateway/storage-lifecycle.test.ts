import { createServer, type Server } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationSafetyError } from '../../../src/gateway/db/migration-safety.js'
import { OwnwareGateway } from '../../../src/gateway/server.js'

describe('gateway storage lifecycle', () => {
  let root: string
  let gateway: OwnwareGateway | undefined
  let blocker: Server | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cortex-gateway-storage-'))
    const profile = join(root, 'profiles', 'mini')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'agent.json'), JSON.stringify({
      name: 'mini',
      tools: { preset: 'none' },
    }))
  })

  afterEach(async () => {
    await gateway?.stop().catch(() => {})
    await new Promise<void>((resolve) => {
      if (blocker === undefined || !blocker.listening) return resolve()
      blocker.close(() => resolve())
    })
    await rm(root, { recursive: true, force: true })
  })

  function create(port = 0, useDerivedDatabasePath = false): OwnwareGateway {
    return new OwnwareGateway({
      port,
      tls: false,
      profilesDir: join(root, 'profiles'),
      dataDir: join(root, 'data'),
      ...(useDerivedDatabasePath ? {} : { dbPath: join(root, 'ownware.db') }),
      disableRateLimit: true,
      disableAccessLog: true,
    })
  }

  it('shares start/stop transitions and closes storage after the listener', async () => {
    const signalCount = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    }
    gateway = create(0, true)
    expect(gateway.state.storageLifecycleState).toBe('ready')
    await expect(gateway.state.storageHealth()).resolves.toMatchObject({
      state: 'ready',
      schemaVersion: 90,
    })

    const firstStart = gateway.start()
    const secondStart = gateway.start()
    expect(secondStart).toBe(firstStart)
    await firstStart
    expect(gateway.port).toBeGreaterThan(0)
    expect(process.listenerCount('SIGTERM')).toBe(signalCount.term + 1)
    expect(process.listenerCount('SIGINT')).toBe(signalCount.int + 1)

    const firstStop = gateway.stop()
    const secondStop = gateway.stop()
    expect(secondStop).toBe(firstStop)
    await firstStop
    expect(gateway.state.storageLifecycleState).toBe('closed')
    expect(process.listenerCount('SIGTERM')).toBe(signalCount.term)
    expect(process.listenerCount('SIGINT')).toBe(signalCount.int)
    await expect(gateway.start()).rejects.toThrow('cannot start after shutdown begins')

    // Reopen the same configuration-free SQLite path derived from dataDir.
    gateway = create(0, true)
    await gateway.start()
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/v1/health`)
    expect(response.status).toBe(200)
    await gateway.stop()
    expect(gateway.state.storageLifecycleState).toBe('closed')
  })

  it('cancels an immediate stop before any listener becomes ready', async () => {
    gateway = create()
    const start = gateway.start()
    const stop = gateway.stop()
    await expect(start).rejects.toThrow('start cancelled by shutdown request')
    await stop
    expect(gateway.state.storageLifecycleState).toBe('closed')
    await expect(gateway.state.storageHealth()).resolves.toMatchObject({
      state: 'unavailable',
      code: 'lifecycle_closed',
    })
    await expect(gateway.stop()).resolves.toBeUndefined()
  })

  it('closes storage when the requested port is already owned', async () => {
    blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker!.once('error', reject)
      blocker!.listen(0, '127.0.0.1', resolve)
    })
    const address = blocker.address()
    if (address === null || typeof address === 'string') {
      throw new Error('test blocker did not bind a TCP port')
    }

    gateway = create(address.port)
    await expect(gateway.start()).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(gateway.state.storageLifecycleState).toBe('closed')
    await expect(gateway.state.storageHealth()).resolves.toMatchObject({
      state: 'unavailable',
      code: 'lifecycle_closed',
    })
    await expect(gateway.stop()).resolves.toBeUndefined()
  })

  it('refuses a corrupt SQLite file before installing process listeners', async () => {
    const corrupt = Buffer.from('not a sqlite database; customer bytes stay intact')
    const dbPath = join(root, 'ownware.db')
    await writeFile(dbPath, corrupt)
    const signalCount = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    }

    expect(() => create()).toThrow(MigrationSafetyError)
    expect(await readFile(dbPath)).toEqual(corrupt)
    expect(process.listenerCount('SIGTERM')).toBe(signalCount.term)
    expect(process.listenerCount('SIGINT')).toBe(signalCount.int)
  })
})
