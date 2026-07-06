import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { parseTwilioForm, validateTwilioSignature } from '../sms/message.js'
import { TwilioApi } from '../sms/api.js'
import { SmsTransport } from '../sms/transport.js'
import { SmsShuttle } from '../sms/shuttle.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

/** Records Twilio REST calls (form-decoded) and answers Messages.json. */
function fakeTwilio(record: Array<{ url: string; form: Record<string, string> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const form: Record<string, string> = {}
    for (const [k, v] of new URLSearchParams(String(init?.body ?? '')).entries()) form[k] = v
    record.push({ url: String(url), form })
    return jsonRes({ sid: 'SM123' })
  }) as unknown as typeof fetch
}

class MockGateway implements GatewayClient {
  readonly runs: RunInput[] = []
  private tid = 0
  private seq = 0
  replyText = 'ok'
  async run(input: RunInput): Promise<{ threadId: string }> {
    this.runs.push(input)
    return { threadId: input.threadId ?? `t${++this.tid}` }
  }
  async *streamReply(_t: string, _o: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    yield { type: 'delta', text: this.replyText, seq: ++this.seq }
    yield { type: 'done', seq: ++this.seq }
  }
}

describe('parseTwilioForm', () => {
  it('maps From/Body to a DM keyed by the phone number', () => {
    const msg = parseTwilioForm({ From: '+15550001111', To: '+15559999999', Body: 'do you have blue?' })
    expect(msg).toEqual({
      chatType: 'dm',
      chatId: '+15550001111',
      target: '+15550001111',
      text: 'do you have blue?',
      userId: '+15550001111',
    })
  })

  it('returns null when Body is empty', () => {
    expect(parseTwilioForm({ From: '+1', Body: '  ' })).toBeNull()
  })
})

describe('validateTwilioSignature', () => {
  const authToken = 'test-token'
  const url = 'https://acme.example/webhooks/sms'
  const params = { From: '+1', To: '+2', Body: 'hi' }

  function sign(): string {
    let data = url
    for (const k of Object.keys(params).sort()) data += k + params[k as keyof typeof params]
    return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64')
  }

  it('accepts a correct signature and rejects a tampered one', () => {
    expect(validateTwilioSignature(authToken, url, params, sign())).toBe(true)
    expect(validateTwilioSignature(authToken, url, params, 'AAAA')).toBe(false)
    expect(validateTwilioSignature('wrong-token', url, params, sign())).toBe(false)
  })
})

describe('TwilioApi.sendSms', () => {
  it('POSTs to Messages.json with From/To/Body and basic auth', async () => {
    const record: Array<{ url: string; form: Record<string, string> }> = []
    const api = new TwilioApi({ accountSid: 'AC1', authToken: 'tok', fetch: fakeTwilio(record) })
    const r = await api.sendSms('+1', '+2', 'hello')
    expect(r.sid).toBe('SM123')
    expect(record[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json')
    expect(record[0]?.form).toEqual({ From: '+1', To: '+2', Body: 'hello' })
  })
})

describe('SmsTransport', () => {
  it('degrades to final delivery (no edit/typing) and sends from the fixed number', async () => {
    const record: Array<{ url: string; form: Record<string, string> }> = []
    const t = new SmsTransport(new TwilioApi({ accountSid: 'AC1', authToken: 'tok', fetch: fakeTwilio(record) }), '+15559999999')
    expect(t.supportsEdit).toBe(false)
    expect(t.supportsTyping).toBe(false)
    expect(t.maxChars).toBe(1600)
    await t.sendText('+15550001111', 'reply')
    expect(record[0]?.form).toEqual({ From: '+15559999999', To: '+15550001111', Body: 'reply' })
  })
})

describe('SmsShuttle.handleInbound — the business-line flow', () => {
  it('a customer text drives the agent and the reply is texted back to their number', async () => {
    const gateway = new MockGateway()
    const record: Array<{ url: string; form: Record<string, string> }> = []
    const sms = new SmsShuttle({
      accountSid: 'AC1',
      authToken: 'tok',
      from: '+15559999999',
      profileId: 'acme',
      gateway,
      fetch: fakeTwilio(record),
    })

    const result = await sms.handleInbound({ From: '+15550001111', To: '+15559999999', Body: 'is medium in stock?' })

    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]).toMatchObject({ profileId: 'acme', prompt: 'is medium in stock?' })
    expect(result?.text).toBe('ok')
    // reply routed back to the customer's number, from the business number
    expect(record.at(-1)?.form).toEqual({ From: '+15559999999', To: '+15550001111', Body: 'ok' })
  })

  it('rejects a request with a bad signature', async () => {
    const sms = new SmsShuttle({ accountSid: 'AC1', authToken: 'tok', from: '+1', profileId: 'acme', gateway: new MockGateway(), fetch: fakeTwilio([]) })
    await expect(
      sms.handleInbound({ From: '+2', Body: 'hi' }, { url: 'https://acme/x', signature: 'bogus' }),
    ).rejects.toThrow(/signature/)
  })
})
