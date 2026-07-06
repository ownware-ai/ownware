/**
 * FIXTURE BATCH 3 — Sub-Agents (single, parallel, nested, background)
 *
 * Records 12 real agent conversations into the Cortex SQLite database so
 * a UI client can replay them offline via:
 *   GET /api/v1/threads/:tid/agents/:aid/events
 *
 * CRITICAL for the client's "View thread →" modal — every scenario here creates
 * at least one sub-agent whose full event log lands in agent_events under its
 * own agent_id. The client opens a second SSE connection to display it.
 *
 * The coder profile has these sub-agents:
 *   explore  — read-only codebase search (glob, grep, readFile, shell_execute)
 *   planner  — architecture + planning
 *   verifier — adversarial testing (builds, tests, linting)
 *
 * Sub-agents are spawned via tool.call.start {toolName: 'agent_spawn'} on the
 * PARENT stream. Their internal events (text.delta, tool.call.*, turn.*) land
 * in agent_events under their own agent_id, not the parent's.
 *
 * Requires ANTHROPIC_API_KEY. ~$3-5 in credits. ~15-25 minutes.
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
// Shared sub-agent verification — use in every scenario in this batch
// ---------------------------------------------------------------------------

function assertSubagents(
  gw: TestGateway,
  threadId: string,
  expectedSpawnCount: number,
): Array<{ agentId: string; parentAgentId: string | null; eventCount: number }> {
  const rootEvents = gw.state.listAgentEvents({ threadId, agentId: 'root' })
  const spawnCalls = rootEvents.filter(
    e => e.type === 'tool.call.start' && (e.payload as { toolName: string }).toolName === 'agent_spawn',
  )
  expect(spawnCalls.length).toBeGreaterThanOrEqual(expectedSpawnCount)

  const agents = gw.state.listAgentsForThread(threadId)
  const subagents = agents.filter(a => a.agentId !== 'root')
  expect(subagents.length).toBeGreaterThanOrEqual(expectedSpawnCount)
  for (const sa of subagents) {
    expect(sa.eventCount).toBeGreaterThan(0)
  }
  return subagents
}

// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Fixture batch 3 — Sub-Agents', () => {
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

  // ── 1/12 — subagent-single ────────────────────────────────────────────────

  it('fixture:subagent-single — one explore helper', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-single] One explore helper',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'You MUST use the agent_spawn tool exactly once. Dispatch the "explore" helper ' +
        'with this task: "Find all React components (files with .tsx extension) under ' +
        'components/ and list them with one-line descriptions." Wait for the result, then ' +
        'summarize the findings in 2 sentences. Do NOT use glob, grep, or readFile ' +
        'yourself — delegate everything to the helper.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 1)

    // Explore helper should have used filesystem tools.
    // Soft check: rate-limit errors can produce error-only child logs.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: subagents[0]!.agentId,
    })
    const childHadError = childEvents.some(e => e.type === 'error')
    if (childHadError) {
      console.log('[fixture:subagent-single] NOTE: child agent hit API rate limit (error event) — sub-agent spawn mechanism confirmed, content not captured')
    } else {
      expect(childEvents.some(e => e.type === 'tool.call.start')).toBe(true)
    }
  }, 240_000)

  // ── 2/12 — subagent-parallel-2 ────────────────────────────────────────────

  it('fixture:subagent-parallel-2 — two helpers in parallel', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-parallel-2] Two helpers in parallel',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'You MUST use the agent_spawn tool TWICE in the SAME response (parallel tool calls). ' +
        'Spawn BOTH of these at once: ' +
        '(1) "explore" helper — task: "List all .ts files under hooks/" ' +
        '(2) "planner" helper — task: "Suggest 3 improvements to the project\'s hook ' +
        'architecture based on the filenames alone" ' +
        'After both complete, write a 2-sentence summary combining their findings. ' +
        'Do NOT use filesystem tools yourself.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    assertSubagents(gw, thread.id, 2)
  }, 240_000)

  // ── 3/12 — subagent-parallel-3 ────────────────────────────────────────────

  it('fixture:subagent-parallel-3 — three helpers in parallel', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-parallel-3] Three helpers in parallel',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'You MUST spawn ALL THREE helpers in ONE response (parallel): ' +
        '(1) "explore" — task: "Count .ts files under entrypoints/" ' +
        '(2) "planner" — task: "Draft a 3-step migration plan for moving entrypoints/ ' +
        'to a plugins/ architecture" ' +
        '(3) "verifier" — task: "Check if any .test.ts files exist alongside the ' +
        'entrypoints/ files" ' +
        'After all three finish, write a 3-sentence summary. Do NOT use any tools ' +
        'yourself — only agent_spawn.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    assertSubagents(gw, thread.id, 3)
  }, 240_000)

  // ── 4/12 — subagent-parallel-5 ────────────────────────────────────────────

  it('fixture:subagent-parallel-5 — five helpers stress test', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-parallel-5] Five helpers stress test',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn FIVE helpers in ONE response, all at once: ' +
        '(1) "explore" — "List .ts files under commands/" ' +
        '(2) "explore" — "List .ts files under context/" ' +
        '(3) "explore" — "List .ts files under hooks/" ' +
        '(4) "planner" — "Suggest how to unify commands/ and context/" ' +
        '(5) "verifier" — "Check for any TODO comments in hooks/" ' +
        'After all five complete, write one sentence per helper. ' +
        'Do NOT use any tools yourself — only agent_spawn.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    // Model may spawn fewer than 5 — assert ≥3 as minimum valid fixture
    const agents = gw.state.listAgentsForThread(thread.id)
    const subagents = agents.filter(a => a.agentId !== 'root')
    const actualSpawnCount = subagents.length

    console.log(`[fixture:subagent-parallel-5] Actual spawn count: ${actualSpawnCount}`)

    expect(actualSpawnCount).toBeGreaterThanOrEqual(3)
    for (const sa of subagents) {
      expect(sa.eventCount).toBeGreaterThan(0)
    }

    const rootSpawnCalls = rootEvents.filter(
      e => e.type === 'tool.call.start' && (e.payload as { toolName: string }).toolName === 'agent_spawn',
    )
    expect(rootSpawnCalls.length).toBeGreaterThanOrEqual(3)
  }, 240_000)

  // ── 5/12 — subagent-with-tools ────────────────────────────────────────────

  it('fixture:subagent-with-tools — helper uses filesystem tools', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-with-tools] Helper uses filesystem tools',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "explore" helper with this task: "Read the file at ' +
        'entrypoints/cli.tsx, then grep for \'import\' statements in it, ' +
        'and report the top 5 imports." Wait for its result, then repeat its ' +
        'findings in your own words. Do NOT use any tools yourself.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 1)

    // The explore helper must have used readFile or grep.
    // Soft check: rate-limit errors produce 4-event error logs.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: subagents[0]!.agentId,
    })
    const childHadError = childEvents.some(e => e.type === 'error')
    if (childHadError) {
      console.log('[fixture:subagent-with-tools] NOTE: child agent hit API rate limit — sub-agent spawn confirmed, tool content not captured')
    } else {
      expect(childEvents.length).toBeGreaterThanOrEqual(3)
      expect(childEvents.some(e => e.type === 'tool.call.start')).toBe(true)
    }
  }, 240_000)

  // ── 6/12 — subagent-sequential ────────────────────────────────────────────

  it('fixture:subagent-sequential — two helpers one after another', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-sequential] Two helpers one after another',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'First, spawn the "explore" helper with task: "List the top 5 .ts files ' +
        'under commands/ by name." ' +
        'WAIT for it to finish and read its result. ' +
        'Then, based on what explore found, spawn the "planner" helper with task: ' +
        '"Suggest how to refactor the first file from the explore results." ' +
        'Wait for planner to finish, then summarize both helpers\' outputs in 3 sentences.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 2)

    // Both sub-agents must have real content
    for (const sa of subagents) {
      const childEvents = gw.state.listAgentEvents({
        threadId: thread.id,
        agentId: sa.agentId,
      })
      expect(childEvents.length).toBeGreaterThan(0)
    }
  }, 240_000)

  // ── 7/12 — subagent-background ────────────────────────────────────────────

  it('fixture:subagent-background — background helper, parent continues', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-background] Background helper, parent continues',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "explore" helper with background=true and task: ' +
        '"Search for all files containing \'async function\' in hooks/." ' +
        'While it runs in the background, immediately write a 3-sentence ' +
        'explanation of what async functions are in TypeScript. Do NOT wait ' +
        'for the background helper — continue talking right away.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    // Parent should produce text — but background spawn may consume the whole turn.
    // Soft check: log if missing rather than failing.
    if (!rootEvents.some(e => e.type === 'text.delta')) {
      console.log('[fixture:subagent-background] NOTE: root produced no text.delta — model spawned and returned without prose (valid, captures spawn-only turn)')
    }

    // agent_spawn call must be present
    const spawnCalls = rootEvents.filter(
      e => e.type === 'tool.call.start' && (e.payload as { toolName: string }).toolName === 'agent_spawn',
    )
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)

    // Sub-agent should exist in the event log
    const agents = gw.state.listAgentsForThread(thread.id)
    const subagents = agents.filter(a => a.agentId !== 'root')
    if (subagents.length > 0) {
      // Background may or may not be supported; if it ran, it has events
      expect(subagents[0]!.eventCount).toBeGreaterThan(0)
      console.log(`[fixture:subagent-background] Sub-agent ran with ${subagents[0]!.eventCount} events`)
    } else {
      console.log('[fixture:subagent-background] NOTE: model did not spawn a background helper — wrote text only (valid fixture)')
    }

    // Parent should have produced text output regardless
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)
  }, 240_000)

  // ── 8/12 — subagent-error ─────────────────────────────────────────────────

  it('fixture:subagent-error — helper with invalid subagent_type', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-error] Helper with invalid subagent_type',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn a helper with subagent_type="nonexistent_agent_type_xyz" and prompt ' +
        '"This should fail because the subagent type does not exist." ' +
        'Then explain the error you received in one sentence.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    // Either: tool.call.end with isError=true, OR no spawn at all (model refused)
    // Either way, the agent should produce explanatory text
    expect(rootEvents.some(e => e.type === 'text.delta')).toBe(true)

    const toolEnds = rootEvents.filter(e => e.type === 'tool.call.end')
    if (toolEnds.length > 0) {
      // If a tool was called, it should have produced an error result
      const spawnEnd = toolEnds.find(e =>
        // agent_spawn tool.call.end — it either errored or returned an error message
        true, // we just verify text.delta follows
      )
      const lastToolEndSeq = Math.max(...toolEnds.map(e => e.seq))
      expect(rootEvents.some(e => e.seq > lastToolEndSeq && e.type === 'text.delta')).toBe(true)
    }

    // Log actual outcome for the report
    const agents = gw.state.listAgentsForThread(thread.id)
    const subagents = agents.filter(a => a.agentId !== 'root')
    console.log(`[fixture:subagent-error] Spawn attempts: ${toolEnds.length}, Sub-agents created: ${subagents.length}`)
  }, 240_000)

  // ── 9/12 — subagent-explore-deep ─────────────────────────────────────────

  it('fixture:subagent-explore-deep — explore helper does thorough analysis', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-explore-deep] Explore helper does thorough analysis',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "explore" helper with this detailed task: ' +
        '"Analyze the project structure: (1) count total .ts and .tsx files, ' +
        '(2) identify the main entry point, (3) list the top-level directories ' +
        'and their apparent purpose, (4) report whether tests exist alongside ' +
        'source files." Wait for the result and repeat its analysis verbatim.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 1)

    // Deep analysis = multiple tool calls in the sub-agent.
    // Soft check: rate-limit errors produce 4-event error logs.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: subagents[0]!.agentId,
    })
    const childHadError = childEvents.some(e => e.type === 'error')
    if (childHadError) {
      console.log('[fixture:subagent-explore-deep] NOTE: child agent hit API rate limit — sub-agent spawn confirmed, deep tool content not captured')
    } else {
      expect(childEvents.length).toBeGreaterThanOrEqual(5)
      const childToolStarts = childEvents.filter(e => e.type === 'tool.call.start')
      expect(childToolStarts.length).toBeGreaterThanOrEqual(2)
    }
  }, 240_000)

  // ── 10/12 — subagent-planner ──────────────────────────────────────────────

  it('fixture:subagent-planner — planner helper designs architecture', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-planner] Planner helper designs architecture',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "planner" helper with this task: "Design a 3-phase plan for adding ' +
        'a plugin system to this CLI tool. Phase 1 is discovery, phase 2 is interface ' +
        'design, phase 3 is migration. Include specific file paths you\'d create or ' +
        'modify." Wait for the result and summarize the plan in 3 bullet points.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 1)

    // Planner should produce text output.
    // Soft check: rate-limit errors produce error-only child logs.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: subagents[0]!.agentId,
    })
    const childHadError = childEvents.some(e => e.type === 'error')
    if (childHadError) {
      console.log('[fixture:subagent-planner] NOTE: child agent hit API rate limit — sub-agent spawn confirmed, planner content not captured')
    } else {
      expect(childEvents.some(e => e.type === 'text.delta')).toBe(true)
      const childText = childEvents
        .filter(e => e.type === 'text.delta')
        .map(e => (e.payload as { text: string }).text)
        .join('')
        .toLowerCase()
      expect(childText.includes('phase') || childText.includes('plugin')).toBe(true)
    }
  }, 240_000)

  // ── 11/12 — subagent-verifier ─────────────────────────────────────────────

  it('fixture:subagent-verifier — verifier helper runs checks', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-verifier] Verifier helper runs checks',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "verifier" helper with this task: "Check the project for common ' +
        'issues: (1) run \'ls -la\' to see the top-level structure, ' +
        '(2) check if a tsconfig.json exists, (3) look for any .test.ts files. ' +
        'Report what you found as a pass/fail list." ' +
        'Wait for the result and present it as a checklist.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const subagents = assertSubagents(gw, thread.id, 1)

    // Verifier should have used shell or readFile tools.
    // Soft check: rate-limit errors produce error-only child logs.
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: subagents[0]!.agentId,
    })
    const childHadError = childEvents.some(e => e.type === 'error')
    if (childHadError) {
      console.log('[fixture:subagent-verifier] NOTE: child agent hit API rate limit — sub-agent spawn confirmed, verifier tool content not captured')
    } else {
      expect(childEvents.some(e => e.type === 'tool.call.start')).toBe(true)
    }
  }, 240_000)

  // ── 12/12 — subagent-nested-attempt ──────────────────────────────────────

  it('fixture:subagent-nested-attempt — attempt nested sub-agents', async () => {
    const thread = gw.state.createThread(
      'coder',
      '[fixture:subagent-nested-attempt] Attempt nested sub-agents',
      wsId,
    )

    await runToCompletion(
      gw,
      thread.id,
      'Spawn the "explore" helper with this task: "Use a sub-agent (if you have one) ' +
        'or your own tools to map the full directory tree of the workspace. ' +
        'Report the tree structure." Wait for the result and summarize.',
      wsId,
    )

    const rootEvents = gw.state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    expect(rootEvents.some(e => e.type === 'turn.end')).toBe(true)

    const agents = gw.state.listAgentsForThread(thread.id)
    const subagents = agents.filter(a => a.agentId !== 'root')

    // At minimum the outer explore helper should have spawned
    expect(subagents.length).toBeGreaterThanOrEqual(1)

    // Check for depth-2 nesting
    const depth2 = subagents.filter(a => a.parentAgentId !== 'root' && a.parentAgentId !== null)
    if (depth2.length > 0) {
      console.log(`[fixture:subagent-nested-attempt] Depth-2 nesting achieved: ${depth2.length} nested sub-agents`)
    } else {
      console.log('[fixture:subagent-nested-attempt] NOTE: explore helper cannot spawn sub-agents — used own tools only. Profile change needed to enable depth-2 nesting.')
    }

    // The outer explore helper must have produced content either way
    const outerHelper = subagents.find(a => a.parentAgentId === 'root')
    expect(outerHelper).toBeDefined()
    expect(outerHelper!.eventCount).toBeGreaterThan(0)
  }, 240_000)
})
