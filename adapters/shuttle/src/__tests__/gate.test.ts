import { describe, it, expect } from 'vitest'
import { PolicyGate, type LlmGate } from '../gate.js'
import { InMemoryPairingStore } from '../pairing.js'
import type { ShuttleMessage } from '../types.js'

const dm = (userId: string, text = 'hi'): ShuttleMessage => ({ chatType: 'dm', chatId: userId, target: userId, text, userId })
const group = (mention: boolean): ShuttleMessage => ({ chatType: 'group', chatId: 'G', target: 'G', text: 'hey', isMention: mention })

describe('PolicyGate — DM access (personal ↔ business)', () => {
  it('open line lets anyone through (business)', async () => {
    expect((await new PolicyGate('tg', { dm: 'open' }).evaluate(dm('u1'))).kind).toBe('agent_reply')
  })

  it('allowlist admits listed, drops the rest', async () => {
    const g = new PolicyGate('tg', { dm: 'allowlist', allowlist: ['u1'] })
    expect((await g.evaluate(dm('u1'))).kind).toBe('agent_reply')
    expect((await g.evaluate(dm('u2'))).kind).toBe('drop')
  })

  it('pairing: unknown gets a canned code; once approved, runs the agent', async () => {
    const pairing = new InMemoryPairingStore({ generateCode: () => 'PAIR1234' })
    const g = new PolicyGate('tg', { dm: 'pairing' }, { pairing })
    const d = await g.evaluate(dm('u1'))
    expect(d.kind).toBe('canned_reply')
    if (d.kind === 'canned_reply') expect(d.text).toContain('PAIR1234')
    await pairing.approveCode('tg', 'PAIR1234')
    expect((await g.evaluate(dm('u1'))).kind).toBe('agent_reply')
  })

  it('pairing without a store fails closed (drop)', async () => {
    expect((await new PolicyGate('tg', { dm: 'pairing' }).evaluate(dm('u1'))).kind).toBe('drop')
  })

  it('pairing: a second quick request returns the already-pending message', async () => {
    const pairing = new InMemoryPairingStore({ now: () => 0, generateCode: () => 'ONETIME1' })
    const g = new PolicyGate('tg', { dm: 'pairing' }, { pairing })
    await g.evaluate(dm('u1'))
    const d = await g.evaluate(dm('u1'))
    expect(d.kind).toBe('canned_reply')
    if (d.kind === 'canned_reply') expect(d.text).toContain('already have a pending')
  })
})

describe('PolicyGate — group / @mention', () => {
  it('default `mention`: answers when mentioned, drops otherwise', async () => {
    const g = new PolicyGate('tg', {})
    expect((await g.evaluate(group(true))).kind).toBe('agent_reply')
    expect((await g.evaluate(group(false))).kind).toBe('drop')
  })
  it('`all` answers without a mention; `off` never answers', async () => {
    expect((await new PolicyGate('tg', { group: 'all' }).evaluate(group(false))).kind).toBe('agent_reply')
    expect((await new PolicyGate('tg', { group: 'off' }).evaluate(group(true))).kind).toBe('drop')
  })
})

describe('PolicyGate — handoff', () => {
  it('defers to a human when the thread is paused', async () => {
    const g = new PolicyGate('tg', { handoff: 'on-signal' }, { isPaused: () => true })
    expect((await g.evaluate(dm('u1'))).kind).toBe('defer_to_human')
  })
  it('ignores pause state when handoff is off', async () => {
    const g = new PolicyGate('tg', { handoff: 'off' }, { isPaused: () => true })
    expect((await g.evaluate(dm('u1'))).kind).toBe('agent_reply')
  })
})

describe('PolicyGate — LLM gate (fail-open)', () => {
  const skip: LlmGate = { shouldRespond: async () => false }
  const boom: LlmGate = {
    shouldRespond: async () => {
      throw new Error('gate down')
    },
  }
  it('drops when the LLM gate says skip', async () => {
    expect((await new PolicyGate('tg', { dm: 'open' }, { llmGate: skip }).evaluate(dm('u1'))).kind).toBe('drop')
  })
  it('fails OPEN — a gate error still answers (never goes silent)', async () => {
    expect((await new PolicyGate('tg', { dm: 'open' }, { llmGate: boom }).evaluate(dm('u1'))).kind).toBe('agent_reply')
  })
})
