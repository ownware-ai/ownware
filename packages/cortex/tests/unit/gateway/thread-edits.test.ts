/**
 * thread_edits round-trip (migration 047) — edit-by-talking's durable binding.
 *
 * A Builder thread is GENERAL ('builder' profile); this join records WHICH
 * agent (slug) a given thread is editing, so the edit context survives reopen
 * and an agent's edit history is queryable. Mirrors the thread_designs tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'

describe('thread_edits (migration 047)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceId: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-thread-edits-'))
    state = new GatewayState(join(tmpDir, 'test.db'))
    workspaceId = state.createWorkspace('/tmp/proj', 'proj').id
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('linkThreadToEdit + getEditForThread round-trip', () => {
    const thread = state.createThread('builder', undefined, workspaceId)
    state.linkThreadToEdit(thread.id, 'kit')
    expect(state.getEditForThread(thread.id)).toBe('kit')
  })

  it('getEditForThread is undefined for a thread with no binding', () => {
    const thread = state.createThread('builder', undefined, workspaceId)
    expect(state.getEditForThread(thread.id)).toBeUndefined()
  })

  it('re-linking the same thread replaces the target (one agent per thread)', () => {
    const thread = state.createThread('builder', undefined, workspaceId)
    state.linkThreadToEdit(thread.id, 'kit')
    state.linkThreadToEdit(thread.id, 'vera')
    expect(state.getEditForThread(thread.id)).toBe('vera')
  })

  it('many threads can edit the SAME agent (multi-edit history)', () => {
    const t1 = state.createThread('builder', undefined, workspaceId)
    const t2 = state.createThread('builder', undefined, workspaceId)
    state.linkThreadToEdit(t1.id, 'kit')
    state.linkThreadToEdit(t2.id, 'kit')
    expect(state.getEditForThread(t1.id)).toBe('kit')
    expect(state.getEditForThread(t2.id)).toBe('kit')
  })

  it('getThreadsForEdit lists an agent’s edit threads (and is empty for none)', () => {
    const t1 = state.createThread('builder', undefined, workspaceId)
    const t2 = state.createThread('builder', undefined, workspaceId)
    state.linkThreadToEdit(t1.id, 'kit')
    state.linkThreadToEdit(t2.id, 'kit')
    const ids = state.getThreadsForEdit('kit')
    expect(ids).toHaveLength(2)
    expect([...ids].sort()).toEqual([t1.id, t2.id].sort())
    expect(state.getThreadsForEdit('nobody')).toHaveLength(0)
  })
})
