/**
 * S1 gap-closers, proven over the REAL wire with a deterministic
 * scripted session (the pattern cortex's own permission contracts use —
 * a scripted engine session injected into a real gateway, so SSE, the exact
 * permission-decision route, cancellation, and `since=` replay are all
 * the genuine article; only the model is scripted).
 *
 *   1. Approval card round-trip: card renders from sanitized wire truth,
 *      'y' posts the EXACT decision route (operationHash), run proceeds;
 *      deny path renders the strikethrough decision row.
 *   2. Esc-mid-run: ESC on the key channel → cancel(runId) over the wire
 *      → run terminates as interrupted, stream ends, no hang.
 *   3. Reconnect: drop the SSE at the permission pause, re-subscribe with
 *      `since=cursor` through the CLI's streamRun — the card shows ONCE,
 *      nothing before the cursor is replayed, the run completes.
 *
 * Isolation: temp profilesDir AND dataDir (guardrail #4).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OwnwareClient } from '@ownware/client'
import { OwnwareGateway } from '@ownware/cortex'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { TranscriptRenderer } from '../../render.js'
import { PLAIN_STYLE } from '../../style.js'
import { streamRun, KEY_ESC, type KeyChannel } from '../../stream-run.js'

// ── scripted sessions (the "model") ──────────────────────────────────

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  model: 'test',
  costUsd: 0,
} as const

/** Asks one permission, then narrates the outcome and ends the turn. */
class PermissionSession {
  readonly sessionId = 'cli-permission-flow'
  private aborted = false

  constructor(
    private readonly hitl: HumanInTheLoop,
    private readonly requestId: string,
  ) {}

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() } as LoomEvent
    yield {
      type: 'permission.request',
      turnIndex: 0,
      requestId: this.requestId,
      toolName: 'send_email',
      input: { body: 'CANARY_NEVER_ON_THE_WIRE' },
      reason: 'Sending needs approval',
    } as LoomEvent
    const granted = await this.hitl.requestApproval({
      id: this.requestId,
      name: 'send_email',
      input: { body: 'CANARY_NEVER_ON_THE_WIRE' },
    })
    if (this.aborted) throw new Error('user')
    yield {
      type: 'permission.response',
      turnIndex: 0,
      requestId: this.requestId,
      granted,
    } as LoomEvent
    yield {
      type: 'text.delta',
      turnIndex: 0,
      text: granted ? 'Email sent.' : 'Skipped sending.',
    } as LoomEvent
    yield {
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: USAGE,
      timestamp: Date.now(),
    } as LoomEvent
    return undefined
  }

  abort(): void {
    this.aborted = true
    this.hitl.denyAll()
  }
}

/** Streams one delta, then works forever — until abort() interrupts it. */
class SlowSession {
  readonly sessionId = 'cli-slow-flow'
  private stop: (() => void) | null = null

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    yield { type: 'turn.start', turnIndex: 0, timestamp: Date.now() } as LoomEvent
    yield { type: 'text.delta', turnIndex: 0, text: 'Working on it...\n' } as LoomEvent
    await new Promise<void>((resolveStop) => {
      this.stop = resolveStop
    })
    throw new Error('user')
  }

  abort(): void {
    this.stop?.()
  }
}

class TestKeys implements KeyChannel {
  private handler: ((key: string) => void) | null = null
  capture(handler: (key: string) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  press(key: string): void {
    this.handler?.(key)
  }
}

// ── harness ──────────────────────────────────────────────────────────

let tempRoot: string
let gateway: OwnwareGateway
let baseUrl: string
let client: OwnwareClient

interface Sink {
  out: (s: string) => void
  text: () => string
  waitFor: (needle: string) => Promise<void>
}

function makeSink(): Sink {
  let buf = ''
  const waiters: Array<{ needle: string; resolveWait: () => void }> = []
  return {
    out: (s) => {
      buf += s
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (buf.includes(waiters[i]!.needle)) {
          waiters[i]!.resolveWait()
          waiters.splice(i, 1)
        }
      }
    },
    text: () => buf,
    waitFor: (needle) =>
      buf.includes(needle)
        ? Promise.resolve()
        : new Promise((resolveWait) => {
            waiters.push({ needle, resolveWait })
          }),
  }
}

