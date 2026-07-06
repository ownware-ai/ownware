/**
 * Designs round-trip tests — Slice 7a (migration 033).
 *
 * Verifies the full path against `GatewayState` (the layer HTTP
 * handlers will call in Slice 7b):
 *   - create / get / getBySlug
 *   - listDesignsForWorkspace
 *   - link / get / unlink thread ↔ design
 *   - delete design (cascades thread_designs rows)
 *   - FK ON DELETE CASCADE from parent workspace
 *
 * Per root CLAUDE.md Principle 22: Ownware Design's per-design tables
 * are PRODUCT-scoped (not a generic `child_workspaces` abstraction).
 * Threads table is untouched — Coder never touches these structures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'

describe('Designs (migration 033)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceId: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-designs-'))
    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace('/tmp/north-mark', 'north-mark')
    workspaceId = ws.id
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('createDesign returns a complete Design row with timestamps', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype', {
      name: 'Landing page',
      templateSource: 'ownware/north-mark-landing',
    })

    expect(design.id).toMatch(/^dsn_[0-9a-f]{12}$/)
    expect(design.workspaceId).toBe(workspaceId)
    expect(design.slug).toBe('landing')
    expect(design.kind).toBe('prototype')
    expect(design.name).toBe('Landing page')
    expect(design.templateSource).toBe('ownware/north-mark-landing')
    expect(design.createdAt).toBeTypeOf('string')
    expect(design.updatedAt).toBeTypeOf('string')
  })

  it('createDesign accepts null name and templateSource', () => {
    const design = state.createDesign(workspaceId, 'sketch-1', 'sketch')
    expect(design.name).toBeNull()
    expect(design.templateSource).toBeNull()
  })

  it('getDesign + getDesignBySlug round-trip', () => {
    const created = state.createDesign(workspaceId, 'brand-mark', 'image')

    const byId = state.getDesign(created.id)
    expect(byId).toEqual(created)

    const bySlug = state.getDesignBySlug(workspaceId, 'brand-mark')
    expect(bySlug).toEqual(created)
  })

  it('getDesign returns undefined for unknown id', () => {
    expect(state.getDesign('dsn_doesnotexist')).toBeUndefined()
    expect(state.getDesignBySlug(workspaceId, 'never-made')).toBeUndefined()
  })

  it('UNIQUE (workspace_id, slug) prevents duplicate slugs in the same workspace', () => {
    state.createDesign(workspaceId, 'landing', 'prototype')
    expect(() => state.createDesign(workspaceId, 'landing', 'deck')).toThrow()
  })

  it('same slug is allowed across different workspaces', () => {
    const ws2 = state.createWorkspace('/tmp/acme', 'acme')
    state.createDesign(workspaceId, 'landing', 'prototype')
    const d2 = state.createDesign(ws2.id, 'landing', 'prototype')
    expect(d2.workspaceId).toBe(ws2.id)
  })

  it('listDesignsForWorkspace returns all designs for the workspace', () => {
    // Each design lives in its OWN folder workspace nested under the
    // parent (`<parent>/.ownware/app/ownware-design/<slug>/`, D-A16) — the
    // list query matches on that path-nesting convention.
    const wsA = state.createWorkspace(
      '/tmp/north-mark/.ownware/app/ownware-design/landing',
      'landing',
    )
    const wsB = state.createWorkspace(
      '/tmp/north-mark/.ownware/app/ownware-design/brand-mark',
      'brand-mark',
    )
    const a = state.createDesign(wsA.id, 'landing', 'prototype')
    const b = state.createDesign(wsB.id, 'brand-mark', 'image')

    const list = state.listDesignsForWorkspace(workspaceId)
    expect(list).toHaveLength(2)
    const ids = list.map((d) => d.id).sort()
    expect(ids).toEqual([a.id, b.id].sort())
  })

  it('listDesignsForWorkspace returns empty array for a workspace with no designs', () => {
    expect(state.listDesignsForWorkspace(workspaceId)).toEqual([])
  })

  it('linkThreadToDesign + getDesignForThread round-trip', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype')
    const thread = state.createThread('test-profile', undefined, workspaceId)

    state.linkThreadToDesign(thread.id, design.id)

    const resolved = state.getDesignForThread(thread.id)
    expect(resolved).toEqual(design)
  })

  it('getDesignForThread returns undefined when the thread has no link', () => {
    const thread = state.createThread('test-profile', undefined, workspaceId)
    expect(state.getDesignForThread(thread.id)).toBeUndefined()
  })

  it('linkThreadToDesign is idempotent on the SAME (thread, design) pair', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype')
    const thread = state.createThread('test-profile', undefined, workspaceId)

    state.linkThreadToDesign(thread.id, design.id)
    state.linkThreadToDesign(thread.id, design.id)

    expect(state.getDesignForThread(thread.id)?.id).toBe(design.id)
  })

  it('linkThreadToDesign replaces an existing link (PRIMARY KEY on thread_id)', () => {
    const d1 = state.createDesign(workspaceId, 'landing', 'prototype')
    const d2 = state.createDesign(workspaceId, 'brand-mark', 'image')
    const thread = state.createThread('test-profile', undefined, workspaceId)

    state.linkThreadToDesign(thread.id, d1.id)
    state.linkThreadToDesign(thread.id, d2.id)

    expect(state.getDesignForThread(thread.id)?.id).toBe(d2.id)
  })

  it('unlinkThreadFromDesign returns true when there was a link, false otherwise', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype')
    const thread = state.createThread('test-profile', undefined, workspaceId)
    state.linkThreadToDesign(thread.id, design.id)

    expect(state.unlinkThreadFromDesign(thread.id)).toBe(true)
    expect(state.getDesignForThread(thread.id)).toBeUndefined()
    expect(state.unlinkThreadFromDesign(thread.id)).toBe(false)
  })

  it('deleteDesign cascades thread_designs rows', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype')
    const thread = state.createThread('test-profile', undefined, workspaceId)
    state.linkThreadToDesign(thread.id, design.id)

    expect(state.deleteDesign(design.id)).toBe(true)
    expect(state.getDesign(design.id)).toBeUndefined()
    expect(state.getDesignForThread(thread.id)).toBeUndefined()
    // Thread itself survives — only the design link is gone.
    expect(state.getThread(thread.id)).toBeDefined()
  })

  it('deleting a workspace cascades to its designs + their thread_designs links', () => {
    const design = state.createDesign(workspaceId, 'landing', 'prototype')
    const thread = state.createThread('test-profile', undefined, workspaceId)
    state.linkThreadToDesign(thread.id, design.id)

    expect(state.deleteWorkspace(workspaceId)).toBe(true)

    expect(state.getDesign(design.id)).toBeUndefined()
    expect(state.getDesignForThread(thread.id)).toBeUndefined()
  })
})
