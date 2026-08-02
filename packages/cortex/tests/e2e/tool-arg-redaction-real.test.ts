/**
 * E2E — tool-argument redaction against a REAL provider event stream.
 *
 * The unit + wiring tests for this feature build `LoomEvent` objects by
 * hand. That leaves one risk they structurally cannot cover: if real
 * events don't have the shape the fixtures assume — if arguments arrive
 * only as `args_delta` and never as `tool.call.start.input`, or under a
 * field name nobody checked — every one of those tests passes while
 * production leaks.
 *
 * So this test takes a real model, gets it to put a credential-shaped
 * string into a real tool call, and pushes the resulting event stream
 * through the ACTUAL production write paths (`EventIngestor` against a
 * real SQLite DB, and `SessionRunner.accumulateEvent`). It then asserts
 * the key appears in neither store.
 *
 * Cost: one Haiku 4.5 turn via OpenRouter, ~$0.001.
 * Run: bunx vitest run tests/e2e/tool-arg-redaction-real.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { CortexDatabase } from '../../src/gateway/db/database.js'
import { EventBus, ROOT_AGENT_ID } from '../../src/gateway/event-bus.js'
import { EventIngestor } from '../../src/gateway/event-ingestor.js'
import { createSqliteCoreRepositoriesFromDatabase } from '../../src/storage/sqlite-core-repositories.js'
import {
  SessionRunner,
  createAccumulator,
} from '../../src/gateway/session-runner.js'
import type { ThreadMessage } from '../../src/gateway/types.js'
import { createTempProfile } from '../helpers/fixtures.js'

// A well-formed Anthropic key SHAPE that was never issued. It exists to
// be matched by a regex, and is never sent as a credential.
const CANARY = 'sk-ant-api03-' + 'z'.repeat(24)

const apiKey =
  process.env['OPENROUTER_API_KEY'] &&
  !process.env['OPENROUTER_API_KEY'].includes('OWNWARE_TEST_DUMMY')
    ? process.env['OPENROUTER_API_KEY']
    : undefined

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

describe.skipIf(!apiKey)('tool-argument redaction — real provider stream', () => {
  it('never persists a credential the model passed into a tool', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'e2e-redaction',
        model: 'openrouter:haiku-4.5',
        tools: { preset: 'none', mcp: {} },
        context: {
          cwd: false,
          datetime: false,
          git: false,
          os: false,
          project: false,
        },
      }),
    })
    cleanups.push(cleanup)

    const tempDir = await mkdtemp(join(tmpdir(), 'cortex-redact-e2e-'))
    cleanups.push(() => rm(tempDir, { recursive: true, force: true }))

    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    // One tool, one obvious argument to put the canary in. Declared here
    // rather than using a builtin so the test never touches a shell.
    const echoTool = {
      name: 'record_note',
      description: 'Record a note verbatim.',
      category: 'other' as const,
      inputSchema: {
        type: 'object' as const,
        properties: {
          note: { type: 'string' as const, description: 'The exact text to record' },
        },
        required: ['note'],
      },
      execute: async () => 'recorded',
    }

    const session = new Session({
      config: { ...assembled.config, maxTokens: 1024 },
      provider: assembled.provider,
      tools: [echoTool as never],
    })
    cleanups.push(async () => {
      try { session.abort() } catch { /* already finished */ }
    })

    const events: LoomEvent[] = []
    const gen = session.submitMessage(
      `Call the record_note tool exactly once. Set its "note" argument to ` +
        `this literal string, copied character for character with nothing ` +
        `added or removed: ${CANARY}`,
    )
    for (let next = await gen.next(); !next.done; next = await gen.next()) {
      events.push(next.value)
    }

    // Precondition. If the model declined to call the tool there is
    // nothing to redact and a green assertion would be meaningless —
    // fail loudly instead of passing vacuously.
    // Reassemble the tool ARGUMENTS the way a consumer does, per
    // toolCallId, and look for the canary there.
    //
    // A flat `JSON.stringify(events).includes(CANARY)` looks equivalent
    // and is NOT: real providers split `args_delta` across arbitrary
    // boundaries, so the canary never appears contiguously in the raw
    // stream. That check only ever passed because the model ALSO
    // repeated the key in its prose — i.e. it was passing on the
    // strength of a DIFFERENT leak surface than the one under test.
    const argsByCall = new Map<string, string>()
    for (const ev of events) {
      if (ev.type === 'tool.call.start') {
        const e = ev as unknown as { toolCallId: string; input: unknown }
        argsByCall.set(e.toolCallId, JSON.stringify(e.input ?? {}))
      }
      if (ev.type === 'tool.call.args_delta') {
        const e = ev as unknown as { toolCallId: string; delta: string }
        argsByCall.set(e.toolCallId, (argsByCall.get(e.toolCallId) ?? '') + e.delta)
      }
    }
    const reassembledArgs = [...argsByCall.values()].join('\n')
    expect(
      reassembledArgs.includes(CANARY),
      'model did not put the canary into a tool argument — test proves ' +
        'nothing; re-run or adjust the prompt',
    ).toBe(true)

    // ── Store 1: agent_events + the live bus ────────────────────────
    const db = new CortexDatabase(join(tempDir, 'cortex.db'))
    cleanups.push(async () => db.close())
    const bus = new EventBus()
    const ingestor = new EventIngestor(
      createSqliteCoreRepositoriesFromDatabase(db).events,
      bus,
    )
    const threadId = db.createThread('e2e-redaction', 'redaction').id

    const live: LoomEvent[] = []
    bus.subscribe(threadId, ROOT_AGENT_ID, e => live.push(e.event))
    for (const event of events) await ingestor.ingestParentEvent(threadId, event)

    const stored = db.listAgentEvents({ threadId, agentId: ROOT_AGENT_ID })
    expect(stored.length).toBeGreaterThan(0)

    // Scoped to tool-call rows on purpose. Two things this does NOT claim:
    //
    //  - It does not claim `agent_events` is canary-free overall. The
    //    model often repeats the value in its own prose, and `text.delta`
    //    / `text.complete` are NOT redacted — assistant text is a
    //    different leak surface from tool arguments, tracked as B-39.
    //  - It does not claim streamed fragments are individually clean of
    //    a REASSEMBLED secret. Real providers split on arbitrary
    //    boundaries (`{"note": "sk-` / `ant-api03-zzzzz` / …), so no
    //    single chunk matches a pattern and concatenating the rows back
    //    together recovers the value. That residual is B-40; the durable
    //    `messages` store below is unaffected because it redacts the
    //    reassembled object.
    const toolRows = stored.filter(r => r.type.startsWith('tool.call.'))
    expect(toolRows.length).toBeGreaterThan(0)
    for (const row of toolRows) {
      expect(JSON.stringify(row)).not.toContain(CANARY)
    }
    for (const event of live.filter(e => e.type.startsWith('tool.call.'))) {
      expect(JSON.stringify(event)).not.toContain(CANARY)
    }

    // ── Store 2: messages (durable forever) ─────────────────────────
    const runner = new SessionRunner({} as never)
    const acc = createAccumulator()
    const saved: ThreadMessage[] = []
    let n = 0
    const accumulate = (
      runner as unknown as {
        accumulateEvent: (
          e: LoomEvent,
          enriched: LoomEvent,
          acc: ReturnType<typeof createAccumulator>,
          run: unknown,
          save: (m: ThreadMessage) => Promise<void>,
          genId: () => string,
        ) => Promise<void>
      }
    ).accumulateEvent.bind(runner)

    const run = {
      status: 'running',
      lastSeq: 0,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      threadId,
    }
    for (const event of events) {
      await accumulate(
        event,
        event,
        acc,
        run,
        async m => { saved.push(m) },
        () => `msg_${++n}`,
      )
    }

    expect(saved.length).toBeGreaterThan(0)

    // THE headline guarantee. `messages` is the store retention never
    // prunes and that `/hydrate`, `/messages` and `/data/export` serve.
    // Scoped to the tool records for the same reason as above — the
    // assistant's prose is B-39, not this fix.
    const toolRecords = saved.flatMap(m => m.tools ?? [])
    expect(toolRecords.length).toBeGreaterThan(0)
    expect(JSON.stringify(toolRecords)).not.toContain(CANARY)

    // And the redaction is VISIBLE, not an absence caused by the
    // arguments having been dropped altogether — that distinction is the
    // difference between a working guard and a broken reassembly.
    expect(JSON.stringify(toolRecords)).toContain('[REDACTED:')
  }, 120_000)
})
