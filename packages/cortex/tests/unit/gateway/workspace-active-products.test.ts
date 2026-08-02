/**
 * Workspace.activeProducts round-trip tests — product-base shift
 * Phase 2 · slice-01. Verifies the full path:
 *   create → read → update(activeProducts) → re-read
 * through GatewayState (which is what the HTTP handlers call).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'

describe('Workspace.activeProducts (migration 032)', () => {
  let state: GatewayState
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-active-products-'))
    state = new GatewayState(join(tmpDir, 'test.db'))
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('defaults to ["ownware"] on a freshly created workspace', async () => {
    const ws = await state.createWorkspace('/tmp/fresh', 'fresh')
    expect(ws.activeProducts).toEqual(['ownware'])
  })

  it('persists ["ownware"] across read (mapWorkspace round-trip)', async () => {
    const created = await state.createWorkspace('/tmp/persist', 'persist')
    const fetched = await state.getWorkspace(created.id)
    expect(fetched?.activeProducts).toEqual(['ownware'])
  })

  it('updateWorkspace replaces the product list and re-read returns it', async () => {
    const created = await state.createWorkspace('/tmp/multi', 'multi')

    const updated = await state.updateWorkspace(created.id, {
      activeProducts: ['ownware', 'ownware-design'],
    })
    expect(updated?.activeProducts).toEqual(['ownware', 'ownware-design'])

    const fetched = await state.getWorkspace(created.id)
    expect(fetched?.activeProducts).toEqual(['ownware', 'ownware-design'])
  })

  it('updateWorkspace without activeProducts leaves the existing list intact', async () => {
    const created = await state.createWorkspace('/tmp/intact', 'intact')
    await state.updateWorkspace(created.id, { activeProducts: ['ownware', 'ownware-marketing'] })

    const renamed = await state.updateWorkspace(created.id, { name: 'Renamed' })
    expect(renamed?.name).toBe('Renamed')
    expect(renamed?.activeProducts).toEqual(['ownware', 'ownware-marketing'])
  })

  it('WorkspaceDetail also exposes activeProducts', async () => {
    const created = await state.createWorkspace('/tmp/detail', 'detail')
    await state.updateWorkspace(created.id, { activeProducts: ['ownware', 'ownware-design'] })

    const detail = await state.getWorkspaceDetail(created.id)
    expect(detail?.activeProducts).toEqual(['ownware', 'ownware-design'])
  })
})
