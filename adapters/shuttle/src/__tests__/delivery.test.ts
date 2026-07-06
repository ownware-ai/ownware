import { describe, it, expect } from 'vitest'
import {
  deliver,
  resolveMode,
  chunkText,
  type ChannelTransport,
  type ReplyEvent,
  type DeliveryMode,
} from '../delivery.js'

/** Records every platform call so tests can assert the exact sequence. */
class MockTransport implements ChannelTransport {
  readonly calls: Array<{ op: 'send' | 'edit' | 'typing'; text?: string; id?: string }> = []
  private counter = 0
  constructor(
    readonly maxChars: number,
    readonly supportsEdit: boolean,
    readonly supportsTyping: boolean,
  ) {}
  async sendText(_t: string, text: string): Promise<string | undefined> {
    this.calls.push({ op: 'send', text })
    return this.supportsEdit ? `m${++this.counter}` : undefined
  }
  async editText(_t: string, id: string, text: string): Promise<void> {
    this.calls.push({ op: 'edit', id, text })
  }
  async sendTyping(_t: string): Promise<void> {
    this.calls.push({ op: 'typing' })
  }
  ops(op: 'send' | 'edit' | 'typing') {
    return this.calls.filter((c) => c.op === op)
  }
}

async function* reply(...deltas: string[]): AsyncIterable<ReplyEvent> {
  for (const d of deltas) yield { type: 'delta', text: d }
  yield { type: 'done' }
}

const cap = (edit: boolean, typing: boolean, max = 4096) => new MockTransport(max, edit, typing)

describe('deliver — final', () => {
  it('collects the whole reply and sends ONE message (no typing, no edit)', async () => {
    const t = cap(true, true)
    const r = await deliver('chat', reply('Hello ', 'world'), t, { mode: 'final' })
    expect(t.ops('send').map((c) => c.text)).toEqual(['Hello world'])
    expect(t.ops('typing')).toHaveLength(0)
    expect(t.ops('edit')).toHaveLength(0)
    expect(r.text).toBe('Hello world')
    expect(r.chunks).toBe(1)
  })

  it('sends nothing for an empty reply', async () => {
    const t = cap(false, false)
    const r = await deliver('chat', reply(), t, { mode: 'final' })
    expect(t.calls).toHaveLength(0)
    expect(r.chunks).toBe(0)
  })
})

describe('deliver — typing+final', () => {
  it('shows typing first, then one message', async () => {
    const t = cap(false, true)
    await deliver('chat', reply('one ', 'two'), t, { mode: 'typing+final' })
    expect(t.calls[0]?.op).toBe('typing')
    expect(t.ops('send').map((c) => c.text)).toEqual(['one two'])
  })

  it('degrades to final when the platform cannot show typing', async () => {
    const t = cap(false, false)
    const r = await deliver('chat', reply('hi'), t, { mode: 'typing+final' })
    expect(t.ops('typing')).toHaveLength(0)
    expect(r.mode).toBe('final')
  })
})

describe('deliver — edit-stream', () => {
  it('sends a placeholder then edits as text grows, with a final edit', async () => {
    const t = cap(true, true)
    const r = await deliver(
      'chat',
      reply('a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)),
      t,
      { mode: 'edit-stream', editThrottleChars: 60 },
    )
    // one initial send (placeholder) + at least one intermediate edit + final edit
    expect(t.ops('send')).toHaveLength(1)
    expect(t.ops('edit').length).toBeGreaterThanOrEqual(1)
    expect(r.mode).toBe('edit-stream')
    expect(r.messageIds).toHaveLength(1)
    // the final edit carries the full text
    expect(t.ops('edit').at(-1)?.text).toBe('a'.repeat(40) + 'b'.repeat(40) + 'c'.repeat(40))
  })

  it('degrades to typing+final when the platform cannot edit', async () => {
    const t = cap(false, true)
    const r = await deliver('chat', reply('hi'), t, { mode: 'edit-stream' })
    expect(r.mode).toBe('typing+final')
    expect(t.ops('edit')).toHaveLength(0)
    expect(t.ops('typing')).toHaveLength(1)
  })
})

describe('deliver — chunked (composes with any mode)', () => {
  it('splits a reply longer than maxChars across multiple messages', async () => {
    const t = cap(false, false, 20)
    const long = 'word '.repeat(20).trim() // ~99 chars
    const r = await deliver('chat', reply(long), t, { mode: 'final' })
    expect(r.chunks).toBeGreaterThan(1)
    expect(t.ops('send').length).toBe(r.chunks)
    for (const c of t.ops('send')) expect((c.text ?? '').length).toBeLessThanOrEqual(20)
  })
})

describe('deliver — errors', () => {
  it('delivers an error as a final message', async () => {
    const t = cap(true, true)
    async function* errStream(): AsyncIterable<ReplyEvent> {
      yield { type: 'delta', text: 'partial' }
      yield { type: 'error', message: 'model overloaded' }
    }
    const r = await deliver('chat', errStream(), t, { mode: 'final' })
    expect(r.text).toContain('model overloaded')
    expect(t.ops('send').at(-1)?.text).toContain('model overloaded')
  })
})

describe('resolveMode', () => {
  const modes: DeliveryMode[] = ['final', 'typing+final', 'edit-stream']
  it('never returns a mode the transport cannot do', () => {
    for (const m of modes) {
      expect(resolveMode(m, cap(false, false))).toBe('final')
    }
    expect(resolveMode('edit-stream', cap(false, true))).toBe('typing+final')
    expect(resolveMode('edit-stream', cap(true, true))).toBe('edit-stream')
  })
})

describe('chunkText', () => {
  it('returns [] for empty and [text] when it fits', () => {
    expect(chunkText('', 10)).toEqual([])
    expect(chunkText('short', 10)).toEqual(['short'])
  })
  it('prefers to break at whitespace', () => {
    const parts = chunkText('hello world foo bar', 12)
    expect(parts.every((p) => p.length <= 12)).toBe(true)
    expect(parts.join(' ')).toContain('hello')
  })
})
