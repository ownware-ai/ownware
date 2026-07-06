/**
 * Unit tests for the board tool bodies (Slice 2):
 *   - `board_write`  → SqliteBoardStore.replaceStructure
 *   - `board_update` → updateSliceStatus / setBoardStatus / addFinding / updateFindingStatus
 *
 * Real SQLite-backed store in a temp dir (true round-trip, no mocks).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { SqliteBoardStore } from '../../../src/boards/store.js'
import { BoardEventBus } from '../../../src/boards/event-bus.js'
import { createBoardWriteTool } from '../../../src/boards/write-tool.js'
import { createBoardUpdateTool } from '../../../src/boards/update-tool.js'
import type { Tool, ToolContext, ToolResult } from '@ownware/loom'

const WS = 'ws_tools_1'

let tmpDir: string
let db: CortexDatabase
let bus: BoardEventBus
let store: SqliteBoardStore

function stubContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'session-test',
    agentId: null,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: {} as ToolContext['config'],
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

async function run(tool: Tool, input: Record<string, unknown>): Promise<ToolResult> {
  const result = await tool.execute(input, stubContext())
  if (result == null || typeof (result as ToolResult).content !== 'string') {
    throw new Error('Tool returned a generator instead of a ToolResult.')
  }
  return result as ToolResult
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-board-tools-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  bus = new BoardEventBus()
  store = new SqliteBoardStore(db.rawMainHandle, bus)
  db.rawMainHandle
    .prepare(`INSERT INTO workspaces (id, name, path) VALUES (?, 'arvo', '/tmp/arvo')`)
    .run(WS)
  // Seed the drafting thread so board_write's origin_thread_id FK is satisfied.
  db.rawMainHandle
    .prepare(
      `INSERT INTO threads (id, profile_id, status, message_count, total_tokens, total_cost)
       VALUES ('thread_x', 'test', 'active', 0, 0, 0)`,
    )
    .run()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeTool(): Tool {
  return createBoardWriteTool({ store, workspaceId: WS, originThreadId: 'thread_x' })
}

const sampleInput = {
  slug: 'Login Hardening!',
  title: 'Harden login',
  goal: 'Stop credential stuffing',
  approach: 'Limiter first, then alerts.',
  slices: [
    { title: 'Rate-limit login', summary: '5/15m per IP' },
    { title: 'Email alerts' },
    { title: 'Timing audit' },
  ],
}

describe('board_write', () => {
  it('writes a board into the store and slugifies the slug', async () => {
    const res = await run(writeTool(), sampleInput)
    expect(res.isError).toBe(false)
    const boardId = (res.metadata as { boardId: string }).boardId
    const board = store.getById(boardId)!
    expect(board.slug).toBe('login-hardening')
    expect(board.workspaceId).toBe(WS)
    expect(board.originThreadId).toBe('thread_x')
    expect(board.status).toBe('draft')
    expect(board.slices.map((s) => s.title)).toEqual([
      'Rate-limit login',
      'Email alerts',
      'Timing audit',
    ])
    expect(res.content).toContain('present this to the user for approval')
  })

  it('is idempotent on slug — re-draft updates in place', async () => {
    await run(writeTool(), sampleInput)
    await run(writeTool(), { ...sampleInput, title: 'Harden login v2', slices: [{ title: 'one' }] })
    const list = store.listForWorkspace(WS)
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Harden login v2')
    expect(list[0]?.sliceCount).toBe(1)
  })

  it('rejects an empty slices array', async () => {
    const res = await run(writeTool(), { slug: 'x', title: 'x', slices: [] })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('at least one slice')
  })
})

describe('board_update', () => {
  async function seedBoard(): Promise<string> {
    const res = await run(writeTool(), sampleInput)
    return (res.metadata as { boardId: string }).boardId
  }

  it('slice_status flips a slice', async () => {
    const boardId = await seedBoard()
    const sliceId = store.getById(boardId)!.slices[0]!.id
    const tool = createBoardUpdateTool({ store })
    const res = await run(tool, { boardId, action: 'slice_status', sliceId, status: 'done' })
    expect(res.isError).toBe(false)
    expect(store.getById(boardId)!.slices[0]?.status).toBe('done')
  })

  it('board_status moves the lifecycle', async () => {
    const boardId = await seedBoard()
    const tool = createBoardUpdateTool({ store })
    await run(tool, { boardId, action: 'board_status', status: 'awaiting' })
    expect(store.getById(boardId)!.status).toBe('awaiting')
    await run(tool, { boardId, action: 'board_status', status: 'running' })
    expect(store.getById(boardId)!.status).toBe('running')
  })

  it('add_finding logs a finding attributed to a slice', async () => {
    const boardId = await seedBoard()
    const sliceId = store.getById(boardId)!.slices[1]!.id
    const tool = createBoardUpdateTool({ store })
    const res = await run(tool, {
      boardId,
      action: 'add_finding',
      title: 'double-send race',
      detail: 'block() fires twice',
      sliceId,
    })
    expect(res.isError).toBe(false)
    const findings = store.getById(boardId)!.findings
    expect(findings).toHaveLength(1)
    expect(findings[0]?.title).toBe('double-send race')
    expect(findings[0]?.sliceId).toBe(sliceId)
  })

  it('finding_status resolves a finding', async () => {
    const boardId = await seedBoard()
    const tool = createBoardUpdateTool({ store })
    const added = await run(tool, { boardId, action: 'add_finding', title: 'bug' })
    const findingId = (added.metadata as { findingId: string }).findingId
    await run(tool, { boardId, action: 'finding_status', findingId, status: 'resolved' })
    expect(store.getById(boardId)!.findings[0]?.status).toBe('resolved')
  })

  it('errors on an unknown slice', async () => {
    const boardId = await seedBoard()
    const tool = createBoardUpdateTool({ store })
    const res = await run(tool, { boardId, action: 'slice_status', sliceId: 'nope', status: 'done' })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not found')
  })

  it('rejects an invalid action', async () => {
    const boardId = await seedBoard()
    const tool = createBoardUpdateTool({ store })
    const res = await run(tool, { boardId, action: 'frobnicate' })
    expect(res.isError).toBe(true)
  })
})
