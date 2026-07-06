import { describe, it, expect } from 'vitest'
import { toShuttleMessage, isBotMentioned } from '../telegram/message.js'
import { TelegramApi, type TgUpdate, type TgMessage } from '../telegram/api.js'
import { TelegramTransport } from '../telegram/transport.js'
import { TelegramShuttle } from '../telegram/shuttle.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

// ── helpers ────────────────────────────────────────────────────────────────

function jsonRes(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** A fake Telegram Bot API that records calls and answers the methods we use. */
function fakeTelegram(record: Array<{ method: string; body: Record<string, unknown> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = u.slice(u.lastIndexOf('/') + 1)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    record.push({ method, body })
    if (method === 'getMe') return jsonRes({ ok: true, result: { id: 1, is_bot: true, username: 'acmebot' } })
    if (method === 'sendMessage')
      return jsonRes({ ok: true, result: { message_id: 42, chat: { id: body['chat_id'], type: 'private' } } })
    if (method === 'editMessageText') return jsonRes({ ok: true, result: { message_id: body['message_id'] } })
    if (method === 'sendChatAction') return jsonRes({ ok: true, result: true })
    if (method === 'getUpdates') return jsonRes({ ok: true, result: [] })
    return jsonRes({ ok: false, description: `unknown method ${method}` })
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
  async *streamReply(_threadId: string, _opts: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    yield { type: 'delta', text: this.replyText, seq: ++this.seq }
    yield { type: 'done', seq: ++this.seq }
  }
}

const dmUpdate = (chatId: number, text: string): TgUpdate => ({
  update_id: chatId,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, text },
})

// ── toShuttleMessage ─────────────────────────────────────────────────────────

describe('toShuttleMessage', () => {
  it('maps a private message to a DM', () => {
    const msg = toShuttleMessage(dmUpdate(100, 'hi'))
    expect(msg).toMatchObject({ chatType: 'dm', chatId: '100', target: '100', text: 'hi', userId: '100' })
    expect(msg?.isMention).toBeUndefined() // DMs don't gate on mention
  })

  it('maps a supergroup message to a group and carries a forum topic as threadId', () => {
    const msg = toShuttleMessage({
      update_id: 1,
      message: {
        message_id: 5,
        chat: { id: -200, type: 'supergroup' },
        from: { id: 9, is_bot: false },
        text: 'hello',
        message_thread_id: 77,
      },
    })
    expect(msg).toMatchObject({ chatType: 'group', chatId: '-200', threadId: '77', isMention: false })
  })

  it('returns null for a message with no text', () => {
    expect(toShuttleMessage({ update_id: 1, message: { message_id: 1, chat: { id: 1, type: 'private' } } })).toBeNull()
  })
})

describe('isBotMentioned', () => {
  const withEntity = (text: string, off: number, len: number): TgMessage => ({
    message_id: 1,
    chat: { id: -1, type: 'group' },
    text,
    entities: [{ type: 'mention', offset: off, length: len }],
  })

  it('detects an @mention entity for the bot', () => {
    const text = 'hey @acmebot help'
    expect(isBotMentioned(withEntity(text, 4, 8), text, 'acmebot')).toBe(true)
  })

  it('detects a reply to the bot', () => {
    const m: TgMessage = {
      message_id: 2,
      chat: { id: -1, type: 'group' },
      text: 'thanks',
      reply_to_message: { message_id: 1, chat: { id: -1, type: 'group' }, from: { id: 1, is_bot: true, username: 'acmebot' } },
    }
    expect(isBotMentioned(m, 'thanks', 'acmebot')).toBe(true)
  })

  it('is false when a different handle is mentioned', () => {
    const text = 'hey @someoneelse'
    expect(isBotMentioned(withEntity(text, 4, 12), text, 'acmebot')).toBe(false)
  })
})

// ── TelegramApi / TelegramTransport ──────────────────────────────────────────

describe('TelegramApi', () => {
  it('sendMessage POSTs chat_id + text and returns the message', async () => {
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const api = new TelegramApi({ token: 'T', fetch: fakeTelegram(record) })
    const m = await api.sendMessage('100', 'yo')
    expect(record[0]?.method).toBe('sendMessage')
    expect(record[0]?.body).toEqual({ chat_id: '100', text: 'yo' })
    expect(m.message_id).toBe(42)
  })
})

describe('TelegramTransport', () => {
  it('advertises Telegram capabilities and returns a message id from sendText', async () => {
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const t = new TelegramTransport(new TelegramApi({ token: 'T', fetch: fakeTelegram(record) }))
    expect(t.maxChars).toBe(4096)
    expect(t.supportsEdit).toBe(true)
    expect(t.supportsTyping).toBe(true)
    expect(await t.sendText('100', 'hi')).toBe('42')
    await t.sendTyping('100')
    expect(record.map((r) => r.method)).toEqual(['sendMessage', 'sendChatAction'])
  })
})

// ── TelegramShuttle (end-to-end over the base, mocked gateway) ────────────────

describe('TelegramShuttle.processUpdate', () => {
  it('drives the agent for a DM and posts the reply back to the same chat', async () => {
    const gateway = new MockGateway()
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const shuttle = new TelegramShuttle({
      token: 'T',
      profileId: 'acme',
      gateway,
      botUsername: 'acmebot',
      fetch: fakeTelegram(record),
      delivery: { mode: 'final' },
    })

    await shuttle.processUpdate(dmUpdate(100, 'hello'))

    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]).toMatchObject({ profileId: 'acme', prompt: 'hello' })
    const sends = record.filter((r) => r.method === 'sendMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.body).toEqual({ chat_id: '100', text: 'ok' }) // routed back to source
  })

  it('ignores an unmentioned group message (default mention policy)', async () => {
    const gateway = new MockGateway()
    const record: Array<{ method: string; body: Record<string, unknown> }> = []
    const shuttle = new TelegramShuttle({ token: 'T', profileId: 'acme', gateway, botUsername: 'acmebot', fetch: fakeTelegram(record) })

    await shuttle.processUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: -500, type: 'group' }, from: { id: 9, is_bot: false }, text: 'random chatter' },
    })

    expect(gateway.runs).toHaveLength(0)
    expect(record.filter((r) => r.method === 'sendMessage')).toHaveLength(0)
  })
})
