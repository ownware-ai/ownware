import { describe, it, expect } from 'vitest'
import { AgentChannel, createChannelHub } from '../../../src/agents/protocol.js'
import type { AgentMessage } from '../../../src/agents/types.js'

describe('AgentChannel', () => {
  describe('basic send/receive', () => {
    it('sends and receives a message', async () => {
      const channel = new AgentChannel()
      channel.send('agent-a', 'agent-b', 'hello')

      const gen = channel.receive('agent-b')
      const { value, done } = await gen.next()
      expect(done).toBe(false)
      expect(value).toMatchObject({
        from: 'agent-a',
        to: 'agent-b',
        content: 'hello',
      })
      expect(value!.timestamp).toBeGreaterThan(0)

      channel.close()
    })

    it('delivers messages in order', async () => {
      const channel = new AgentChannel()
      channel.send('a', 'b', 'first')
      channel.send('a', 'b', 'second')
      channel.send('a', 'b', 'third')

      const messages: AgentMessage[] = []
      const gen = channel.receive('b')

      messages.push((await gen.next()).value!)
      messages.push((await gen.next()).value!)
      messages.push((await gen.next()).value!)

      expect(messages.map(m => m.content)).toEqual(['first', 'second', 'third'])
      channel.close()
    })

    it('includes optional payload', async () => {
      const channel = new AgentChannel()
      channel.send('a', 'b', 'data', { key: 'value', count: 42 })

      const gen = channel.receive('b')
      const { value } = await gen.next()
      expect(value!.payload).toEqual({ key: 'value', count: 42 })

      channel.close()
    })
  })

  describe('blocking receive', () => {
    it('blocks until a message arrives', async () => {
      const channel = new AgentChannel()
      const gen = channel.receive('agent-b')

      // Start receiving (will block)
      const receivePromise = gen.next()

      // Send after a short delay
      setTimeout(() => channel.send('a', 'agent-b', 'delayed'), 20)

      const { value } = await receivePromise
      expect(value!.content).toBe('delayed')
      channel.close()
    })
  })

  describe('pending count', () => {
    it('tracks queued messages', () => {
      const channel = new AgentChannel()
      expect(channel.pending('b')).toBe(0)

      channel.send('a', 'b', 'msg1')
      channel.send('a', 'b', 'msg2')
      expect(channel.pending('b')).toBe(2)

      channel.close()
    })

    it('returns 0 for unknown agents', () => {
      const channel = new AgentChannel()
      expect(channel.pending('nonexistent')).toBe(0)
      channel.close()
    })
  })

  describe('close', () => {
    it('receive completes after close', async () => {
      const channel = new AgentChannel()
      channel.send('a', 'b', 'before-close')

      const gen = channel.receive('b')
      const msg1 = await gen.next()
      expect(msg1.value!.content).toBe('before-close')

      channel.close()

      // Next should signal done
      const msg2 = await gen.next()
      expect(msg2.done).toBe(true)
    })

    it('isClosed reflects state', () => {
      const channel = new AgentChannel()
      expect(channel.isClosed).toBe(false)
      channel.close()
      expect(channel.isClosed).toBe(true)
    })

    it('send throws after close', () => {
      const channel = new AgentChannel()
      channel.close()
      expect(() => channel.send('a', 'b', 'too late')).toThrow('Channel is closed')
    })

    it('drains remaining messages after close', async () => {
      const channel = new AgentChannel()
      channel.send('a', 'b', 'msg1')
      channel.send('a', 'b', 'msg2')
      channel.close()

      const messages: string[] = []
      for await (const msg of channel.receive('b')) {
        messages.push(msg.content)
      }
      expect(messages).toEqual(['msg1', 'msg2'])
    })
  })

  describe('multiple agents', () => {
    it('messages only go to intended recipient', async () => {
      const channel = new AgentChannel()
      channel.send('a', 'b', 'for-b')
      channel.send('a', 'c', 'for-c')

      expect(channel.pending('b')).toBe(1)
      expect(channel.pending('c')).toBe(1)

      const genB = channel.receive('b')
      const { value: msgB } = await genB.next()
      expect(msgB!.content).toBe('for-b')

      const genC = channel.receive('c')
      const { value: msgC } = await genC.next()
      expect(msgC!.content).toBe('for-c')

      channel.close()
    })
  })
})

describe('createChannelHub', () => {
  it('returns an AgentChannel instance', () => {
    const channel = createChannelHub(['agent-a', 'agent-b'])
    expect(channel).toBeInstanceOf(AgentChannel)
    channel.close()
  })
})
