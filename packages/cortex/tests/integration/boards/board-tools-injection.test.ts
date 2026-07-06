/**
 * Integration — the assembler injects the board tools (Slice 3).
 *
 * Verifies the live wiring (no LLM, no network):
 *   1. WITHOUT a `board` binding → no board tools (a workspace-less run,
 *      or a direct-Loom caller, never sees them).
 *   2. WITH a `board` binding on a coding/full profile → `board_write`
 *      and `board_update` are in the assembled tool set.
 *
 * Catches wiring bugs (option threading, gating) that the store/tool
 * unit tests can't.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteBoardStore, BoardEventBus } from '../../../src/boards/index.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function makeStore(): SqliteBoardStore {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cortex-board-inject-'))
  const db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }))
  return new SqliteBoardStore(db.rawMainHandle, new BoardEventBus())
}

describe('boards: assembler injection', () => {
  it('omits board tools when no board binding is wired', async () => {
    const { dir, cleanup } = await createMinimalProfile()
    cleanups.push(cleanup)
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)
    const names = new Set(assembled.tools.map((t) => t.name))
    expect(names.has('board_write')).toBe(false)
    expect(names.has('board_update')).toBe(false)
  })

  it('injects board_write + board_update when a board binding is wired', async () => {
    const { dir, cleanup } = await createMinimalProfile()
    cleanups.push(cleanup)
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile, {
      board: { store: makeStore(), workspaceId: 'ws_1', originThreadId: 'thread_1' },
    })
    const names = new Set(assembled.tools.map((t) => t.name))
    expect(names.has('board_write')).toBe(true)
    expect(names.has('board_update')).toBe(true)
  })
})
