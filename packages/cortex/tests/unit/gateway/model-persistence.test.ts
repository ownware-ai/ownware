/**
 * Model persistence — invariant tests.
 *
 * The bug this work fixed: switching the model dropdown mid-
 * conversation, then reloading, dropped both the dropdown selection
 * (back to the profile default) and the per-message attribution
 * (every old turn rendered as the generic `agent` badge).
 *
 * These tests pin the durable contract:
 *
 *   1. `setThreadModel()` persists the canonical model id on the row.
 *   2. `addMessage()` writes `model` at INSERT and never updates it.
 *   3. After a 3-model conversation, every message keeps its OWN
 *      model and the thread's row reflects the LAST dispatched model.
 *
 * If a future refactor reintroduces the "model lives only in memory"
 * regression, exactly one of these tests fails — fast.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import type { ThreadMessage } from '../../../src/gateway/types.js'

let dir: string
let db: CortexDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cortex-model-persistence-'))
  db = new CortexDatabase(join(dir, 'main.db'), join(dir, 'fx.db'))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function asstMsg(model: string, content = 'hi'): ThreadMessage {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    role: 'assistant',
    content,
    model,
    timestamp: new Date().toISOString(),
  }
}

describe('Thread.model — dropdown persistence', () => {
  it('new thread starts with model=null (use profile default)', () => {
    const t = db.createThread('p1')
    expect(t.model).toBeNull()
    expect(db.getThread(t.id)?.model).toBeNull()
  })

  it('setThreadModel persists the dispatched model', () => {
    const t = db.createThread('p1')
    db.setThreadModel(t.id, 'claude-sonnet-4-6')
    expect(db.getThread(t.id)?.model).toBe('claude-sonnet-4-6')
  })

  it('setThreadModel overwrites previous selection (last write wins)', () => {
    const t = db.createThread('p1')
    db.setThreadModel(t.id, 'claude-sonnet-4-6')
    db.setThreadModel(t.id, 'gpt-5.4')
    db.setThreadModel(t.id, 'kimi-k-2.6')
    expect(db.getThread(t.id)?.model).toBe('kimi-k-2.6')
  })
})

describe('Message.model — per-turn attribution', () => {
  it('addMessage writes model and getMessages reads it back', () => {
    const t = db.createThread('p1')
    const msg = asstMsg('claude-sonnet-4-6', 'first turn')
    db.addMessage(t.id, msg)

    const rows = db.getMessages(t.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe('claude-sonnet-4-6')
    expect(rows[0]!.id).toBe(msg.id)
  })

  it('user messages without model round-trip cleanly (model omitted)', () => {
    const t = db.createThread('p1')
    db.addMessage(t.id, {
      id: 'msg_user_1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    })

    const rows = db.getMessages(t.id)
    expect(rows[0]!.model).toBeUndefined()
  })

  it('mixed-model conversation preserves each message model independently', () => {
    const t = db.createThread('p1')

    db.addMessage(t.id, asstMsg('gpt-5.4', 'turn 1 — gpt'))
    db.setThreadModel(t.id, 'gpt-5.4')

    db.addMessage(t.id, asstMsg('claude-sonnet-4-6', 'turn 2 — sonnet'))
    db.setThreadModel(t.id, 'claude-sonnet-4-6')

    db.addMessage(t.id, asstMsg('kimi-k-2.6', 'turn 3 — kimi'))
    db.setThreadModel(t.id, 'kimi-k-2.6')

    const rows = db.getMessages(t.id)
    const byContent = new Map(rows.map((r) => [r.content, r.model]))
    expect(byContent.get('turn 1 — gpt')).toBe('gpt-5.4')
    expect(byContent.get('turn 2 — sonnet')).toBe('claude-sonnet-4-6')
    expect(byContent.get('turn 3 — kimi')).toBe('kimi-k-2.6')

    // Thread row reflects the LAST dispatched model — the dropdown's
    // hydrate value on reload.
    expect(db.getThread(t.id)?.model).toBe('kimi-k-2.6')
  })
})

describe('PATCH-equivalent (no /run dispatch needed)', () => {
  it('setThreadModel persists the pick without any messages', () => {
    // This mirrors what the PATCH /threads/:id endpoint does on a
    // dropdown change: the user picks a model, the renderer fires a
    // PATCH, no messages have been written. The choice must still
    // survive a reload — i.e. live in the threads row right now.
    const t = db.createThread('p1')
    expect(db.getThread(t.id)?.model).toBeNull()

    db.setThreadModel(t.id, 'claude-sonnet-4-6')
    expect(db.getThread(t.id)?.model).toBe('claude-sonnet-4-6')

    // No messages written — picking alone was enough.
    expect(db.getMessages(t.id)).toHaveLength(0)
  })

  it('rapid picks (scroll through dropdown) all converge to the last choice', () => {
    // Optimistic UI fires a mutation per pick. Last write wins; any
    // earlier in-flight write that lands later does NOT clobber a
    // newer choice because in this test we serialise the writes
    // (the PATCH endpoint is single-threaded per row in SQLite).
    const t = db.createThread('p1')
    const choices = ['gpt-5.4', 'claude-sonnet-4-6', 'kimi-k-2.6', 'gpt-5.4-mini']
    for (const c of choices) db.setThreadModel(t.id, c)
    expect(db.getThread(t.id)?.model).toBe('gpt-5.4-mini')
  })
})

describe('Reload determinism — full simulated round-trip', () => {
  it('a 3-model conversation reloads with all three badges + correct dropdown', () => {
    const t = db.createThread('p1')

    // Dispatch 1 — GPT
    db.setThreadModel(t.id, 'gpt-5.4')
    db.addMessage(t.id, asstMsg('gpt-5.4'))

    // Dispatch 2 — Sonnet (user switched mid-conversation)
    db.setThreadModel(t.id, 'claude-sonnet-4-6')
    db.addMessage(t.id, asstMsg('claude-sonnet-4-6'))

    // Dispatch 3 — Kimi (user switched again)
    db.setThreadModel(t.id, 'kimi-k-2.6')
    db.addMessage(t.id, asstMsg('kimi-k-2.6'))

    // ── Simulate a "reload": close the handle, reopen the same files.
    db.close()
    const reopened = new CortexDatabase(join(dir, 'main.db'), join(dir, 'fx.db'))

    try {
      // Dropdown hydrate value — `thread.model` survives the reload.
      const reloadedThread = reopened.getThread(t.id)
      expect(reloadedThread?.model).toBe('kimi-k-2.6')

      // Per-message badges — every row keeps its own model.
      const rows = reopened.getMessages(t.id)
      const models = rows.map((r) => r.model)
      expect(models).toEqual(['gpt-5.4', 'claude-sonnet-4-6', 'kimi-k-2.6'])
    } finally {
      reopened.close()
      // Re-open the test's own handle so the afterEach close()
      // doesn't crash on an already-closed db.
      db = new CortexDatabase(join(dir, 'main.db'), join(dir, 'fx.db'))
    }
  })
})
