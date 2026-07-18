/**
 * ChannelWebhookHost (CC0) — webhook channels get an HTTP mount.
 *
 * Contract under test:
 *   - listener starts only when an enabled webhook channel exists; 404 unknown paths
 *   - Meta GET verification handshake (per-channel verifyToken)
 *   - Meta POST: signature verified FIRST on the raw body; a BAD signature is
 *     dropped with HTTP 200 (retry-storm lesson); a good one answers 200 fast
 *     and drives the agent async; the reply goes out via the Cloud API
 *   - re-delivered WAMIDs are deduped; wrong phone_number_id is dropped
 *   - Twilio POST: form parsed, signature enforced when publicBaseUrl is set,
 *     TwiML 200 response, reply out via the Twilio REST API
 *   - oversized payloads → 413; reload() picks up store changes
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { ChannelWebhookHost, filterWhatsAppInbound } from '../channels/webhook-host.js'
import { InMemoryChannelStore } from '../channels/store.js'
import type { ChannelConfig } from '../channels/config.js'
import type { WhatsAppWebhookBody } from '../whatsapp/message.js'
import { validateTwilioSignature } from '../sms/message.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

class MockGateway implements GatewayClient {
  readonly runs: RunInput[] = []
  private tid = 0
  private seq = 0
  async run(input: RunInput): Promise<{ threadId: string }> {
    this.runs.push(input)
    return { threadId: input.threadId ?? `t${++this.tid}` }
  }
  async *streamReply(_t: string, _o: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    yield { type: 'delta', text: 'ok', seq: ++this.seq }
    yield { type: 'done', seq: ++this.seq }
  }
}

function fakeProvider(record: Array<{ url: string; body: string }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    record.push({ url: String(url), body: String(init?.body ?? '') })
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }], sid: 'SM_OUT' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const WA_CHANNEL: ChannelConfig = {
  id: 'whatsapp-acme',
  channel: 'whatsapp',
  profileId: 'acme',
  credentials: {
    accessToken: 'TOK',
    phoneNumberId: 'PID',
    appSecret: 'sekret',
    verifyToken: 'VERIFY',
  },
  enabled: true,
}

const SMS_CHANNEL: ChannelConfig = {
  id: 'sms-acme',
  channel: 'sms',
  profileId: 'acme',
  credentials: { accountSid: 'AC1', authToken: 'twtoken', from: '+15550009999' },
  enabled: true,
}

const waBody = (from: string, text: string, wamid: string, phoneNumberId = 'PID'): WhatsAppWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: phoneNumberId },
            messages: [{ from, id: wamid, type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
})

function metaSign(raw: string, secret = 'sekret'): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(raw, 'utf-8')).digest('hex')}`
}

interface Harness {
  host: ChannelWebhookHost
  gateway: MockGateway
  outbound: Array<{ url: string; body: string }>
  base: string
  logs: string[]
}

let active: ChannelWebhookHost | null = null
afterEach(async () => {
  await active?.stop()
  active = null
})

async function startHost(
  configs: ChannelConfig[],
  opts: { publicBaseUrl?: string } = {},
): Promise<Harness> {
  const store = new InMemoryChannelStore()
  for (const c of configs) await store.put(c)
  const gateway = new MockGateway()
  const outbound: Array<{ url: string; body: string }> = []
  const logs: string[] = []
  const host = new ChannelWebhookHost(store, {
    gateway,
    fetch: fakeProvider(outbound),
    log: (l) => logs.push(l),
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
  })
  active = host
  const { port } = await host.start({ port: 0 })
  if (port == null) throw new Error('expected the host to listen')
  return { host, gateway, outbound, base: `http://127.0.0.1:${port}`, logs }
}

async function postWhatsApp(base: string, body: WhatsAppWebhookBody, sign = true): Promise<Response> {
  const raw = JSON.stringify(body)
  return fetch(`${base}/webhooks/whatsapp/whatsapp-acme`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sign ? { 'X-Hub-Signature-256': metaSign(raw) } : {}),
    },
    body: raw,
  })
}

describe('ChannelWebhookHost — lifecycle', () => {
  it('does not listen when no webhook channel exists', async () => {
    const store = new InMemoryChannelStore()
    await store.put({ ...WA_CHANNEL, channel: 'telegram', credentials: { token: 't' } })
    const host = new ChannelWebhookHost(store, { gateway: new MockGateway(), log: () => {} })
    active = host
    const { port, paths } = await host.start({ port: 0 })
    expect(port).toBeNull()
    expect(paths).toEqual([])
  })

  it('reload() picks up a newly added webhook channel and starts listening', async () => {
    const store = new InMemoryChannelStore()
    const host = new ChannelWebhookHost(store, {
      gateway: new MockGateway(),
      fetch: fakeProvider([]),
      log: () => {},
    })
    active = host
    expect((await host.start({ port: 0 })).port).toBeNull()
    await store.put(WA_CHANNEL)
    const { port, paths } = await host.reload()
    expect(port).not.toBeNull()
    expect(paths).toEqual(['/webhooks/whatsapp/whatsapp-acme'])
  })

  it('404s unknown paths and channel-kind mismatches; healthz is 200', async () => {
    const { base } = await startHost([WA_CHANNEL])
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await fetch(`${base}/webhooks/whatsapp/unknown-id`)).status).toBe(404)
    expect((await fetch(`${base}/webhooks/sms/whatsapp-acme`, { method: 'POST', body: '' })).status).toBe(404)
  })
})

describe('ChannelWebhookHost — WhatsApp', () => {
  it('answers the Meta GET verification handshake with the challenge', async () => {
    const { base } = await startHost([WA_CHANNEL])
    const res = await fetch(
      `${base}/webhooks/whatsapp/whatsapp-acme?hub.mode=subscribe&hub.verify_token=VERIFY&hub.challenge=C123`,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('C123')
  })

  it('403s the handshake on a wrong verify token', async () => {
    const { base } = await startHost([WA_CHANNEL])
    const res = await fetch(
      `${base}/webhooks/whatsapp/whatsapp-acme?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=C123`,
    )
    expect(res.status).toBe(403)
  })

  it('a signed customer message drives the agent and the reply goes out via the Cloud API', async () => {
    const { host, gateway, outbound, base } = await startHost([WA_CHANNEL])
    const res = await postWhatsApp(base, waBody('15550001111', 'is medium in stock?', 'wamid.1'))
    expect(res.status).toBe(200)

    await host.idle()
    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]).toMatchObject({ profileId: 'acme', prompt: 'is medium in stock?' })
    expect(outbound.at(-1)?.url).toContain('/PID/messages')
    expect(JSON.parse(outbound.at(-1)!.body)).toMatchObject({ to: '15550001111', text: { body: 'ok' } })
  })

  it('a bad signature is dropped with HTTP 200 and never reaches the agent', async () => {
    const { host, gateway, base, logs } = await startHost([WA_CHANNEL])
    const raw = JSON.stringify(waBody('1', 'evil', 'wamid.evil'))
    const res = await fetch(`${base}/webhooks/whatsapp/whatsapp-acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
      body: raw,
    })
    expect(res.status).toBe(200) // 200, not 4xx — a 4xx makes Meta retry forever
    await host.idle()
    expect(gateway.runs).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/invalid Meta signature/)
  })

  it('a missing signature on a secret-bearing channel is also dropped', async () => {
    const { host, gateway, base } = await startHost([WA_CHANNEL])
    const res = await postWhatsApp(base, waBody('1', 'hi', 'wamid.nosig'), false)
    expect(res.status).toBe(200)
    await host.idle()
    expect(gateway.runs).toHaveLength(0)
  })

  it('a re-delivered WAMID is deduped (Meta delivers the same event twice)', async () => {
    const { host, gateway, base } = await startHost([WA_CHANNEL])
    await postWhatsApp(base, waBody('15550001111', 'hello', 'wamid.dup'))
    await postWhatsApp(base, waBody('15550001111', 'hello', 'wamid.dup'))
    await host.idle()
    expect(gateway.runs).toHaveLength(1)
  })

  it("a payload for a different phone_number_id is dropped, not misrouted", async () => {
    const { host, gateway, base, logs } = await startHost([WA_CHANNEL])
    const res = await postWhatsApp(base, waBody('15550001111', 'hi', 'wamid.other', 'OTHER_PID'))
    expect(res.status).toBe(200)
    await host.idle()
    expect(gateway.runs).toHaveLength(0)
    expect(logs.join('\n')).toMatch(/different phone_number_id/)
  })

  it('malformed JSON is dropped with 200 (never a Meta retry loop)', async () => {
    const { host, gateway, base } = await startHost([WA_CHANNEL])
    const raw = '{not json'
    const res = await fetch(`${base}/webhooks/whatsapp/whatsapp-acme`, {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': metaSign(raw) },
      body: raw,
    })
    expect(res.status).toBe(200)
    await host.idle()
    expect(gateway.runs).toHaveLength(0)
  })

  it('an oversized payload gets 413', async () => {
    const { base } = await startHost([WA_CHANNEL])
    const res = await fetch(`${base}/webhooks/whatsapp/whatsapp-acme`, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1),
    })
    expect(res.status).toBe(413)
  })
})

describe('ChannelWebhookHost — SMS (Twilio)', () => {
  const form = new URLSearchParams({
    From: '+15550001111',
    To: '+15550009999',
    Body: 'do you open saturday?',
    MessageSid: 'SM1',
  })

  it('an inbound form drives the agent, replies 200 TwiML, and sends via the REST API', async () => {
    const { host, gateway, outbound, base } = await startHost([SMS_CHANNEL])
    const res = await fetch(`${base}/webhooks/sms/sms-acme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/xml')
    expect(await res.text()).toContain('<Response/>')

    await host.idle()
    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]).toMatchObject({ profileId: 'acme', prompt: 'do you open saturday?' })
    expect(outbound.length).toBeGreaterThan(0)
  })

  it('enforces the Twilio signature when publicBaseUrl is configured', async () => {
    const publicBaseUrl = 'https://hooks.example.test'
    const { host, gateway, base } = await startHost([SMS_CHANNEL], { publicBaseUrl })
    const params = Object.fromEntries(new URLSearchParams(form))

    const bad = await fetch(`${base}/webhooks/sms/sms-acme`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'bogus',
      },
      body: form.toString(),
    })
    expect(bad.status).toBe(403)

    // Sign exactly as Twilio does: URL + sorted key/value concat, HMAC-SHA1.
    let data = `${publicBaseUrl}/webhooks/sms/sms-acme`
    for (const key of Object.keys(params).sort()) data += key + params[key]
    const signature = createHmac('sha1', 'twtoken').update(Buffer.from(data, 'utf-8')).digest('base64')
    expect(validateTwilioSignature('twtoken', `${publicBaseUrl}/webhooks/sms/sms-acme`, params, signature)).toBe(true)

    const good = await fetch(`${base}/webhooks/sms/sms-acme`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: form.toString(),
    })
    expect(good.status).toBe(200)
    await host.idle()
    expect(gateway.runs).toHaveLength(1)
  })

  it('a re-delivered MessageSid is deduped', async () => {
    const { host, gateway, base } = await startHost([SMS_CHANNEL])
    const send = (): Promise<Response> =>
      fetch(`${base}/webhooks/sms/sms-acme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
    await send()
    await send()
    await host.idle()
    expect(gateway.runs).toHaveLength(1)
  })
})

describe('filterWhatsAppInbound', () => {
  it('keeps unseen matching messages, drops seen and mismatched ones', () => {
    const body: WhatsAppWebhookBody = {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PID' },
                messages: [
                  { from: '1', id: 'a', type: 'text', text: { body: 'new' } },
                  { from: '1', id: 'b', type: 'text', text: { body: 'seen' } },
                ],
              },
            },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'OTHER' },
                messages: [{ from: '2', id: 'c', type: 'text', text: { body: 'foreign' } }],
              },
            },
          ],
        },
      ],
    }
    const result = filterWhatsAppInbound(body, 'PID', (id) => id === 'b')
    expect(result.ids).toEqual(['a'])
    expect(result.droppedSeen).toBe(1)
    expect(result.droppedMismatch).toBe(1)
    const kept = result.body.entry?.[0]?.changes?.flatMap((c) => c.value?.messages ?? [])
    expect(kept?.map((m) => m.id)).toEqual(['a'])
  })

  it('keeps messages without an id (cannot dedup) and leaves status-only changes alone', () => {
    const body: WhatsAppWebhookBody = {
      entry: [
        {
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: 'PID' } } },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PID' },
                messages: [{ from: '1', type: 'text', text: { body: 'no id' } }],
              },
            },
          ],
        },
      ],
    }
    const result = filterWhatsAppInbound(body, 'PID', () => true)
    expect(result.ids).toEqual([])
    expect(result.droppedSeen).toBe(0)
    expect(result.body.entry?.[0]?.changes).toHaveLength(2)
  })
})
