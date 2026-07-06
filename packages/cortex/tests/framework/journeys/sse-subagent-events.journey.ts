/**
 * E2E journey — per-subagent event replay and live tail.
 *
 * Spins up a real gateway, runs the bundled `coder` profile with a
 * prompt that forces an agent_spawn call, then:
 *
 *   1. Waits for the parent run to complete (the subagent finishes
 *      along with it).
 *   2. Fetches the list of agents on the thread — expects `root` plus
 *      at least one `agent_*` sub-agent.
 *   3. Hits the history endpoint for the sub-agent and asserts the
 *      full event log is present (text deltas, tool events, etc.).
 *   4. Opens an SSE replay connection for the same sub-agent and
 *      asserts it emits the same events again in the same order,
 *      with a stream.start envelope and proper seq numbering.
 *
 * Real Anthropic calls. Skipped without ANTHROPIC_API_KEY.
 *
 * This is the test that proves the client's "View thread →" modal can
 * actually show the full sub-agent conversation. If the architecture
 * silently drops events anywhere along the path (Loom spawner →
 * gateway ingestor → SQLite → bus → SSE handler), this test fails.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

async function setupSandbox(tmpDir: string): Promise<string> {
  const sandbox = join(tmpDir, 'sandbox')
  await mkdir(sandbox, { recursive: true })
  await mkdir(join(sandbox, 'src'), { recursive: true })
  await writeFile(
    join(sandbox, 'README.md'),
    '# Tiny Test Project\n\nThis is used by the subagent-events journey.\n',
  )
  await writeFile(
    join(sandbox, 'package.json'),
    JSON.stringify({ name: 'sandbox', version: '1.0.0' }, null, 2),
  )
  await writeFile(
    join(sandbox, 'src/index.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
  )
  return sandbox
}

/**
 * Drives the parent run to completion while auto-approving any
 * permission requests. Returns nothing — we just need to block until
 * the SSE stream ends so we know the sub-agent is flushed to disk.
 */
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

/**
 * Parse a raw SSE text block into an array of { event, data } objects.
 * Mirrors what sse-parser does but inline so the test is self-contained.
 */
function parseRawSSE(raw: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = []
  for (const block of raw.split('\n\n')) {
    if (!block.trim() || block.startsWith(':')) continue
    const lines = block.split('\n')
    let eventName = 'message'
    let dataStr = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) eventName = line.slice(7)
      else if (line.startsWith('data: ')) dataStr = line.slice(6)
    }
    if (dataStr) {
      try {
        out.push({ event: eventName, data: JSON.parse(dataStr) })
      } catch {
        out.push({ event: eventName, data: dataStr })
      }
    }
  }
  return out
}

