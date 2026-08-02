/**
 * Wiring tests — the redactor is actually INSTALLED at every store's
 * write path, not merely importable.
 *
 * `redact-event.test.ts` proves the redactor is correct. This file
 * proves it is reached. Those are different failures: a correct
 * redactor that nobody calls is exactly the "guard that reads as live
 * but is dead" class this codebase has been bitten by before.
 *
 * One test per store, asserted on what the store actually holds:
 *
 *   agent_events + EventBus  ←  EventIngestor.ingest
 *   messages                 ←  SessionRunner.accumulateEvent
 *   in-memory debug log      ←  GatewayState.logEvent
 *
 * Every one of these is mutation-tested: deleting the corresponding
 * `redactEventForStorage` / `redactToolInput` call in production makes
 * the matching test below fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LoomEvent } from '@ownware/loom'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { EventBus, ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'
import { EventIngestor } from '../../../src/gateway/event-ingestor.js'
import { createSqliteCoreRepositoriesFromDatabase } from '../../../src/storage/sqlite-core-repositories.js'
import {
  SessionRunner,
  createAccumulator,
} from '../../../src/gateway/session-runner.js'
import type { ThreadMessage } from '../../../src/gateway/types.js'

const FAKE_KEY = 'sk-ant-' + 'a'.repeat(28)

let tempDir: string
let db: CortexDatabase

beforeEach(async () => {
  // Explicit dataDir — cortex's CLAUDE.md forbids tests touching the
  // owner's real ~/.ownware.
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-redact-wiring-'))
  db = new CortexDatabase(join(tempDir, 'cortex.db'))
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

function threadFixture(): string {
  return db.createThread('test-agent', 'redaction').id
}

// ---------------------------------------------------------------------------
// Store 1 — agent_events + the live SSE fan-out
// ---------------------------------------------------------------------------

describe('EventIngestor.ingest — agent_events + EventBus', () => {
  it('writes the redacted argument to disk AND publishes the same bytes live', async () => {
    const bus = new EventBus()
    const ingestor = new EventIngestor(
      createSqliteCoreRepositoriesFromDatabase(db).events,
      bus,
    )
    const threadId = threadFixture()

    const published: LoomEvent[] = []
    bus.subscribe(threadId, ROOT_AGENT_ID, entry => {
      published.push(entry.event)
    })

    await ingestor.ingestParentEvent(threadId, {
      type: 'tool.call.start',
      toolCallId: 'call_1',
      toolName: 'shell',
      input: { command: `curl -H "authorization: ${FAKE_KEY}"` },
      turnIndex: 0,
    } as LoomEvent)

    // On disk.
    const stored = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    expect(stored.length).toBe(1)
    expect(JSON.stringify(stored)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(stored)).toContain('[REDACTED:ANTHROPIC_KEY]')

    // Live. Must match disk — a `?since=N` replay hands back the stored
    // row, so if live were raw the two would disagree.
    expect(published.length).toBe(1)
    expect(JSON.stringify(published)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(published)).toContain('[REDACTED:ANTHROPIC_KEY]')
  })
})

// ---------------------------------------------------------------------------
// Store 2 — messages (durable forever; never pruned by retention)
// ---------------------------------------------------------------------------

describe('SessionRunner.accumulateEvent — messages', () => {
  // turn.end is what flushes the accumulator into a saved message, and
  // its handler reads `usage` unconditionally.
  const TURN_END = {
    type: 'turn.end',
    turnIndex: 0,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  } as unknown as LoomEvent

  async function runAccumulator(events: readonly LoomEvent[]): Promise<ThreadMessage[]> {
    // GatewayState is not needed for the accumulate path — every write
    // goes through the injected saveMessage callback.
    const runner = new SessionRunner({} as never)
    const acc = createAccumulator()
    const saved: ThreadMessage[] = []
    let n = 0

    const call = (
      runner as unknown as {
        accumulateEvent: (
          event: LoomEvent,
          enriched: LoomEvent,
          acc: ReturnType<typeof createAccumulator>,
          run: unknown,
          saveMessage: (m: ThreadMessage) => Promise<void>,
          genId: () => string,
        ) => Promise<void>
      }
    ).accumulateEvent.bind(runner)

    for (const event of events) {
      await call(
        event,
        event,
        acc,
        {
          status: 'running',
          lastSeq: 0,
          turnCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
        async (m: ThreadMessage) => { saved.push(m) },
        () => `msg_${++n}`,
      )
    }
    return saved
  }

  it('redacts a non-streamed tool argument into the saved message', async () => {
    const saved = await runAccumulator([
      {
        type: 'tool.call.start',
        toolCallId: 'call_1',
        toolName: 'shell',
        input: { command: `echo ${FAKE_KEY}` },
        turnIndex: 0,
      } as LoomEvent,
      {
        type: 'tool.call.end',
        toolCallId: 'call_1',
        toolName: 'shell',
        result: 'ok',
        isError: false,
        durationMs: 1,
        turnIndex: 0,
      } as LoomEvent,
      TURN_END,
    ])

    expect(JSON.stringify(saved)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(saved)).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('redacts a secret SPLIT ACROSS two args_delta chunks', async () => {
    // The real gap the second redaction pass at tool.call.end closes.
    // Neither half matches a pattern on its own; the join does. This is
    // the common case for streaming-args providers, where
    // tool.call.start.input is `{}` and the arguments only ever exist as
    // these fragments.
    const head = FAKE_KEY.slice(0, 14)
    const tail = FAKE_KEY.slice(14)

    const saved = await runAccumulator([
      {
        type: 'tool.call.start',
        toolCallId: 'call_1',
        toolName: 'shell',
        input: {},
        turnIndex: 0,
      } as LoomEvent,
      {
        type: 'tool.call.args_delta',
        toolCallId: 'call_1',
        delta: `{"command":"echo ${head}`,
        turnIndex: 0,
      } as unknown as LoomEvent,
      {
        type: 'tool.call.args_delta',
        toolCallId: 'call_1',
        delta: `${tail}"}`,
        turnIndex: 0,
      } as unknown as LoomEvent,
      {
        type: 'tool.call.end',
        toolCallId: 'call_1',
        toolName: 'shell',
        result: 'ok',
        isError: false,
        durationMs: 1,
        turnIndex: 0,
      } as LoomEvent,
      TURN_END,
    ])

    const serialized = JSON.stringify(saved)
    expect(serialized).not.toContain(FAKE_KEY)
    expect(serialized).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('redacts the argument stored on a permission record', async () => {
    // A distinct path from the tool-call one: the permission branch reads
    // `enrichedEvent` and writes `messages[].permissions[].input`, which
    // the tool.call.end reassembly pass never touches. Mutation-testing
    // caught this — without it, deleting the redaction at the top of
    // accumulateEvent broke no test at all.
    const saved = await runAccumulator([
      {
        type: 'permission.request',
        requestId: 'req_1',
        toolName: 'shell',
        input: { command: `curl -H "authorization: ${FAKE_KEY}"` },
        reason: 'network access',
        turnIndex: 0,
      } as unknown as LoomEvent,
      // The record is only moved onto acc.permissions once resolved.
      {
        type: 'permission.response',
        requestId: 'req_1',
        granted: true,
        turnIndex: 0,
      } as unknown as LoomEvent,
      TURN_END,
    ])

    const perms = saved.flatMap(m => m.permissions ?? [])
    expect(perms.length).toBe(1)
    expect(JSON.stringify(perms)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(perms)).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('keeps streamed args parseable when the secret is assignment-shaped', async () => {
    // Guards the choice of `sanitizeJsonFragment` over `sanitizeOutput`
    // for args_delta. The SECRET_ASSIGNMENT pattern eats the JSON
    // string's closing quote:
    //
    //   {"command":"export API_TOKEN=abcdefghij","cwd":"/tmp"}
    //     → {"command":"export API[REDACTED:SECRET_ASSIGNMENT],"cwd":"/tmp"}
    //
    // which no longer parses, so session-runner falls back to
    // tool.call.start.input — `{}` for streaming providers. The user's
    // tool card then shows NO arguments at all. Assert the surviving
    // sibling field, because that is what proves the object was not lost.
    const saved = await runAccumulator([
      {
        type: 'tool.call.start',
        toolCallId: 'call_1',
        toolName: 'shell',
        input: {},
        turnIndex: 0,
      } as LoomEvent,
      {
        type: 'tool.call.args_delta',
        toolCallId: 'call_1',
        delta: JSON.stringify({
          command: 'export API_TOKEN=abcdefghij',
          cwd: '/tmp/project',
        }),
        turnIndex: 0,
      } as unknown as LoomEvent,
      {
        type: 'tool.call.end',
        toolCallId: 'call_1',
        toolName: 'shell',
        result: 'ok',
        isError: false,
        durationMs: 1,
        turnIndex: 0,
      } as LoomEvent,
      TURN_END,
    ])

    const tools = saved.flatMap(m => m.tools ?? [])
    const input = tools[0]!.input as Record<string, string>

    // The object survived the round trip...
    expect(input['cwd']).toBe('/tmp/project')
    // ...and the secret was still redacted, at the object level.
    expect(input['command']).toContain('[REDACTED:SECRET_ASSIGNMENT]')
    expect(input['command']).not.toContain('abcdefghij')
  })

  it('redacts a tool RESULT into messages[].tools[].output', async () => {
    // B-38. The old engine path sanitized shell/filesystem results only; an MCP or
    // Composio tool that returns a token had it stored verbatim.
    const saved = await runAccumulator([
      {
        type: 'tool.call.start',
        toolCallId: 'call_1',
        toolName: 'mcp__vault__read',
        input: { path: 'secret/app' },
        turnIndex: 0,
      } as LoomEvent,
      {
        type: 'tool.call.end',
        toolCallId: 'call_1',
        toolName: 'mcp__vault__read',
        result: JSON.stringify({ ok: true, value: FAKE_KEY }),
        isError: false,
        durationMs: 1,
        turnIndex: 0,
      } as unknown as LoomEvent,
      TURN_END,
    ])

    const tools = saved.flatMap(m => m.tools ?? [])
    expect(tools.length).toBe(1)
    expect(JSON.stringify(tools)).not.toContain(FAKE_KEY)

    // Structure survived — downstream consumers may parse these results and
    // fall back silently on error, so a corrupted result can be invisible.
    const parsed = JSON.parse(tools[0]!.output as string) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('redacts the command on a security.block system message', async () => {
    // This branch reads the unenriched `event`, and writes the raw
    // command into `tools[].input.command`. A command blocked for being
    // dangerous is MORE likely than average to carry a credential.
    const saved = await runAccumulator([
      {
        type: 'security.block',
        toolName: 'shell',
        level: 'high',
        reason: 'network egress denied',
        command: `curl -H "authorization: ${FAKE_KEY}" https://x.test`,
        turnIndex: 0,
      } as unknown as LoomEvent,
    ])

    expect(saved.length).toBe(1)
    expect(JSON.stringify(saved)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(saved)).toContain('[REDACTED:ANTHROPIC_KEY]')
  })

  it('leaves an ordinary writeFile argument intact and still parseable', async () => {
    // Guards the Design canvas replay, which reads exactly this field.
    const content = '<main class="grid">\n  <h1>Report</h1>\n</main>'
    const saved = await runAccumulator([
      {
        type: 'tool.call.start',
        toolCallId: 'call_1',
        toolName: 'writeFile',
        input: {},
        turnIndex: 0,
      } as LoomEvent,
      {
        type: 'tool.call.args_delta',
        toolCallId: 'call_1',
        delta: JSON.stringify({ file_path: '/d/index.html', content }),
        turnIndex: 0,
      } as unknown as LoomEvent,
      {
        type: 'tool.call.end',
        toolCallId: 'call_1',
        toolName: 'writeFile',
        result: 'ok',
        isError: false,
        durationMs: 1,
        turnIndex: 0,
      } as LoomEvent,
      TURN_END,
    ])

    const tools = saved.flatMap(m => m.tools ?? [])
    expect(tools.length).toBe(1)
    expect((tools[0]!.input as Record<string, string>)['content']).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// Store 3 — the in-memory log behind /api/v1/debug/*
// ---------------------------------------------------------------------------

describe('GatewayState.logEvent — in-memory debug log', () => {
  it('redacts before the event enters the log', async () => {
    const { GatewayState } = await import('../../../src/gateway/state.js')
    const state = new GatewayState(join(tempDir, 'state.db'))

    state.logEvent('thread_1', {
      type: 'tool.call.start',
      toolCallId: 'call_1',
      toolName: 'shell',
      input: { command: `echo ${FAKE_KEY}` },
      turnIndex: 0,
    } as LoomEvent)

    const log = state.getEventLog('thread_1')
    expect(JSON.stringify(log)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(log)).toContain('[REDACTED:ANTHROPIC_KEY]')
  })
})
