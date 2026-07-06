import { describe, it, expect } from 'vitest'
import { toShuttleMessage, type SlackEvent } from '../slack/message.js'
import { SlackApi } from '../slack/api.js'
import { SlackTransport } from '../slack/transport.js'
import { SlackShuttle } from '../slack/shuttle.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fakeSlack(record: Array<{ method: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = u.slice(u.lastIndexOf('/') + 1)
    record.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
    if (method === 'auth.test') return jsonRes({ ok: true, user_id: 'UBOT', team_id: 'T1' })
    if (method === 'chat.postMessage') return jsonRes({ ok: true, ts: '1712345678.9001' })
    if (method === 'chat.update') return jsonRes({ ok: true, ts: '1712345678.9001' })
    return jsonRes({ ok: false, error: `unknown_method:${method}` })
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

describe('slack toShuttleMessage', () => {
  it('maps app_mention to a channel message, strips the mention, marks isMention', () => {
    const ev: SlackEvent = { type: 'app_mention', channel: 'C1', user: 'U9', text: '<@UBOT> what are your hours?' }
    expect(toShuttleMessage(ev, 'UBOT')).toEqual({
      chatType: 'channel',
      chatId: 'C1',
      target: 'C1',
      text: 'what are your hours?',
      userId: 'U9',
      isMention: true,
    })
  })

  it('maps a DM (message.im) with no mention needed', () => {
    const ev: SlackEvent = { type: 'message', channel: 'D1', channel_type: 'im', user: 'U9', text: 'hi' }
    expect(toShuttleMessage(ev, 'UBOT')).toMatchObject({ chatType: 'dm', chatId: 'D1', text: 'hi' })
  })

  it('drops a channel message that mentions the bot (app_mention handles it — no dupe)', () => {
    const ev: SlackEvent = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U9', text: 'hey <@UBOT>' }
    expect(toShuttleMessage(ev, 'UBOT')).toBeNull()
  })

  it('ignores bot echoes and subtypes', () => {
    expect(toShuttleMessage({ type: 'message', bot_id: 'B1', channel: 'C1', user: 'U9', text: 'x' }, 'UBOT')).toBeNull()
    expect(toShuttleMessage({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U9', text: 'x' }, 'UBOT')).toBeNull()
  })
})

describe('SlackApi / SlackTransport', () => {
  it('postMessage sends channel+text and returns the ts', async () => {
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const api = new SlackApi({ botToken: 'xoxb', fetch: fakeSlack(record) })
    const r = await api.postMessage('C1', 'hi')
    expect(record[0]).toEqual({ method: 'chat.postMessage', body: { channel: 'C1', text: 'hi' } })
    expect(r.ts).toBe('1712345678.9001')
  })

  it('transport supports edit (not typing) and returns a message ts', async () => {
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const t = new SlackTransport(new SlackApi({ botToken: 'xoxb', fetch: fakeSlack(record) }))
    expect(t.supportsEdit).toBe(true)
    expect(t.supportsTyping).toBe(false)
    expect(await t.sendText('C1', 'hi')).toBe('1712345678.9001')
  })
})

describe('SlackShuttle.processEvent', () => {
  it('an @mention drives the agent and posts the reply to the channel', async () => {
    const gateway = new MockGateway()
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = new SlackShuttle({
      botToken: 'xoxb',
      appToken: 'xapp',
      profileId: 'acme',
      gateway,
      botUserId: 'UBOT',
      fetch: fakeSlack(record),
      delivery: { mode: 'final' },
    })

    await slack.processEvent({ type: 'app_mention', channel: 'C1', user: 'U9', text: '<@UBOT> hours?' })

    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]?.prompt).toBe('hours?')
    const posts = record.filter((r) => r.method === 'chat.postMessage')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toMatchObject({ channel: 'C1', text: 'ok' })
  })

  it('ignores an unmentioned channel message (default mention policy)', async () => {
    const gateway = new MockGateway()
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = new SlackShuttle({ botToken: 'xoxb', appToken: 'xapp', profileId: 'acme', gateway, botUserId: 'UBOT', fetch: fakeSlack(record) })
    await slack.processEvent({ type: 'message', channel_type: 'channel', channel: 'C1', user: 'U9', text: 'just chatting' })
    expect(gateway.runs).toHaveLength(0)
  })
})