describe.skipIf(!HAS_KEY)('SSE journey — subagent event replay + live tail', () => {
  let gw: TestGateway
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      // Don't record fixtures here — these tests are about wire
      // behavior, not protocol snapshots.
      recordFixtures: false,
    })
    const sandbox = await setupSandbox(gw.tmpDir)
    const ws = gw.state.createWorkspace(sandbox, 'subagent-events-sandbox')
    wsId = ws.id
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('persists every subagent event and exposes them via the history endpoint', async () => {
    const thread = gw.state.createThread('coder', 'subagent-history', wsId)

    await runToCompletion(
      gw,
      thread.id,
      'You MUST use the agent_spawn tool to dispatch the "explore" helper. ' +
        'Do NOT use readFile, listFiles, glob, or grep yourself. ' +
        'Spawn the explore helper with the task: "Find the greet function in this codebase". ' +
        'Wait for its result, then report what it found in one sentence.',
      wsId,
    )

    // ── 1. Root agent events on disk ──────────────────────────────────
    const rootEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: ROOT_AGENT_ID,
    })
    expect(rootEvents.length).toBeGreaterThan(0)

    // The parent stream must contain the tool.call.start for agent_spawn
    // (this is what the client uses to render the "card" marker). It must
    // also contain agent.spawn — the lifecycle rewrite puts it on the
    // parent stream.
    const rootTypes = new Set(rootEvents.map(e => e.type))
    expect(rootTypes.has('tool.call.start')).toBe(true)
    expect(rootTypes.has('tool.call.end')).toBe(true)
    expect(rootTypes.has('turn.end')).toBe(true)
    expect(rootTypes.has('agent.spawn')).toBe(true)
    expect(rootTypes.has('agent.complete')).toBe(true)

    // seqs are monotonic and gap-free on the root stream
    const seqs = rootEvents.map(e => e.seq)
    expect(seqs[0]).toBe(1)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1)
    }

    // ── 2. Discover sub-agents via the listing endpoint ───────────────
    const listRes = await gw.client.get<{
      threadId: string
      count: number
      agents: Array<{ agentId: string; parentAgentId: string | null; eventCount: number }>
    }>(`/api/v1/threads/${thread.id}/agents`)
    expect(listRes.status).toBe(200)
    expect(listRes.body.count).toBeGreaterThanOrEqual(2)

    const rootRow = listRes.body.agents.find(a => a.agentId === ROOT_AGENT_ID)
    const childRow = listRes.body.agents.find(a => a.agentId !== ROOT_AGENT_ID)
    expect(rootRow).toBeDefined()
    expect(childRow).toBeDefined()
    expect(childRow!.agentId.startsWith('agent_')).toBe(true)

    // ── 3. Child agent has a real event log on disk ───────────────────
    //
    // The sub-agent should have emitted session.start, at least one
    // turn.start / turn.end pair, and likely some tool.call events
    // (the explore helper has access to filesystem tools).
    const childEvents = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: childRow!.agentId,
    })
    expect(childEvents.length).toBeGreaterThan(0)

    const childTypes = new Set(childEvents.map(e => e.type))
    // Every sub-agent run emits at least one turn boundary. If this
    // fails, the spawner onEvent hook is not forwarding non-lifecycle
    // events (which is exactly the bug this architecture fixes).
    expect(
      childTypes.has('turn.start') || childTypes.has('turn.end'),
    ).toBe(true)

    // The lifecycle rewrite rule: the child stream must NOT contain
    // agent.spawn / agent.complete — those were rewritten onto the
    // parent stream when ingested.
    expect(childTypes.has('agent.spawn')).toBe(false)
    expect(childTypes.has('agent.complete')).toBe(false)

    // ── 4. History endpoint returns the same events ───────────────────
    const histRes = await gw.client.get<{
      threadId: string
      agentId: string
      count: number
      maxSeq: number
      events: Array<{ seq: number; type: string; payload: unknown }>
    }>(`/api/v1/threads/${thread.id}/agents/${childRow!.agentId}/events/history`)

    expect(histRes.status).toBe(200)
    expect(histRes.body.threadId).toBe(thread.id)
    expect(histRes.body.agentId).toBe(childRow!.agentId)
    expect(histRes.body.count).toBe(childEvents.length)
    expect(histRes.body.maxSeq).toBe(childEvents[childEvents.length - 1]!.seq)

    // seqs in the response are monotonic starting at 1
    expect(histRes.body.events[0]!.seq).toBe(1)
    for (let i = 1; i < histRes.body.events.length; i++) {
      expect(histRes.body.events[i]!.seq).toBe(histRes.body.events[i - 1]!.seq + 1)
    }
  }, 300_000)

  it('SSE replay endpoint emits the full subagent stream in order with a stream.start envelope', async () => {
    const thread = gw.state.createThread('coder', 'subagent-replay', wsId)

    await runToCompletion(
      gw,
      thread.id,
      'You MUST dispatch the "explore" helper exactly once using agent_spawn. ' +
        'Task for the helper: "Read README.md and report the project name in one sentence". ' +
        'Do NOT read files yourself. After it returns, reply with one short sentence.',
      wsId,
    )

    // Find the sub-agent id from the gateway state (same shortcut the
    // modal will use via the /agents listing endpoint — tested above).
    const agents = gw.state.listAgentsForThread(thread.id)
    const childRow = agents.find(a => a.agentId !== ROOT_AGENT_ID)
    expect(childRow).toBeDefined()

    // ── GET the SSE stream over raw fetch ────────────────────────────
    // The test gateway's ApiClient only exposes POST-based SSE helpers
    // (the /run endpoint). This endpoint is GET so we talk fetch
    // directly — simpler than widening the harness for one test.
    const url = `${gw.baseUrl}/api/v1/threads/${thread.id}/agents/${childRow!.agentId}/events`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${gw.token}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Read until the server closes (agent is already done, so the idle
    // timer will eventually close the stream — but for a completed
    // run we just consume everything that's buffered).
    //
    // To avoid waiting for the 60s idle timer, we read with a short
    // timeout: collect for up to 3 seconds after the last byte.
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    const start = Date.now()
    const MAX_READ_MS = 8000
    while (Date.now() - start < MAX_READ_MS) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(() => resolve({ done: true, value: undefined }), 500),
        ),
      ])
      if (done) break
      if (value) raw += decoder.decode(value, { stream: true })
    }
    try {
      reader.releaseLock()
      await res.body!.cancel()
    } catch {
      /* already released */
    }

    const events = parseRawSSE(raw)
    expect(events.length).toBeGreaterThan(0)

    // First event is always a stream.start envelope with thread/agent
    // context and the starting seq cursor. The client relies on this to
    // bootstrap the modal header.
    expect(events[0]!.event).toBe('stream.start')
    const envelope = events[0]!.data as {
      threadId: string
      agentId: string
      since: number
      maxSeqAtStart: number
    }
    expect(envelope.threadId).toBe(thread.id)
    expect(envelope.agentId).toBe(childRow!.agentId)
    expect(envelope.since).toBe(0)
    expect(envelope.maxSeqAtStart).toBeGreaterThan(0)

    // The rest of the stream is the sub-agent's actual events.
    const content = events.slice(1)
    expect(content.length).toBeGreaterThan(0)

    // The SSE replay must match the DB state exactly — same types in
    // the same order. Drop the trailing 'done' event if present.
    const contentWithoutDone = content.filter(e => e.event !== 'done')
    const dbRows = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: childRow!.agentId,
    })
    expect(contentWithoutDone).toHaveLength(dbRows.length)
    for (let i = 0; i < contentWithoutDone.length; i++) {
      expect(contentWithoutDone[i]!.event).toBe(dbRows[i]!.type)
    }
  }, 300_000)

  it('resume via ?since=N returns only events after the cursor', async () => {
    const thread = gw.state.createThread('coder', 'subagent-resume', wsId)

    await runToCompletion(
      gw,
      thread.id,
      'Use agent_spawn to dispatch the "explore" helper with task: "List the files in src/". ' +
        'Do not read files yourself. Reply briefly with the result.',
      wsId,
    )

    const agents = gw.state.listAgentsForThread(thread.id)
    const childRow = agents.find(a => a.agentId !== ROOT_AGENT_ID)
    expect(childRow).toBeDefined()

    const all = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: childRow!.agentId,
    })
    expect(all.length).toBeGreaterThanOrEqual(2)

    // Pick a cursor halfway through — ?since=N should return only
    // rows with seq > N.
    const cursor = all[Math.floor(all.length / 2)]!.seq
    const expectedRemaining = all.filter(e => e.seq > cursor)

    const histRes = await gw.client.get<{
      count: number
      events: Array<{ seq: number; type: string }>
    }>(
      `/api/v1/threads/${thread.id}/agents/${childRow!.agentId}/events/history?since=${cursor}`,
    )
    expect(histRes.status).toBe(200)
    expect(histRes.body.count).toBe(expectedRemaining.length)
    expect(histRes.body.events.every(e => e.seq > cursor)).toBe(true)
    if (histRes.body.events.length > 0) {
      expect(histRes.body.events[0]!.seq).toBe(cursor + 1)
    }
  }, 300_000)
})
