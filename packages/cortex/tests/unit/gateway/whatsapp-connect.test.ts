/**
 * connect_whatsapp (CC3) — the BYO procedure end to end through the real
 * engine: live credential probes, the consent gate, the two-step webhook
 * registration, coexistence honesty, transient-vs-permanent Meta failures,
 * and the no-secrets-persisted guarantee.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { ChannelJobStore } from '../../../src/gateway/channel-job-store.js'
import { ChannelJobWorker } from '../../../src/gateway/channel-job-worker.js'
import { ChannelProcedureRegistry, gateStepId } from '../../../src/gateway/channel-procedures.js'
import {
  CONNECT_WHATSAPP_OPERATION,
  createWhatsAppConnectProcedure,
} from '../../../src/gateway/whatsapp-connect.js'
import type { ChannelCredentialResolver } from '../../../src/gateway/channel-credentials.js'

const GATE_ID = gateStepId(CONNECT_WHATSAPP_OPERATION, 'approve_connect')
const ACCESS_TOKEN = 'EAAB-secret-token-value'
const CREDENTIALS: Record<string, Record<string, string>> = {
  'whatsapp-rosa': {
    accessToken: ACCESS_TOKEN,
    phoneNumberId: 'PID123',
    wabaId: 'WABA9',
    verifyToken: 'VER1',
    appSecret: 'sekret',
    verificationPin: '493827',
  },
}

const resolver: ChannelCredentialResolver = {
  resolve: async (channelId) => CREDENTIALS[channelId] ?? null,
}

interface GraphCall {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown> | null
  readonly auth: string | null
}

function fakeGraph(
  calls: GraphCall[],
  failures: Map<string, { status: number; code: number }> = new Map(),
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname.replace(/^\/v24\.0/, '')
    const headers = new Headers(init?.headers)
    calls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      auth: headers.get('authorization'),
    })
    const failure = failures.get(`${init?.method ?? 'GET'} ${path}`)
    if (failure) {
      return new Response(
        JSON.stringify({ error: { code: failure.code, message: `meta error ${failure.code}` } }),
        { status: failure.status, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if ((init?.method ?? 'GET') === 'GET' && path === '/PID123') {
      return json({
        display_phone_number: '+61 400 555 210',
        verified_name: 'Northside Plumbing',
        code_verification_status: 'NOT_VERIFIED',
        quality_rating: 'GREEN',
        name_status: 'APPROVED',
      })
    }
    return json({ success: true, data: [] })
  }) as unknown as typeof fetch
}

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('connect_whatsapp procedure', () => {
  let dir: string
  let database: CortexDatabase
  let store: ChannelJobStore
  let calls: GraphCall[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'whatsapp-connect-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new ChannelJobStore(database.rawMainHandle)
    calls = []
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  function buildWorker(
    failures?: Map<string, { status: number; code: number }>,
    publicBaseUrl: string | null = 'https://hooks.example.test',
  ): ChannelJobWorker {
    const registry = new ChannelProcedureRegistry()
    registry.register(createWhatsAppConnectProcedure({
      credentials: resolver,
      ...(publicBaseUrl !== null ? { publicBaseUrl } : {}),
      fetch: fakeGraph(calls, failures),
    }))
    return new ChannelJobWorker(store, registry, { workerId: 'test' })
  }

  function enqueue(coexistence = false, profileId = 'rosa'): string {
    return store.enqueue({
      profileId,
      operation: CONNECT_WHATSAPP_OPERATION,
      channelKind: 'whatsapp',
      channelId: 'whatsapp-rosa',
      params: { channelId: 'whatsapp-rosa', coexistence },
      stepCount: 5,
    }, 100).jobId
  }

  it('probes, gates with the real number, registers the webhook two-step, and receipts honestly', async () => {
    const worker = buildWorker()
    const jobId = enqueue()

    await worker.runOne(200)
    const parked = store.get(jobId)!
    expect(parked.state).toBe('waiting_for_input')
    expect(parked.gate).toMatchObject({
      id: GATE_ID,
      title: 'Connect +61 400 555 210 to rosa?',
      onDecline: 'No WhatsApp yet. Nothing else changes.',
    })
    // The probe ran before the gate: phone info + template probe, authed.
    expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      'GET /PID123', 'GET /WABA9/message_templates',
    ])
    expect(calls[0]?.auth).toBe(`Bearer ${ACCESS_TOKEN}`)

    store.respondToGate(jobId, { gateId: GATE_ID, action: 'approve', actor: 'dev' }, 300)
    await worker.runOne(400)

    expect(store.get(jobId)).toMatchObject({ state: 'succeeded', outcomeCode: 'procedure_complete' })
    // Two-step webhook dance: plain subscribe FIRST, then the override.
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.path)).toEqual([
      '/WABA9/subscribed_apps', '/WABA9/subscribed_apps', '/PID123/register',
    ])
    expect(posts[0]?.body).toBeNull()
    expect(posts[1]?.body).toEqual({
      override_callback_uri: 'https://hooks.example.test/webhooks/whatsapp/whatsapp-rosa',
      verify_token: 'VER1',
    })
    expect(posts[2]?.body).toMatchObject({ messaging_product: 'whatsapp', pin: '493827' })

    expect(store.workLines(jobId).map((l) => l.title)).toEqual([
      'Checked the number', 'Webhook registered', 'Number registered',
      'WhatsApp connected — Not live',
    ])
    const receipts = store.receiptsForJob(jobId)
    expect(receipts.map((r) => r.kind)).toEqual(['gate_decision', 'connection'])
    expect(receipts[1]?.body).toMatchObject({
      displayPhoneNumber: '+61 400 555 210',
      coexistence: false,
      whatRemainedUnchanged:
        'Nothing reaches a real customer until you publish — that stays its own decision.',
    })
  })

  it('coexistence skips Cloud registration and says so', async () => {
    const worker = buildWorker()
    const jobId = enqueue(true, 'rosa-coex')
    await worker.runOne(200)
    store.respondToGate(jobId, { gateId: GATE_ID, action: 'approve', actor: 'dev' }, 300)
    await worker.runOne(400)

    expect(store.get(jobId)?.state).toBe('succeeded')
    expect(calls.some((c) => c.path === '/PID123/register')).toBe(false)
    expect(store.workLines(jobId).map((l) => l.title)).toContain('Registration skipped')
    const gate = store.receiptsForJob(jobId)[0]!
    expect(gate.body['scope']).toEqual(expect.arrayContaining([
      expect.stringContaining('WhatsApp Business app keeps working'),
    ]))
  })

  it('no secret value ever lands in job rows, work lines, or receipts', async () => {
    const worker = buildWorker()
    const jobId = enqueue()
    await worker.runOne(200)
    store.respondToGate(jobId, { gateId: GATE_ID, action: 'approve', actor: 'dev' }, 300)
    await worker.runOne(400)

    const db = database.rawMainHandle
    for (const table of ['channel_jobs', 'channel_job_work_lines', 'channel_receipts']) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
      const dump = JSON.stringify(rows)
      expect(dump).not.toContain(ACCESS_TOKEN)
      expect(dump).not.toContain('sekret')
      expect(dump).not.toContain('493827')
    }
  })

  it('fails fast and honestly without a public webhook URL', async () => {
    const worker = buildWorker(undefined, null)
    const jobId = enqueue()
    await worker.runOne(200)
    expect(store.get(jobId)).toMatchObject({
      state: 'failed',
      outcomeCode: 'webhook_public_url_missing',
    })
  })

  it('an invalid token is a permanent, typed failure', async () => {
    const worker = buildWorker(new Map([
      ['GET /PID123', { status: 401, code: 190 }],
    ]))
    const jobId = enqueue()
    await worker.runOne(200)
    expect(store.get(jobId)).toMatchObject({ state: 'failed', outcomeCode: 'meta_token_invalid' })
  })

  it('a Meta rate limit defers and succeeds on the retry', async () => {
    const failures = new Map([['POST /WABA9/subscribed_apps', { status: 400, code: 130429 }]])
    const worker = buildWorker(failures)
    const jobId = enqueue()
    await worker.runOne(200)
    store.respondToGate(jobId, { gateId: GATE_ID, action: 'approve', actor: 'dev' }, 300)

    await worker.runOne(400)
    expect(store.get(jobId)).toMatchObject({ state: 'waiting_for_retry', attempt: 1 })

    failures.clear() // the rate limit lifted
    await worker.runOne(10_000)
    expect(store.get(jobId)).toMatchObject({ state: 'succeeded' })
  })

  it('an unknown channel id fails typed, not mysteriously', async () => {
    const worker = buildWorker()
    const jobId = store.enqueue({
      profileId: 'rosa',
      operation: CONNECT_WHATSAPP_OPERATION,
      channelKind: 'whatsapp',
      params: { channelId: 'nope' },
      stepCount: 5,
    }, 100).jobId
    await worker.runOne(200)
    expect(store.get(jobId)).toMatchObject({ state: 'failed', outcomeCode: 'channel_not_found' })
  })
})
