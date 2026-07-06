/**
 * FIXTURE BATCH 4 — Polish (permissions, system events, multi-turn)
 *
 * Records 12 real agent conversations into the Cortex SQLite database so
 * a UI client can replay them offline via:
 *   GET /api/v1/threads/:tid/agents/:aid/events
 *
 * Covers: permission strip states (allow/deny/always), queued permissions,
 * multi-turn conversation receipts, error recovery, security blocks, and
 * the full session lifecycle. Completes the 48-fixture coverage matrix.
 *
 * Requires ANTHROPIC_API_KEY. ~$2-4 in credits. ~10-20 minutes.
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
// Permission helpers — three variants for the three permission scenarios
// ---------------------------------------------------------------------------

async function runToCompletionAutoApprove(
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

async function runToCompletionDeny(
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
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, { action: 'deny' })
    }
  }
}

async function runToCompletionAlwaysAllow(
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
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, { action: 'always' })
    }
  }
}

// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Fixture batch 4 — Polish', () => {
  let gw: TestGateway
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      dbPath: join(homedir(), '.ownware', 'ownware.db'),
    })
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

  // ── 1/12 — perm-single-allow ──────────────────────────────────────────────

  it('fixture:perm-single-allow — single write permission, approved', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:perm-single-allow] Single write permission, approved',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Write a file to /tmp/fixture-perm-allow.txt with the content ' +
        '"permission approved test" using writeFile. Then read it back to confirm.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)

    const permResponses = rootEvents.filter(e => e.type === 'permission.response')
    expect(permResponses.length).toBeGreaterThan(0)
    expect(
      permResponses.some(e => (e.payload as { granted: boolean }).granted === true),
    ).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.some(e => (e.payload as { toolName: string }).toolName === 'writeFile'),
    ).toBe(true)
    expect(
      toolStarts.some(e => (e.payload as { toolName: string }).toolName === 'readFile'),
    ).toBe(true)
  }, 180_000)

  // ── 2/12 — perm-single-deny ───────────────────────────────────────────────

  it('fixture:perm-single-deny — single write permission, denied', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:perm-single-deny] Single write permission, denied',
      wsId,
    )

    await runToCompletionDeny(
      gw, thread.id,
      'Write a file to /tmp/fixture-perm-deny.txt with the content ' +
        '"this should be denied" using writeFile.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)

    const permResponses = rootEvents.filter(e => e.type === 'permission.response')
    expect(permResponses.length).toBeGreaterThan(0)
    expect(
      permResponses.some(e => (e.payload as { granted: boolean }).granted === false),
    ).toBe(true)

    // Agent should explain the denial in text
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)
  }, 180_000)

  // ── 3/12 — perm-allow-always ──────────────────────────────────────────────

  it('fixture:perm-allow-always — permission with "allow always"', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:perm-allow-always] Permission with "allow always"',
      wsId,
    )

    await runToCompletionAlwaysAllow(
      gw, thread.id,
      'Write a file to /tmp/fixture-perm-always-1.txt with "first write". ' +
        'Then write a second file to /tmp/fixture-perm-always-2.txt with "second write". ' +
        'Report whether both writes succeeded.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'permission.request')).toBe(true)

    const permResponses = rootEvents.filter(e => e.type === 'permission.response')
    expect(permResponses.length).toBeGreaterThan(0)
    expect(
      permResponses.some(e => (e.payload as { granted: boolean }).granted === true),
    ).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.filter(e => (e.payload as { toolName: string }).toolName === 'writeFile').length,
    ).toBeGreaterThanOrEqual(2)
  }, 180_000)

  // ── 4/12 — perm-queued-sequential ────────────────────────────────────────

  it('fixture:perm-queued-sequential — multiple permissions in sequence', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:perm-queued-sequential] Multiple permissions in sequence',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Do these three things in order: ' +
        '(1) Write /tmp/fixture-queue-1.txt with "first" ' +
        '(2) Write /tmp/fixture-queue-2.txt with "second" ' +
        '(3) Write /tmp/fixture-queue-3.txt with "third" ' +
        'Report the result of each write.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const permRequests = rootEvents.filter(e => e.type === 'permission.request')
    expect(permRequests.length).toBeGreaterThanOrEqual(2)

    const permResponses = rootEvents.filter(e => e.type === 'permission.response')
    expect(permResponses.length).toBeGreaterThanOrEqual(2)
  }, 180_000)

  // ── 5/12 — multi-turn-simple ──────────────────────────────────────────────

  it('fixture:multi-turn-simple — three-turn conversation', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:multi-turn-simple] Three-turn conversation',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'What is dependency injection? Answer in 2 sentences. No tools.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Now give me a concrete TypeScript example of DI using constructor injection. No tools, just code.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      "What's the main drawback of constructor injection vs property injection? One sentence. No tools.",
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(3)
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)
    expect(rootEvents.some(e => e.type === 'tool.call.start')).toBe(false)
  }, 240_000)

  // ── 6/12 — multi-turn-with-tools ─────────────────────────────────────────

  it('fixture:multi-turn-with-tools — multi-turn with tools each turn', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:multi-turn-with-tools] Multi-turn with tools each turn',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Use glob to find all .ts files under commands/. Just list them.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Now use readFile to read the first file from that list. Show me the first 20 lines.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Use grep to search for "export" in that same file. How many exports does it have?',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(3)

    const toolNames = rootEvents
      .filter(e => e.type === 'tool.call.start')
      .map(e => (e.payload as { toolName: string }).toolName)
    expect(toolNames.some(n => n === 'glob')).toBe(true)
    expect(toolNames.some(n => n === 'readFile')).toBe(true)
    expect(toolNames.some(n => n === 'grep')).toBe(true)
  }, 240_000)

  // ── 7/12 — multi-turn-context ─────────────────────────────────────────────

  it('fixture:multi-turn-context — multi-turn builds on context', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:multi-turn-context] Multi-turn builds on context',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Use readFile to read entrypoints/cli.tsx. Summarize it in 3 bullet points.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Based on what you just read, what would you change to add a --verbose flag? ' +
        'Describe in 2 sentences. Don\'t use any tools.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(2)

    // First turn must have readFile
    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    expect(
      toolStarts.some(e => (e.payload as { toolName: string }).toolName === 'readFile'),
    ).toBe(true)

    // Second turn must produce text (context carried forward)
    const lastTurnEndSeq = turnEnds[turnEnds.length - 2]?.seq ?? 0
    const secondTurnText = rootEvents
      .filter(e => e.seq > lastTurnEndSeq && e.type === 'text.delta')
      .map(e => (e.payload as { text: string }).text)
      .join('')
    expect(secondTurnText.length).toBeGreaterThan(50)
  }, 240_000)

  // ── 8/12 — system-error-recovery ─────────────────────────────────────────

  it('fixture:system-error-recovery — tool error then recovery', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:system-error-recovery] Tool error then recovery',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'First, try to read /nonexistent/path.ts — it will fail. ' +
        'Then recover by reading entrypoints/cli.tsx instead. ' +
        'Explain what happened in 2 sentences.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const toolEnds = rootEvents.filter(e => e.type === 'tool.call.end')
    expect(
      toolEnds.some(e => (e.payload as { isError: boolean }).isError === true),
    ).toBe(true)
    expect(
      toolEnds.some(e => (e.payload as { isError: boolean }).isError === false),
    ).toBe(true)

    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)
  }, 180_000)

  // ── 9/12 — system-security-block ─────────────────────────────────────────

  it('fixture:system-security-block — security block event', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:system-security-block] Security block event',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Try to run this shell command: rm -rf /tmp/fixture-security-test',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const hadSecurityBlock = rootEvents.some(e => e.type === 'security.block')
    const hadToolCall = rootEvents.some(e => e.type === 'tool.call.start')
    const hadTextOnly = rootEvents.some(e => e.type === 'text.delta')

    if (hadSecurityBlock) {
      console.log('[fixture:system-security-block] security.block event captured ✓')
    } else if (hadToolCall) {
      // Shell was called (with permission) — command ran
      console.log('[fixture:system-security-block] Shell called — rm executed with permission approval')
    } else if (hadTextOnly) {
      console.log('[fixture:system-security-block] Model refused via text (no tool call) — valid fixture for refusal rendering')
    }

    // At minimum: the session ran and something happened
    expect(hadSecurityBlock || hadToolCall || hadTextOnly).toBe(true)
  }, 180_000)

  // ── 10/12 — full-session-receipt ─────────────────────────────────────────

  it('fixture:full-session-receipt — complete session with receipt', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:full-session-receipt] Complete session with receipt',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Read entrypoints/cli.tsx, then write a 3-sentence summary of the project. Keep it brief.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })

    expect(rootEvents.some(e => e.type === 'session.start')).toBe(true)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    const toolEnds = rootEvents.filter(e => e.type === 'tool.call.end')
    expect(toolStarts.length).toBeGreaterThan(0)
    expect(toolEnds.length).toBeGreaterThan(0)

    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)

    // Receipt data: turn.end with usage payload
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThan(0)
    const hasCostData = turnEnds.some(e => {
      const payload = e.payload as { usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }
      return payload.usage?.inputTokens !== undefined || payload.usage?.outputTokens !== undefined
    })
    if (!hasCostData) {
      console.log('[fixture:full-session-receipt] NOTE: turn.end payload does not include usage — check gateway SSE enricher')
    }
  }, 180_000)

  // ── 11/12 — multi-turn-long-session ──────────────────────────────────────

  it('fixture:multi-turn-long-session — long session, 4 turns', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:multi-turn-long-session] Long session, 4 turns',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Use glob to list all directories in the workspace root.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Interesting. Use readFile to read the first .ts file in entrypoints/. Summarize in 2 sentences.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      'Based on that file, use grep to find all imports. List them.',
      wsId,
    )
    await runToCompletionAutoApprove(
      gw, thread.id,
      "Write a 2-sentence overall assessment of this project's code quality based on everything you've seen. No tools.",
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const turnEnds = rootEvents.filter(e => e.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(4)

    const toolStarts = rootEvents.filter(e => e.type === 'tool.call.start')
    // At least 3 of the 4 turns have tool calls
    expect(toolStarts.length).toBeGreaterThanOrEqual(3)
  }, 240_000)

  // ── 12/12 — idle-complete-state ───────────────────────────────────────────

  it('fixture:idle-complete-state — simple complete conversation for idle state', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:idle-complete-state] Simple complete conversation for idle state',
      wsId,
    )

    await runToCompletionAutoApprove(
      gw, thread.id,
      'Explain what a REST API is in 3 short sentences. Do not use any tools.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })

    expect(rootEvents.some(e => e.type === 'session.start')).toBe(true)
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)
    expect(rootEvents.some(e => e.type === 'tool.call.start')).toBe(false)

    if (rootEvents.some(e => e.type === 'session.end')) {
      console.log('[fixture:idle-complete-state] session.end captured ✓')
    } else {
      console.log('[fixture:idle-complete-state] NOTE: session.end not emitted — turn.end sufficient for idle-complete rendering')
    }
  }, 180_000)
})
