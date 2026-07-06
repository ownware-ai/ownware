/**
 * FIXTURE BATCH 2 — Tool Combinations (multi-tool, errors, writes + perm)
 *
 * Records 12 real agent conversations into the Cortex SQLite database so
 * a UI client can replay them offline via:
 *   GET /api/v1/threads/:tid/agents/:aid/events
 *
 * Captures multi-tool chains, tool errors, write-triggered permission strips,
 * and multi-turn tool sequences. Every scenario uses profileId='coder' and
 * a real source-tree workspace.
 *
 * Learnings applied from Batch 1:
 *  - shell tool = 'shell_execute' (not 'shell')
 *  - package.json is NOT in src/; use real paths (entrypoints/, components/, hooks/)
 *  - text.delta assertions at ≥5, not ≥30
 *  - get-or-create workspace pattern in beforeAll
 *  - writes go to /tmp/ paths only
 *
 * Requires ANTHROPIC_API_KEY. ~$2-3 in credits. ~10-15 minutes.
 * Sequential only — do NOT run in parallel.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')
const WORKSPACE_PATH = '/tmp/ownware-fixture-workspace/src'

// ---------------------------------------------------------------------------
// Helper — drive a single run to completion, auto-approve permissions
// ---------------------------------------------------------------------------

async function runToCompletion(
  gw: TestGateway,
  threadId: string,
  prompt: string,
  workspaceId: string,
): Promise<void> {
  const { events } = await gw.client.sseRaw('/api/v1/run', {
    prompt,
    profileId: 'coder',
    threadId,
    workspaceId,
  })
  for await (const e of events) {
    if (e.event === 'permission.request') {
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, { action: 'approve' })
    }
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Fixture batch 2 — Tool Combinations', () => {
  let gw: TestGateway
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      dbPath: join(homedir(), '.ownware', 'ownware.db'),
    })
    // get-or-create: workspace path already exists in real DB after batch 1
    // Ensure the fixture workspace directory exists on disk so agent
    // tool calls (shell, readFile, glob) have a real cwd to operate in.
    mkdirSync(WORKSPACE_PATH, { recursive: true })
    const existing = gw.state.getWorkspaceByPath(WORKSPACE_PATH)
    const ws = existing ?? gw.state.createWorkspace(WORKSPACE_PATH, 'fixture-sandbox')
    wsId = ws.id
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  // ── 1/12 — tool-sequential-3 ─────────────────────────────────────────────

  it('fixture:tool-sequential-3 — three tools in sequence, one turn', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-sequential-3] Three tools in sequence, one turn',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Do these three things in order, each as a separate tool call: ' +
        '(1) Use glob to find all .tsx files under components/. ' +
        '(2) Use grep to search for "useState" in those files. ' +
        '(3) Use readFile to read the first .tsx file you found. ' +
        'After all three, write ONE sentence summarizing what you found.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(toolStarts.length).toBeGreaterThanOrEqual(3)

    const toolNames = toolStarts.map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'glob')).toBe(true)
    expect(toolNames.some(n => n === 'grep')).toBe(true)
    expect(toolNames.some(n => n === 'readFile')).toBe(true)
  }, 180_000)

  // ── 2/12 — tool-parallel-reads ────────────────────────────────────────────

  it('fixture:tool-parallel-reads — multiple reads in parallel', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-parallel-reads] Multiple reads in parallel',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Read these three files IN PARALLEL (issue all three readFile calls at once, ' +
        'do not wait for one before starting the next): ' +
        'context/modalContext.tsx, hooks/useAfterFirstRender.ts, entrypoints/init.ts. ' +
        'After reading all three, write ONE sentence about each file.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.filter(e => (e.payload as { toolName: string }).toolName === 'readFile').length,
    ).toBeGreaterThanOrEqual(3)

    // Parallel dispatch: all 3 tool.call.start should appear before any tool.call.end
    // (seq numbers prove ordering). Relax if model doesn't batch — the fixture is
    // still valid regardless of dispatch strategy.
    const firstToolEndSeq = rootEvents.find(e => e.type === 'tool.call.end')?.seq ?? Infinity
    const readFileStarts = toolStarts
      .filter(e => (e.payload as { toolName: string }).toolName === 'readFile')
      .map(e => e.seq)
    const allStartsBeforeFirstEnd = readFileStarts.every(seq => seq < firstToolEndSeq)
    if (!allStartsBeforeFirstEnd) {
      console.log('[fixture:tool-parallel-reads] NOTE: model dispatched reads sequentially, not in parallel — still a valid fixture')
    }
  }, 180_000)

  // ── 3/12 — tool-editfile-permission ──────────────────────────────────────

  it('fixture:tool-editfile-permission — editFile triggers permission', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-editfile-permission] editFile triggers permission',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'First, read the file at commands/advisor.ts. Then use writeFile to create ' +
        '/tmp/fixture-edit-test.ts with this exact content: ' +
        '"// fixture test\\nexport const x = 1;". ' +
        'This should trigger a permission prompt. Do not modify any original files.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.response')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const toolNames = toolStarts.map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'editFile' || n === 'writeFile')).toBe(true)
  }, 180_000)

  // ── 4/12 — tool-writefile-permission ─────────────────────────────────────

  it('fixture:tool-writefile-permission — writeFile triggers permission', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-writefile-permission] writeFile triggers permission',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Create a new file at /tmp/fixture-write-test.ts with this content: ' +
        'export const FIXTURE = true; ' +
        '— using the writeFile tool. Then confirm it was created by reading it back with readFile.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const toolNames = toolStarts.map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'writeFile')).toBe(true)
    expect(toolNames.some(n => n === 'readFile')).toBe(true)
  }, 180_000)

  // ── 5/12 — tool-error-notfound ────────────────────────────────────────────

  it('fixture:tool-error-notfound — tool error — file not found', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-error-notfound] Tool error — file not found',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Use readFile to read a file that does NOT exist: ' +
        'nonexistent/this-file-does-not-exist.ts ' +
        'Then report what error you got in one sentence.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolEnds = rootEvents.filter(e => e.type === 'tool.call.end')
    expect(toolEnds.length).toBeGreaterThan(0)
    expect(
      toolEnds.some(e => (e.payload as { isError: boolean }).isError === true),
    ).toBe(true)

    // Agent should explain the error in text after the tool failure
    const lastToolEndSeq = Math.max(...toolEnds.map(e => e.seq))
    const hasTextAfterError = rootEvents
      .filter(e => e.seq > lastToolEndSeq && e.type === 'text.delta')
      .length > 0
    expect(hasTextAfterError).toBe(true)
  }, 180_000)

  // ── 6/12 — tool-error-shell ───────────────────────────────────────────────

  it('fixture:tool-error-shell — shell command fails', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-error-shell] Shell command fails',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Run this shell command: cat /nonexistent/path/file.txt ' +
        'Then explain the error you got in one sentence.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.some(e => (e.payload as { toolName: string }).toolName === 'shell_execute'),
    ).toBe(true)

    // Shell may return exit code in result text rather than isError flag —
    // just confirm a tool.call.end was emitted
    expect(rootEvents.some(e => e.type === 'tool.call.end')).toBe(true)

    // Agent should produce explanatory text after the failed shell call
    const lastToolEndSeq = Math.max(
      ...rootEvents.filter(e => e.type === 'tool.call.end').map(e => e.seq),
    )
    expect(
      rootEvents.some(e => e.seq > lastToolEndSeq && e.type === 'text.delta'),
    ).toBe(true)
  }, 180_000)

  // ── 7/12 — tool-search-chain ──────────────────────────────────────────────

  it('fixture:tool-search-chain — glob → grep → readFile chain', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-search-chain] Glob → grep → readFile chain',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Step 1: Use glob to find all .ts files under entrypoints/. ' +
        'Step 2: Use grep to search for "process.exit" across those files. ' +
        'Step 3: Use readFile on the first file that matched. ' +
        'After all three steps, explain what you found in 2 sentences. ' +
        'Execute each step as a separate tool call.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(toolStarts.length).toBeGreaterThanOrEqual(3)

    const toolNames = new Set(
      toolStarts.map(e => (e.payload as { toolName: string }).toolName),
    )
    // Should involve at least 2 different tool types
    expect(toolNames.size).toBeGreaterThanOrEqual(2)

    // text.delta must appear after last tool.call.end
    const lastToolEndSeq = Math.max(
      ...rootEvents.filter(e => e.type === 'tool.call.end').map(e => e.seq),
    )
    expect(rootEvents.some(e => e.seq > lastToolEndSeq && e.type === 'text.delta')).toBe(true)
  }, 180_000)

  // ── 8/12 — tool-mixed-read-write ─────────────────────────────────────────

  it('fixture:tool-mixed-read-write — read then write workflow', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-mixed-read-write] Read then write workflow',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Read the file at entrypoints/cli.tsx. Then write a one-paragraph summary of ' +
        'its first 10 lines to /tmp/fixture-summary.md using writeFile. ' +
        'After writing, read /tmp/fixture-summary.md back with readFile and confirm the content.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const toolNames = toolStarts.map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'readFile')).toBe(true)
    expect(toolNames.some(n => n === 'writeFile')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)

    // text.delta after the last tool
    const lastToolEndSeq = Math.max(
      ...rootEvents.filter(e => e.type === 'tool.call.end').map(e => e.seq),
    )
    expect(rootEvents.some(e => e.seq > lastToolEndSeq && e.type === 'text.delta')).toBe(true)
  }, 180_000)

  // ── 9/12 — tool-shell-pipe ────────────────────────────────────────────────

  it('fixture:tool-shell-pipe — shell with pipes', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-shell-pipe] Shell with pipes',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Run this shell command in the workspace: ' +
        'find . -name "*.ts" -maxdepth 2 | head -20 ' +
        'Then tell me in one sentence how many .ts files you saw.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.some(e => (e.payload as { toolName: string }).toolName === 'shell_execute'),
    ).toBe(true)

    expect(rootEvents.some(e => e.type === 'tool.call.end')).toBe(true)

    const lastToolEndSeq = Math.max(
      ...rootEvents.filter(e => e.type === 'tool.call.end').map(e => e.seq),
    )
    expect(rootEvents.some(e => e.seq > lastToolEndSeq && e.type === 'text.delta')).toBe(true)
  }, 180_000)

  // ── 10/12 — tool-multi-turn-chain ─────────────────────────────────────────

  it('fixture:tool-multi-turn-chain — tools across multiple turns', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-multi-turn-chain] Tools across multiple turns',
      wsId,
    )

    // First turn: glob
    await runToCompletion(
      gw,
      thread.id,
      'Use glob to list all .tsx files in components/. Just list them, don\'t explain.',
      wsId,
    )

    // Second turn on the same thread: readFile from the previous list
    await runToCompletion(
      gw,
      thread.id,
      'Good. Now use readFile to read the first .tsx file from the list you just showed me. ' +
        'Then summarize it in one sentence.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)

    // Two turns = at least 2 turn.end events
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(2)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const toolNames = toolStarts.map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'glob')).toBe(true)
    expect(toolNames.some(n => n === 'readFile')).toBe(true)
  }, 180_000)

  // ── 11/12 — tool-ask-human ────────────────────────────────────────────────

  it('fixture:tool-ask-human — invisible ask_human tool', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-ask-human] Invisible ask_human tool',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'I need your help deciding something. Ask me whether I prefer a monorepo or ' +
        'multi-repo setup for this project. Use the ask_human tool to ask me this question.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    // ask_human is an invisible tool (Rule 2 — no tool line rendered in the client).
    // Model may or may not have it; text.delta is the minimum invariant either way.
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const usedAskHuman = toolStarts.some(
      e => (e.payload as { toolName: string }).toolName === 'ask_human',
    )
    if (!usedAskHuman) {
      console.log('[fixture:tool-ask-human] NOTE: ask_human tool not called — model wrote question as plain text (valid fixture)')
    }
  }, 180_000)

  // ── 12/12 — tool-todo-checklist ───────────────────────────────────────────

  it('fixture:tool-todo-checklist — todo tool renders inline', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:tool-todo-checklist] Todo tool renders inline',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Create a 4-item task list for refactoring an authentication module. ' +
        'Use the todo tool if available, otherwise write it as a markdown checklist. ' +
        'The tasks should cover: (1) audit current code, (2) write tests, ' +
        '(3) implement changes, (4) code review.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.length).toBeGreaterThan(0)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)

    const combinedText = rootEvents
      .filter(e => e.type === 'text.delta')
      .map(e => (e.payload as { text: string }).text)
      .join('')
    expect(
      combinedText.toLowerCase().includes('audit') ||
        combinedText.toLowerCase().includes('test') ||
        combinedText.toLowerCase().includes('review'),
    ).toBe(true)
  }, 180_000)
})
