import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { parseWhatsAppWebhook, verifyWhatsAppSignature, verifyWebhookChallenge, type WhatsAppWebhookBody } from '../whatsapp/message.js'
import { WhatsAppApi } from '../whatsapp/api.js'
import { WhatsAppShuttle } from '../whatsapp/shuttle.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fakeGraph(record: Array<{ url: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    record.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return jsonRes({ messages: [{ id: 'wamid.OUT' }] })
  }) as unknown as typeof fetch
}

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

const textWebhook = (from: string, body: string): WhatsAppWebhookBody => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'PID' },
            messages: [{ from, id: 'wamid.IN', type: 'text', text: { body } }],
          },
        },
      ],
    },
  ],
})

describe('parseWhatsAppWebhook', () => {
  it('extracts a text message as a DM keyed by the number', () => {
    expect(parseWhatsAppWebhook(textWebhook('15550001111', 'hello'))).toEqual([
      { chatType: 'dm', chatId: '15550001111', target: '15550001111', text: 'hello', userId: '15550001111' },
    ])
  })

  it('ignores status callbacks / non-text (no messages array)', () => {
    const statusOnly: WhatsAppWebhookBody = {
      entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }],
    }
    expect(parseWhatsAppWebhook(statusOnly)).toEqual([])
  })
})

describe('verifyWhatsAppSignature', () => {
  it('accepts a correct signature, rejects tampered / wrong secret', () => {
    const raw = JSON.stringify({ hello: 'world' })
    const good = `sha256=${createHmac('sha256', 'appsecret').update(Buffer.from(raw, 'utf-8')).digest('hex')}`
    expect(verifyWhatsAppSignature('appsecret', raw, good)).toBe(true)
    expect(verifyWhatsAppSignature('appsecret', raw, 'sha256=deadbeef')).toBe(false)
    expect(verifyWhatsAppSignature('wrong', raw, good)).toBe(false)
  })
})

describe('verifyWebhookChallenge', () => {
  it('echoes the challenge when the token matches, else null', () => {
    expect(
      verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'T', 'hub.challenge': 'C123' }, 'T'),
    ).toBe('C123')
    expect(verifyWebhookChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'X', 'hub.challenge': 'C123' }, 'T')).toBeNull()
  })
})

describe('WhatsAppApi.sendText', () => {
  it('POSTs the Cloud API message shape with a bearer token', async () => {
    const record: Array<{ url: string; body: Record<string, unknown> }> = []
    const api = new WhatsAppApi({ accessToken: 'TOK', phoneNumberId: 'PID', fetch: fakeGraph(record) })
    const r = await api.sendText('15550001111', 'hi there')
    expect(r.id).toBe('wamid.OUT')
    expect(record[0]?.url).toBe('https://graph.facebook.com/v24.0/PID/messages')
    expect(record[0]?.body).toEqual({ messaging_product: 'whatsapp', to: '15550001111', type: 'text', text: { body: 'hi there' } })
  })
})

describe('WhatsAppShuttle.handleInbound — the business-line flow', () => {
  it('a customer message drives the agent and the reply is sent back to their number', async () => {
    const gateway = new MockGateway()
    const record: Array<{ url: string; body: Record<string, unknown> }> = []
    const wa = new WhatsAppShuttle({
      accessToken: 'TOK',
      phoneNumberId: 'PID',
      profileId: 'acme',
      gateway,
      fetch: fakeGraph(record),
    })

    const results = await wa.handleInbound(textWebhook('15550001111', 'is medium in stock?'))

    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]).toMatchObject({ profileId: 'acme', prompt: 'is medium in stock?' })
    expect(results[0]?.text).toBe('ok')
    expect(record.at(-1)?.body).toMatchObject({ to: '15550001111', text: { body: 'ok' } })
  })

  it('rejects an inbound with a bad signature', async () => {
    const wa = new WhatsAppShuttle({ accessToken: 'TOK', phoneNumberId: 'PID', appSecret: 'sekret', profileId: 'acme', gateway: new MockGateway(), fetch: fakeGraph([]) })
    await expect(
      wa.handleInbound(textWebhook('1', 'hi'), { rawBody: '{"a":1}', signature: 'sha256=bad' }),
    ).rejects.toThrow(/signature/)
  })
})