async function startScriptedRun(session: Session, hitl: HumanInTheLoop, label: string) {
  const workspaceDir = join(tempRoot, label.replace(/[^a-z0-9]+/gi, '-'))
  mkdirSync(workspaceDir, { recursive: true })
  const workspace = await gateway.state.createWorkspace(workspaceDir, label)
  const thread = await gateway.state.createThread('test-agent', label, workspace.id)
  gateway.state.setSession(thread.id, session)
  gateway.state.setRuntime(thread.id, { session, hitl, zoneManager: null } as never)
  const run = await gateway.runStore.create({
    threadId: thread.id,
    workspaceId: workspace.id,
    profileId: 'test-agent',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  })
  const handle = gateway.runner.start({
    runId: run.runId,
    threadId: thread.id,
    profileId: 'test-agent',
    model: 'test:model',
    prompt: label,
    permissionPolicyRevision: 'a'.repeat(64),
  })
  return { threadId: thread.id, runId: run.runId, handle }
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'ownware-cli-gaps-'))
  const profilesDir = join(tempRoot, 'profiles')
  mkdirSync(join(profilesDir, 'test-agent'), { recursive: true })
  writeFileSync(
    join(profilesDir, 'test-agent', 'agent.json'),
    JSON.stringify({ name: 'test-agent', description: 'S1 gap tests' }),
  )
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir,
    dataDir: join(tempRoot, 'data'),
    tls: false,
  })
  await gateway.start()
  baseUrl = `http://127.0.0.1:${gateway.port}`
  client = new OwnwareClient({ baseUrl, token: gateway.token })
})

afterAll(async () => {
  await gateway.stop()
  rmSync(tempRoot, { recursive: true, force: true })
})

function makeDeps(sink: Sink, keys: KeyChannel | null, askLine?: (q: string) => Promise<string>) {
  return {
    client,
    renderer: new TranscriptRenderer({ style: PLAIN_STYLE, out: sink.out }),
    style: PLAIN_STYLE,
    out: sink.out,
    keys,
    askLine: askLine ?? (async () => ''),
  }
}

