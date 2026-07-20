import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileChannelStore, InMemoryChannelStore } from '../channels/store.js'
import { validateChannelConfig, type ChannelConfig } from '../channels/config.js'
import { ChannelRunner, type RunnableShuttle } from '../channels/runner.js'
import { runChannelCli, channelAdd } from '../channels/cli.js'
import { InMemoryPairingStore } from '../pairing.js'
import { InMemoryWhatsAppDeliveryStore } from '../whatsapp/delivery-store.js'
import type { GatewayClient, RunInput, RunStreamEvent, StreamReplyOptions } from '../gateway-client.js'

const tgConfig = (id: string, enabled = true): ChannelConfig => ({
  id,
  channel: 'telegram',
  profileId: 'acme',
  credentials: { token: '123:secret-bot-token' },
  enabled,
})

describe('validateChannelConfig', () => {
  it('accepts a valid config, rejects missing creds / profile', () => {
    expect(validateChannelConfig(tgConfig('t1'))).toBeNull()
    expect(validateChannelConfig({ ...tgConfig('t1'), credentials: {} })).toMatch(/token/)
    expect(validateChannelConfig({ ...tgConfig('t1'), profileId: '' })).toMatch(/profileId/)
    expect(validateChannelConfig({ ...tgConfig('t1'), channel: 'nope' as never })).toMatch(/unknown channel/)
    expect(validateChannelConfig({
      id: 'wa1',
      channel: 'whatsapp',
      profileId: 'acme',
      credentials: { accessToken: 'token', phoneNumberId: 'pid' },
    })).toMatch(/appSecret/)
  })
})

describe('FileChannelStore — the encrypted vault', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ownware-ch-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips put/get/list/remove', async () => {
    const store = new FileChannelStore({ dir })
    await store.put(tgConfig('t1'))
    await store.put(tgConfig('t2'))
    expect((await store.list()).map((c) => c.id).sort()).toEqual(['t1', 't2'])
    expect((await store.get('t1'))?.credentials['token']).toBe('123:secret-bot-token')
    await store.remove('t1')
    expect(await store.get('t1')).toBeUndefined()
    expect(await store.list()).toHaveLength(1)
  })

  it('stores tokens ENCRYPTED (the secret never appears in the file bytes)', async () => {
    const store = new FileChannelStore({ dir, secret: 'master' })
    await store.put(tgConfig('t1'))
    const bytes = readFileSync(join(dir, 'channels.enc'))
    expect(bytes.includes(Buffer.from('secret-bot-token'))).toBe(false)
    expect(bytes.includes(Buffer.from('123:secret'))).toBe(false)
  })

  it('persists across instances (same secret → readable)', async () => {
    await new FileChannelStore({ dir, secret: 'master' }).put(tgConfig('t1'))
    const reopened = new FileChannelStore({ dir, secret: 'master' })
    expect((await reopened.get('t1'))?.credentials['token']).toBe('123:secret-bot-token')
  })
})

describe('InMemoryChannelStore', () => {
  it('basic put/get/remove', async () => {
    const s = new InMemoryChannelStore()
    await s.put(tgConfig('t1'))
    expect(await s.get('t1')).toBeTruthy()
    await s.remove('t1')
    expect(await s.get('t1')).toBeUndefined()
  })
})

// ── ChannelRunner ────────────────────────────────────────────────────────────

