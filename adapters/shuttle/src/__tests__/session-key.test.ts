import { describe, it, expect } from 'vitest'
import {
  sessionKey,
  isSessionKey,
  sessionKeyPrefix,
  parseSessionKey,
} from '../session-key.js'

describe('sessionKey — the oracle', () => {
  it('keys a DM by chat id', () => {
    expect(
      sessionKey({ profile: 'acme-support', channel: 'telegram', chatType: 'dm', chatId: '12345' }),
    ).toBe('ownware:acme-support:telegram:dm:12345')
  })

  it('keys a group as one shared conversation by default', () => {
    expect(
      sessionKey(
        { profile: 'acme', channel: 'whatsapp', chatType: 'group', chatId: '120363@g.us', userId: '15551234567' },
      ),
    ).toBe('ownware:acme:whatsapp:group:120363@g.us')
  })

  it('isolates each participant when groupPerUser is set', () => {
    expect(
      sessionKey(
        { profile: 'acme', channel: 'whatsapp', chatType: 'group', chatId: '120363@g.us', userId: '15551234567' },
        { groupPerUser: true },
      ),
    ).toBe('ownware:acme:whatsapp:group:120363@g.us:user:15551234567')
  })

  it('never adds a user segment to a DM even with groupPerUser', () => {
    expect(
      sessionKey(
        { profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '999', userId: '999' },
        { groupPerUser: true },
      ),
    ).toBe('ownware:acme:telegram:dm:999')
  })

  it('appends a platform sub-thread', () => {
    expect(
      sessionKey({ profile: 'acme', channel: 'slack', chatType: 'channel', chatId: 'C0ABC', threadId: '1712345678.9001' }),
    ).toBe('ownware:acme:slack:channel:C0ABC:thread:1712345678.9001')
  })

  it('orders thread before user', () => {
    expect(
      sessionKey(
        { profile: 'acme', channel: 'slack', chatType: 'channel', chatId: 'C0ABC', threadId: 'T1', userId: 'U1' },
        { groupPerUser: true },
      ),
    ).toBe('ownware:acme:slack:channel:C0ABC:thread:T1:user:U1')
  })

  it('is stable — same input → same key (context isolation guarantee)', () => {
    const parts = { profile: 'acme', channel: 'telegram', chatType: 'group' as const, chatId: 'G1' }
    expect(sessionKey(parts)).toBe(sessionKey(parts))
  })

  it('keeps different profiles/channels/chats in separate keys', () => {
    const a = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '1' })
    const b = sessionKey({ profile: 'acme', channel: 'slack', chatType: 'dm', chatId: '1' })
    const c = sessionKey({ profile: 'other', channel: 'telegram', chatType: 'dm', chatId: '1' })
    const d = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: '2' })
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('sanitizes delimiters and whitespace inside ids so they cannot break the key', () => {
    const key = sessionKey({ profile: 'acme', channel: 'telegram', chatType: 'dm', chatId: 'a:b c' })
    expect(key).toBe('ownware:acme:telegram:dm:a_b_c')
    expect(parseSessionKey(key)?.chatId).toBe('a_b_c')
  })

  it('throws on empty required parts', () => {
    expect(() => sessionKey({ profile: '', channel: 'telegram', chatType: 'dm', chatId: '1' })).toThrow(/profile/)
    expect(() => sessionKey({ profile: 'a', channel: '  ', chatType: 'dm', chatId: '1' })).toThrow(/channel/)
    expect(() => sessionKey({ profile: 'a', channel: 'telegram', chatType: 'dm', chatId: '' })).toThrow(/chatId/)
  })
})

describe('isSessionKey', () => {
  it('accepts keys the oracle produces', () => {
    expect(isSessionKey('ownware:acme:telegram:dm:12345')).toBe(true)
    expect(isSessionKey(sessionKey({ profile: 'a', channel: 'slack', chatType: 'channel', chatId: 'C', threadId: 'T' }))).toBe(true)
  })

  it('rejects non-keys', () => {
    expect(isSessionKey('hello')).toBe(false)
    expect(isSessionKey('ownware:a:b:notachattype:c')).toBe(false)
    expect(isSessionKey('other:a:b:dm:c')).toBe(false)
  })
})

describe('sessionKeyPrefix', () => {
  it('scopes an agent+channel', () => {
    expect(sessionKeyPrefix('acme-support', 'telegram')).toBe('ownware:acme-support:telegram')
  })
})

describe('parseSessionKey — inverse of sessionKey', () => {
  it('round-trips a full key', () => {
    const parts = {
      profile: 'acme',
      channel: 'slack',
      chatType: 'channel' as const,
      chatId: 'C0ABC',
      threadId: 'T1',
      userId: 'U1',
    }
    const key = sessionKey(parts, { groupPerUser: true })
    expect(parseSessionKey(key)).toEqual(parts)
  })

  it('round-trips a bare DM key', () => {
    expect(parseSessionKey('ownware:acme:telegram:dm:12345')).toEqual({
      profile: 'acme',
      channel: 'telegram',
      chatType: 'dm',
      chatId: '12345',
    })
  })

  it('returns null for malformed input', () => {
    expect(parseSessionKey('nope')).toBeNull()
    expect(parseSessionKey('ownware:a:b')).toBeNull()
    expect(parseSessionKey('ownware:a:b:badtype:c')).toBeNull()
  })
})