describe('S1 gaps over the real wire', () => {
  it('approval card → y → exact decision route → run proceeds approved', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {
      /* decision arrives via the HTTP decision route */
    })
    const session = new PermissionSession(hitl, 'perm_approve') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'approve flow')

    const sink = makeSink()
    const keys = new TestKeys()
    const streaming = streamRun(makeDeps(sink, keys), { streamId: runId, runId, threadId })
    await sink.waitFor('[y] approve')
    keys.press('y')
    await streaming
    await handle.done

    const transcript = sink.text()
    expect(transcript).toContain('Approval needed')
    expect(transcript).toContain('send_email — Tool requires explicit approval')
    expect(transcript).toContain('arguments withheld by the gateway')
    expect(transcript).toContain('✓ approved send_email')
    expect(transcript).toContain('Email sent.')
    // The raw input never reaches the wire, so it can never reach the terminal.
    expect(transcript).not.toContain('CANARY_NEVER_ON_THE_WIRE')

    const snapshot = await client.runSnapshot(runId)
    expect(snapshot).toMatchObject({ status: 'succeeded', terminal: true })
  }, 20_000)

  it('presentApproval (the pinned TUI card) owns presentation; the decision still posts the exact route', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {})
    const session = new PermissionSession(hitl, 'perm_pinned') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'pinned card flow')

    const sink = makeSink()
    const presented: string[] = []
    await streamRun(
      {
        ...makeDeps(sink, null),
        presentApproval: async (info) => {
          presented.push(`${info.toolName}|${info.reason}|${info.inputSummary ?? ''}`)
          return 'approve'
        },
      },
      { streamId: runId, runId, threadId },
    )
    await handle.done

    // The card was the TUI's job — nothing card-shaped in the transcript…
    expect(sink.text()).not.toContain('Approval needed')
    // …but the presenter got the sanitized wire truth…
    expect(presented).toHaveLength(1)
    expect(presented[0]).toContain('send_email|Tool requires explicit approval')
    // …and the decision round-tripped: run proceeded approved.
    expect(sink.text()).toContain('✓ approved send_email')
    expect(sink.text()).toContain('Email sent.')
    const snapshot = await client.runSnapshot(runId)
    expect(snapshot).toMatchObject({ status: 'succeeded', terminal: true })
  }, 20_000)

  it("presentApproval 'always-tool' grants via resume and the run proceeds", async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {})
    const session = new PermissionSession(hitl, 'perm_always') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'always flow')

    const sink = makeSink()
    await streamRun(
      {
        ...makeDeps(sink, null),
        presentApproval: async () => 'always-tool' as const,
      },
      { streamId: runId, runId, threadId },
    )
    await handle.done

    const transcript = sink.text()
    expect(transcript).toContain('✓ allowed send_email · always for this tool')
    expect(transcript).toContain('Email sent.')
    const snapshot = await client.runSnapshot(runId)
    expect(snapshot).toMatchObject({ status: 'succeeded', terminal: true })
  }, 20_000)

  it('deny via the non-TTY line fallback renders the strikethrough decision row', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {})
    const session = new PermissionSession(hitl, 'perm_deny') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'deny flow')

    const sink = makeSink()
    const questions: string[] = []
    await streamRun(
      makeDeps(sink, null, async (q) => {
        questions.push(q)
        return 'n'
      }),
      { streamId: runId, runId, threadId },
    )
    await handle.done

    const transcript = sink.text()
    expect(questions).toEqual(['  approve? (y/n) '])
    expect(transcript).toContain('● send_email denied')
    expect(transcript).toContain('Skipped sending.')
    expect(transcript).not.toContain('✖')
  }, 20_000)

  it('esc mid-run cancels over the wire and the stream ends interrupted', async () => {
    const session = new SlowSession() as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, new HumanInTheLoop({ timeoutMs: 15_000 }), 'cancel flow')

    const sink = makeSink()
    const keys = new TestKeys()
    const streaming = streamRun(makeDeps(sink, keys), { streamId: runId, runId, threadId })
    await sink.waitFor('Working on it...')
    keys.press(KEY_ESC)
    await streaming
    await handle.done

    const transcript = sink.text()
    expect(transcript).toContain('⎋ cancelling...')
    expect(transcript).toContain('⎋ run')
    const snapshot = await client.runSnapshot(runId)
    expect(snapshot.terminal).toBe(true)
    expect(snapshot.status).not.toBe('succeeded')
  }, 20_000)

  it('agentEventHistory returns the recorded event log over the wire (S3)', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {})
    const session = new PermissionSession(hitl, 'perm_history') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'history flow')
    const sink = makeSink()
    await streamRun(
      { ...makeDeps(sink, null), presentApproval: async () => 'approve' as const },
      { streamId: runId, runId, threadId },
    )
    await handle.done

    const history = await client.agentEventHistory(threadId, 'root')
    const types = history.map((e) => e.type)
    expect(types).toContain('turn.start')
    expect(types).toContain('permission.request')
    expect(types).toContain('turn.end')
    // The stored permission.request is the sanitized projection.
    expect(JSON.stringify(history)).not.toContain('CANARY_NEVER_ON_THE_WIRE')
  }, 20_000)

  it('drop at the permission pause, reconnect with since=cursor: one card, no replayed history', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 15_000 })
    hitl.onApprovalNeeded(() => {})
    const session = new PermissionSession(hitl, 'perm_reconnect') as unknown as Session
    const { threadId, runId, handle } = await startScriptedRun(session, hitl, 'reconnect flow')

    // First subscriber sees the pause, then the connection drops.
    let cursor = 0
    const firstAbort = new AbortController()
    for await (const ev of client.events(runId, { signal: firstAbort.signal })) {
      if (ev.type === 'permission.request') {
        cursor = ev.seq
        break
      }
    }
    firstAbort.abort()
    expect(cursor).toBeGreaterThan(0)

    // The CLI reconnects from the cursor — exactly what --resume does
    // mid-run. The card must render ONCE (from the pause onward), with
    // no earlier events replayed.
    const sink = makeSink()
    const keys = new TestKeys()
    const streaming = streamRun(makeDeps(sink, keys), {
      streamId: runId,
      runId,
      threadId,
      since: cursor - 1,
    })
    await sink.waitFor('[y] approve')
    keys.press('y')
    await streaming
    await handle.done

    const transcript = sink.text()
    expect(transcript.match(/Approval needed/g)).toHaveLength(1)
    expect(transcript).toContain('Email sent.')
    const snapshot = await client.runSnapshot(runId)
    expect(snapshot).toMatchObject({ status: 'succeeded', terminal: true })
  }, 20_000)
})
