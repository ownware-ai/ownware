/**
 * Journey 11: Session recovery (crash recovery)
 *
 *   1. Create workspaces + threads
 *   2. Save session state
 *   3. Verify session state persisted
 *   4. Simulate restart by reading state from a fresh gateway pointing
 *      at the same DB file
 *   5. Verify everything is restored
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { ApiClient } from '../harness/api-client.js'

describe('Journey: 11 Session Recovery', () => {
  let tmpDir: string
  let dbPath: string
  let profilesDir: string
  let gw1: OwnwareGateway

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cortex-fw-recovery-'))
    dbPath = join(tmpDir, 'recovery.db')
    profilesDir = join(tmpDir, 'profiles')
    await mkdir(join(profilesDir, 'mini'), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(profilesDir, 'mini', 'agent.json'),
      JSON.stringify({
        name: 'mini',
        model: 'anthropic:claude-sonnet-4-20250514',
        tools: { preset: 'none' },
        context: { cwd: false, datetime: false },
      }),
    )
  })

  afterAll(async () => {
    if (gw1) await gw1.stop().catch(() => {})
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('Step 1: Start gateway 1, create workspaces + threads', async () => {
    gw1 = new OwnwareGateway({ port: 0, profilesDir, dbPath, dataDir: join(tmpDir, 'data') })
    await gw1.start()

    // Create real directories the workspaces can point to
    const ws1Path = join(tmpDir, 'ws1')
    const ws2Path = join(tmpDir, 'ws2')
    await mkdir(ws1Path)
    await mkdir(ws2Path)

    const ws1 = gw1.state.createWorkspace(ws1Path, 'WS One')
    const ws2 = gw1.state.createWorkspace(ws2Path, 'WS Two')
    gw1.state.createThread('mini', 'T1', ws1.id)
    gw1.state.createThread('mini', 'T2', ws2.id)

    expect(gw1.state.listWorkspaces('active').items.length).toBe(2)
  })

  it('Step 2: Save session, then stop gateway 1', async () => {
    gw1.state.saveSessionState()
    const session = gw1.state.getSessionState()
    expect(session?.hasSession).toBe(true)
    expect(session?.workspaces?.length).toBe(2)

    await gw1.stop()
  })

  it('Step 3: Start gateway 2 with same DB — session is restored', async () => {
    const gw2 = new OwnwareGateway({ port: 0, profilesDir, dbPath, dataDir: join(tmpDir, 'data') })
    await gw2.start()

    try {
      const session = gw2.state.getSessionState()
      expect(session?.hasSession).toBe(true)
      expect(session?.workspaces?.length).toBe(2)

      // Workspaces still in DB
      const wss = gw2.state.listWorkspaces()
      expect(wss.total).toBe(2)

      // Threads still in DB
      expect(gw2.state.threadCount).toBe(2)

      // POST /session/restore returns the count
      const client = new ApiClient(`http://127.0.0.1:${gw2.port}`, gw2.token)
      const r = await client.post<{ workspaceCount?: number }>('/api/v1/session/restore', {})
      expect([200, 201]).toContain(r.status)
    } finally {
      await gw2.stop()
    }
  })
})