class FakeShuttle implements RunnableShuttle {
  started = false
  stopped = false
  sent: Array<{ target: string; text: string }> = []
  async start(): Promise<void> {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  async sendText(target: string, text: string): Promise<void> {
    this.sent.push({ target, text })
  }
}

/** A shuttle without outbound push (sendText absent). */
class ListenOnlyShuttle implements RunnableShuttle {
  async start(): Promise<void> {}
  stop(): void {}
}

class MockGateway implements GatewayClient {
  async run(_i: RunInput): Promise<{ threadId: string }> {
    return { threadId: 't' }
  }
  async *streamReply(_t: string, _o: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    yield { type: 'done', seq: 1 }
  }
}

describe('ChannelRunner', () => {
  it('starts enabled channels via the factory; skips webhook (null) channels', async () => {
    const store = new InMemoryChannelStore()
    await store.put(tgConfig('t1'))
    await store.put({ id: 'wa1', channel: 'whatsapp', profileId: 'acme', credentials: { accessToken: 'x', phoneNumberId: 'p' } })
    const made = new Map<string, FakeShuttle>()
    const runner = new ChannelRunner(store, {
      gateway: new MockGateway(),
      factory: (c) => {
        if (c.channel === 'whatsapp') return null // webhook — not self-driving
        const s = new FakeShuttle()
        made.set(c.id, s)
        return s
      },
    })
    const started = await runner.start()
    expect(started).toEqual(['t1'])
    expect(made.get('t1')?.started).toBe(true)
    expect(runner.activeIds).toEqual(['t1'])
  })

  it('reload() starts newly-added and stops removed channels (no restart)', async () => {
    const store = new InMemoryChannelStore()
    await store.put(tgConfig('t1'))
    const made = new Map<string, FakeShuttle>()
    const runner = new ChannelRunner(store, {
      gateway: new MockGateway(),
      factory: (c) => {
        const s = new FakeShuttle()
        made.set(c.id, s)
        return s
      },
    })
    await runner.start()

    await store.put(tgConfig('t2')) // add
    await store.remove('t1') // remove
    const { started, stopped } = await runner.reload()
    expect(started).toEqual(['t2'])
    expect(stopped).toEqual(['t1'])
    expect(made.get('t1')?.stopped).toBe(true)
    expect(made.get('t2')?.started).toBe(true)
  })

  it('deliver() routes by channel kind to the first running shuttle that can send', async () => {
    const store = new InMemoryChannelStore()
    await store.put(tgConfig('t1'))
    await store.put({
      id: 's1',
      channel: 'slack',
      profileId: 'acme',
      credentials: { botToken: 'xoxb', appToken: 'xapp' },
    })
    const made = new Map<string, FakeShuttle>()
    const runner = new ChannelRunner(store, {
      gateway: new MockGateway(),
      factory: (c) => {
        const s = new FakeShuttle()
        made.set(c.id, s)
        return s
      },
    })
    await runner.start()

    expect(await runner.deliver('slack', '#general', 'morning brief')).toBe(true)
    expect(made.get('s1')?.sent).toEqual([{ target: '#general', text: 'morning brief' }])
    expect(made.get('t1')?.sent).toEqual([]) // kind routing — telegram untouched

    expect(await runner.deliver('telegram', '12345', 'ping')).toBe(true)
    expect(made.get('t1')?.sent).toEqual([{ target: '12345', text: 'ping' }])
  })

  it('deliver() returns false when no running channel of that kind can send', async () => {
    const store = new InMemoryChannelStore()
    await store.put(tgConfig('t1'))
    const runner = new ChannelRunner(store, {
      gateway: new MockGateway(),
      factory: () => new ListenOnlyShuttle(), // running, but cannot send
    })
    await runner.start()

    expect(await runner.deliver('slack', '#general', 'x')).toBe(false) // no such kind
    expect(await runner.deliver('telegram', '12345', 'x')).toBe(false) // kind exists, no sendText
  })
})

// ── CLI ──────────────────────────────────────────────────────────────────────

describe('runChannelCli', () => {
  it('add telegram stores a validated config', async () => {
    const store = new InMemoryChannelStore()
    const out = await runChannelCli(['add', 'telegram', '--profile', 'acme', '--token', '123:abc'], store)
    expect(out).toContain('added channel "telegram-acme"')
    expect((await store.get('telegram-acme'))?.credentials['token']).toBe('123:abc')
  })

  it('add slack maps --bot-token/--app-token to the right cred keys', async () => {
    const store = new InMemoryChannelStore()
    await runChannelCli(['add', 'slack', '--profile', 'acme', '--bot-token', 'xoxb-1', '--app-token', 'xapp-1'], store)
    expect((await store.get('slack-acme'))?.credentials).toEqual({ botToken: 'xoxb-1', appToken: 'xapp-1' })
  })

  it('add applies the --line business preset (dm open)', async () => {
    const store = new InMemoryChannelStore()
    await runChannelCli(['add', 'telegram', '--profile', 'acme', '--token', 't', '--line', 'business'], store)
    expect((await store.get('telegram-acme'))?.line).toEqual({ dm: 'open' })
  })

  it('enables WhatsApp handoff only through the explicit on-request policy', async () => {
    const store = new InMemoryChannelStore()
    await runChannelCli([
      'add', 'whatsapp', '--profile', 'acme',
      '--access-token', 'token', '--phone-number-id', 'pid',
      '--app-secret', 'secret', '--verify-token', 'verify',
      '--line', 'business', '--handoff', 'on-request',
    ], store)
    expect((await store.get('whatsapp-acme'))?.line).toEqual({ dm: 'open', handoff: 'on-request' })
  })

  it('add rejects a missing credential', async () => {
    const store = new InMemoryChannelStore()
    await expect(runChannelCli(['add', 'telegram', '--profile', 'acme'], store)).rejects.toThrow(/token/)
  })

  it('list and remove', async () => {
    const store = new InMemoryChannelStore()
    await channelAdd(store, { channel: 'telegram', profileId: 'acme', credentials: { token: 't' } })
    expect(await runChannelCli(['list'], store)).toContain('telegram-acme')
    expect(await runChannelCli(['remove', 'telegram-acme'], store)).toContain('removed')
    expect(await runChannelCli(['list'], store)).toContain('no channels')
  })

  it('approve redeems a minted pairing code (the command the gate advertises)', async () => {
    const store = new InMemoryChannelStore()
    const pairing = new InMemoryPairingStore({ generateCode: () => 'CODE1234' })
    const code = await pairing.requestCode('telegram', 'u42')
    const out = await runChannelCli(['approve', 'telegram', code], store, { pairing })
    expect(out).toContain('approved u42 on telegram')
    expect(await pairing.isApproved('telegram', 'u42')).toBe(true)
  })

  it('approve reports an unrecognized code without approving', async () => {
    const store = new InMemoryChannelStore()
    const pairing = new InMemoryPairingStore()
    const out = await runChannelCli(['approve', 'telegram', 'WRONG999'], store, { pairing })
    expect(out).toContain('not recognized')
  })

  it('approve without a pairing store fails loudly', async () => {
    const store = new InMemoryChannelStore()
    await expect(runChannelCli(['approve', 'telegram', 'X'], store)).rejects.toThrow(/pairing store/)
  })

  it('lists, accepts and resumes an explicit WhatsApp handoff', async () => {
    const store = new InMemoryChannelStore()
    const delivery = new InMemoryWhatsAppDeliveryStore()
    const inbound = delivery.enqueue({
      channelId: 'whatsapp-acme',
      phoneNumberId: 'PID',
      inboundId: 'wamid.H',
      from: '15550001111',
      text: '/human',
    }).record
    delivery.claim(inbound.key)
    const handoff = delivery.requestHandoff(inbound.key)

    expect(await runChannelCli(['handoff', 'list'], store, { whatsappDelivery: delivery }))
      .toContain(handoff.requestId)
    expect(await runChannelCli(['handoff', 'accept', handoff.requestId], store, { whatsappDelivery: delivery }))
      .toContain('agent remains paused')
    expect(await runChannelCli(['handoff', 'resume', handoff.requestId], store, { whatsappDelivery: delivery }))
      .toContain('only future messages')
  })

  it('shows truthful WhatsApp delivery states without customer text', async () => {
    const store = new InMemoryChannelStore()
    const delivery = new InMemoryWhatsAppDeliveryStore()
    const inbound = delivery.enqueue({
      channelId: 'whatsapp-acme',
      phoneNumberId: 'PID',
      inboundId: 'wamid.UNKNOWN',
      from: '15550001111',
      text: 'PRIVATE CUSTOMER ORDER',
    }).record
    delivery.claim(inbound.key)
    const attempt = delivery.prepareAttempt(inbound.key, inbound.from, 'PRIVATE REPLY')
    delivery.markAttemptUnknown(inbound.key, attempt.attemptId, 'transport_error')
    delivery.finishFailure(inbound.key)

    const output = await runChannelCli(['delivery', 'list'], store, { whatsappDelivery: delivery })
    expect(output).toContain('wamid.UNKNOWN')
    expect(output).toContain('delivery_unknown')
    expect(output).toContain('transport_error')
    expect(output).not.toContain('PRIVATE CUSTOMER ORDER')
    expect(output).not.toContain('PRIVATE REPLY')
    expect(output).not.toContain('15550001111')
  })
})
