/**
 * connect_channel (CC3) — the tool front-end over the durable engine:
 * starts/attaches a job, streams work lines as ToolProgress, presents the
 * parked gate through ctx.requestPermission (the ONE pause mechanic), and
 * distinguishes decline (terminal, receipted) from abandonment (gate stays
 * parked — a timeout is never a decision).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { ChannelJobStore } from '../../../src/gateway/channel-job-store.js'
import { ChannelJobWorker } from '../../../src/gateway/channel-job-worker.js'
import {
  ChannelProcedureRegistry,
  gateStepId,
  type ChannelProcedure,
} from '../../../src/gateway/channel-procedures.js'
import {
  ChannelConnectToolProvider,
  createConnectChannelTool,
} from '../../../src/gateway/channel-connect-tool.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import type { Tool, ToolContext, ToolProgress, ToolResult } from '@ownware/loom'

const GATE_ID = gateStepId('connect_demo', 'approve_connect')

const demoProcedure: ChannelProcedure = {
  operation: 'connect_demo',
  channelKind: 'whatsapp',
  steps: [
    {
      kind: 'work',
      name: 'check',
      run: async (ctx): Promise<void> => {
        ctx.workLine('Checked the number', 'it can link')
      },
    },
    {
      kind: 'gate',
      name: 'approve_connect',
      gate: () => ({
        id: GATE_ID,
        title: 'Connect 0400 555 210 to Rosa?',
        included: ['Customers reach Rosa — once you publish, not before'],
        excluded: ['She never messages anyone first'],
        onDecline: 'No WhatsApp yet. Nothing else changes.',
      }),
    },
    {
      kind: 'work',
      name: 'finish',
      run: async (ctx): Promise<void> => {
        ctx.workLine('Number connected')
        ctx.receipt({
          kind: 'connection',
          title: 'WhatsApp connected — Not live',
          body: {},
        })
      },
    },
  ],
}

function fakeCtx(opts: {
  decide?: (action: string, detail: string) => Promise<boolean>
  signal?: AbortSignal
}): ToolContext {
  return {
    cwd: '/tmp',
    signal: opts.signal ?? new AbortController().signal,
    sessionId: 's1',
    requestPermission: opts.decide ?? (async () => true),
  } as unknown as ToolContext
}

async function drive(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ progress: string[]; result: ToolResult }> {
  const progress: string[] = []
  const gen = tool.execute(input, ctx) as AsyncGenerator<ToolProgress, ToolResult>
  for (;;) {
    const next = await gen.next()
    if (next.done) return { progress, result: next.value }
    progress.push(next.value.message)
  }
}

describe('connect_channel tool', () => {
  let dir: string
  let database: CortexDatabase
  let store: ChannelJobStore
  let registry: ChannelProcedureRegistry
  let worker: ChannelJobWorker
  let tool: Tool

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'channel-connect-tool-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new ChannelJobStore(database.rawMainHandle)
    registry = new ChannelProcedureRegistry()
    registry.register(demoProcedure)
    worker = new ChannelJobWorker(store, registry, { workerId: 'tool-test' })
    worker.start()
    tool = createConnectChannelTool({
      jobs: store,
      procedures: registry,
      wake: () => worker.wake(),
      profileId: 'rosa',
    })
  })

  afterEach(async () => {
    await worker.stop()
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('runs the whole procedure: work lines stream, the gate rides requestPermission, receipts summarize', async () => {
    const decisions: Array<{ action: string; detail: string }> = []
    const ctx = fakeCtx({
      decide: async (action, detail) => {
        decisions.push({ action, detail })
        return true
      },
    })

    const { progress, result } = await drive(tool, { channel: 'demo', channelId: 'ch-1' }, ctx)

    expect(result.isError).toBe(false)
    expect(result.content).toContain('NOT live')
    expect(result.content).toContain('✓ WhatsApp connected — Not live')
    expect(progress).toEqual([
      'Starting the connection',
      'Checked the number — it can link',
      'Number connected',
    ])
    // The gate was the EXISTING pause mechanic, scope and exclusions included.
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.action).toBe('Connect 0400 555 210 to Rosa?')
    expect(decisions[0]?.detail).toContain('✓ Customers reach Rosa')
    expect(decisions[0]?.detail).toContain('— She never messages anyone first')
    expect(decisions[0]?.detail).toContain('If you decline:')

    const job = store.listForProfile('rosa')[0]!
    expect(job).toMatchObject({ state: 'succeeded', outcomeCode: 'procedure_complete' })
    expect(store.receiptsForJob(job.jobId).map((r) => r.kind)).toEqual([
      'gate_decision', 'connection',
    ])
  })

  it('an explicit "no" declines: terminal, receipted, nothing changed', async () => {
    const ctx = fakeCtx({ decide: async () => false })
    const { result } = await drive(tool, { channel: 'demo', channelId: 'ch-1' }, ctx)

    expect(result.isError).toBe(false)
    expect(result.content).toContain('declined — nothing was changed')
    const job = store.listForProfile('rosa')[0]!
    expect(job).toMatchObject({ state: 'cancelled', outcomeCode: 'gate_declined' })
    expect(store.receiptsForJob(job.jobId)[0]?.body).toMatchObject({
      whatRemainedUnchanged: 'No WhatsApp yet. Nothing else changes.',
    })
  })

  it('abandonment is not a decision: an aborted session leaves the gate parked', async () => {
    const abort = new AbortController()
    const ctx = fakeCtx({
      decide: async () => {
        abort.abort() // the run dies while the gate is open
        return false
      },
      signal: abort.signal,
    })
    const { result } = await drive(tool, { channel: 'demo', channelId: 'ch-1' }, ctx)

    expect(result.isError).toBe(false)
    expect(result.content).toContain('paused')
    expect(result.content).toContain('nothing was changed')
    const job = store.listForProfile('rosa')[0]!
    expect(job.state).toBe('waiting_for_input') // still presentable
    expect(store.receiptsForJob(job.jobId)).toHaveLength(0) // no decision invented
  })

  it('re-attaches to an in-flight job and re-presents the parked gate', async () => {
    // First invocation abandons at the gate.
    const abort = new AbortController()
    await drive(tool, { channel: 'demo', channelId: 'ch-1' }, fakeCtx({
      decide: async () => {
        abort.abort()
        return false
      },
      signal: abort.signal,
    }))

    // Second invocation — no channelId needed — resumes and approves.
    const { progress, result } = await drive(tool, { channel: 'demo' }, fakeCtx({}))
    expect(progress[0]).toBe('Resuming the connection already in progress')
    expect(result.isError).toBe(false)
    expect(store.listForProfile('rosa')[0]?.state).toBe('succeeded')
  })

  it('unknown channels and missing channelId fail with guidance, not mystery', async () => {
    const unknown = await drive(tool, { channel: 'imessage' }, fakeCtx({}))
    expect(unknown.result.isError).toBe(true)
    expect(unknown.result.content).toContain('No connect procedure')

    const missing = await drive(tool, { channel: 'demo' }, fakeCtx({}))
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content).toContain('no channelId')
  })

  it('the provider contributes the tool only when procedures are registered', async () => {
    const profile = { config: { name: 'rosa' } } as LoadedProfile
    const empty = new ChannelConnectToolProvider({
      jobs: store,
      procedures: new ChannelProcedureRegistry(),
      wake: () => {},
    })
    expect((await empty.getToolsForProfile(profile)).tools).toEqual([])

    const wired = new ChannelConnectToolProvider({
      jobs: store,
      procedures: registry,
      wake: () => {},
    })
    const contributed = (await wired.getToolsForProfile(profile)).tools
    expect(contributed.map((t) => t.name)).toEqual(['connect_channel'])
  })
})
