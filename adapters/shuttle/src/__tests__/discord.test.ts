import { describe, it, expect } from 'vitest'
import { toShuttleMessage, type DiscordMessageCreate } from '../discord/message.js'
import { DiscordApi } from '../discord/api.js'
import { DiscordTransport } from '../discord/transport.js'
import { DiscordShuttle } from '../discord/shuttle.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fakeDiscord(record: Array<{ url: string; method: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    record.push({ url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? '{}')) })
    return jsonRes({ id: '999' })
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

describe('discord toShuttleMessage', () => {
  it('maps a DM (no guild_id) — answers directly', () => {
    const d: DiscordMessageCreate = { channel_id: 'CH1', content: 'hi', author: { id: 'U9' } }
    expect(toShuttleMessage(d, 'BOT')).toMatchObject({ chatType: 'dm', chatId: 'CH1', text: 'hi', userId: 'U9' })
  })

  it('a guild message is a channel; isMention true only when the bot is in mentions', () => {
    const base = { channel_id: 'CH1', guild_id: 'G1', content: 'hey', author: { id: 'U9' } }
    expect(toShuttleMessage({ ...base, mentions: [{ id: 'BOT' }] }, 'BOT')).toMatchObject({ chatType: 'channel', isMention: true })
    expect(toShuttleMessage({ ...base, mentions: [{ id: 'SOMEONE' }] }, 'BOT')).toMatchObject({ isMention: false })
    expect(toShuttleMessage({ ...base, mention_everyone: true }, 'BOT')).toMatchObject({ isMention: true })
  })

  it('ignores bot authors and empty content', () => {
    expect(toShuttleMessage({ channel_id: 'CH1', content: 'x', author: { id: 'B', bot: true } }, 'BOT')).toBeNull()
    expect(toShuttleMessage({ channel_id: 'CH1', content: '  ', author: { id: 'U9' } }, 'BOT')).toBeNull()
  })
})

describe('DiscordApi / DiscordTransport', () => {
  it('sendMessage POSTs to channels/{id}/messages with Bot auth', async () => {
    const record: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
    const api = new DiscordApi({ token: 'TOK', fetch: fakeDiscord(record) })
    const r = await api.sendMessage('CH1', 'yo')
    expect(r.id).toBe('999')
    expect(record[0]?.url).toBe('https://discord.com/api/v10/channels/CH1/messages')
    expect(record[0]?.method).toBe('POST')
    expect(record[0]?.body).toEqual({ content: 'yo' })
  })

  it('transport supports edit + typing, limit 2000', () => {
    const t = new DiscordTransport(new DiscordApi({ token: 'TOK', fetch: fakeDiscord([]) }))
    expect(t.maxChars).toBe(2000)
    expect(t.supportsEdit).toBe(true)
    expect(t.supportsTyping).toBe(true)
  })
})

describe('DiscordShuttle.processMessage', () => {
  it('a DM drives the agent and posts the reply to the channel', async () => {
    const gateway = new MockGateway()
    const record: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
    const discord = new DiscordShuttle({
      token: 'TOK',
      profileId: 'acme',
      gateway,
      botUserId: 'BOT',
      fetch: fakeDiscord(record),
      delivery: { mode: 'final' },
    })

    await discord.processMessage({ channel_id: 'CH1', content: 'hello', author: { id: 'U9' } })

    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]?.prompt).toBe('hello')
    const posts = record.filter((r) => r.method === 'POST' && r.url.endsWith('/messages'))
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toEqual({ content: 'ok' })
  })
})
