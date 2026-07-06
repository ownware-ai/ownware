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

  it('defaults to ["ownware"] on a freshly created workspace', () => {
    const ws = state.createWorkspace('/tmp/fresh', 'fresh')
    expect(ws.activeProducts).toEqual(['ownware'])
  })

  it('persists ["ownware"] across read (mapWorkspace round-trip)', () => {
    const created = state.createWorkspace('/tmp/persist', 'persist')
    const fetched = state.getWorkspace(created.id)
    expect(fetched?.activeProducts).toEqual(['ownware'])
  })

  it('updateWorkspace replaces the product list and re-read returns it', () => {
    const created = state.createWorkspace('/tmp/multi', 'multi')

    const updated = state.updateWorkspace(created.id, {
      activeProducts: ['ownware', 'ownware-design'],
    })
    expect(updated?.activeProducts).toEqual(['ownware', 'ownware-design'])

    const fetched = state.getWorkspace(created.id)
    expect(fetched?.activeProducts).toEqual(['ownware', 'ownware-design'])
  })

  it('updateWorkspace without activeProducts leaves the existing list intact', () => {
    const created = state.createWorkspace('/tmp/intact', 'intact')
    state.updateWorkspace(created.id, { activeProducts: ['ownware', 'ownware-marketing'] })

    const renamed = state.updateWorkspace(created.id, { name: 'Renamed' })
    expect(renamed?.name).toBe('Renamed')
    expect(renamed?.activeProducts).toEqual(['ownware', 'ownware-marketing'])
  })

  it('WorkspaceDetail also exposes activeProducts', () => {
    const created = state.createWorkspace('/tmp/detail', 'detail')
    state.updateWorkspace(created.id, { activeProducts: ['ownware', 'ownware-design'] })

    const detail = state.getWorkspaceDetail(created.id)
    expect(detail?.activeProducts).toEqual(['ownware', 'ownware-design'])
  })
})
