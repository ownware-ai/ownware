/**
 * One-process channels glue (Slice 7) — `bootChannels` wires shuttle's
 * ChannelRunner to a gateway without either package importing the other:
 * the module is injected here exactly like the runtime optional import.
 *
 * Contract under test:
 *   - runner is built against the gateway's own URL + token and started
 *   - the schedule-delivery sink is registered and routes through
 *     runner.deliver(); an undeliverable request THROWS (honest failure)
 *   - stop() unregisters the sink and stops the runner
 *   - missing @ownware/shuttle → null, no sink, no crash
 */
import { describe, it, expect } from 'vitest'
import { bootChannels } from '../../../src/cli/serve-channels.js'
import type { ShuttleChannelsModule } from '../../../src/cli/channel.js'
import type { OwnwareGateway } from '../../../src/gateway/server.js'
import type { ScheduleDeliverySink } from '../../../src/schedules/runner.js'

/** The two members bootChannels actually touches, stubbed. */
function fakeGateway(): {
  gateway: OwnwareGateway
  sinks: Array<ScheduleDeliverySink | null>
} {
  const sinks: Array<ScheduleDeliverySink | null> = []
  const gateway = {
    token: 'tok_test',
    setScheduleDeliverySink: (s: ScheduleDeliverySink | null): void => {
      sinks.push(s)
    },
  } as unknown as OwnwareGateway
  return { gateway, sinks }
}

function fakeModule(deliverResult: boolean): {
  mod: ShuttleChannelsModule
  seen: {
    runnerOpts: Record<string, unknown> | null
    delivered: Array<{ kind: string; target: string; text: string }>
    stopped: boolean
  }
} {
  const seen = {
    runnerOpts: null as Record<string, unknown> | null,
    delivered: [] as Array<{ kind: string; target: string; text: string }>,
    stopped: false,
  }
  class FakeRunner {
    constructor(_store: unknown, opts: Record<string, unknown>) {
      seen.runnerOpts = opts
    }
    async start(): Promise<string[]> {
      return ['slack-acme']
    }
    stop(): void {
      seen.stopped = true
    }
    async deliver(kind: string, target: string, text: string): Promise<boolean> {
      seen.delivered.push({ kind, target, text })
      return deliverResult
    }
  }
  class FakeStore {}
  class FakePairing {}
  const mod = {
    FileChannelStore: FakeStore,
    FilePairingStore: FakePairing,
    ChannelRunner: FakeRunner,
    runChannelCli: async (): Promise<string> => '',
  } as unknown as ShuttleChannelsModule
  return { mod, seen }
}

const delivery = {
  channel: 'slack',
  target: '#general',
  text: 'morning brief',
  scheduleId: 's1',
  scheduleName: 'morning',
  runId: 'r1',
  profileId: 'assistant',
  runStatus: 'succeeded',
} as const

describe('bootChannels', () => {
  it('builds the runner on the gateway URL+token, starts it, registers the sink', async () => {
    const { gateway, sinks } = fakeGateway()
    const { mod, seen } = fakeModule(true)

    const channels = await bootChannels({
      gateway,
      gatewayUrl: 'http://127.0.0.1:3011',
      dataDir: '/tmp/never-used-by-fakes',
      loader: async () => mod,
    })

    expect(channels?.started).toEqual(['slack-acme'])
    expect(seen.runnerOpts).toMatchObject({
      gatewayUrl: 'http://127.0.0.1:3011',
      gatewayToken: 'tok_test',
    })
    expect(sinks).toHaveLength(1)

    await sinks[0]!(delivery)
    expect(seen.delivered).toEqual([{ kind: 'slack', target: '#general', text: 'morning brief' }])
  })

  it('an undeliverable push throws so the schedule ledger records failed-to-deliver', async () => {
    const { gateway, sinks } = fakeGateway()
    const { mod } = fakeModule(false)

    await bootChannels({
      gateway,
      gatewayUrl: 'http://127.0.0.1:3011',
      dataDir: '/tmp/x',
      loader: async () => mod,
    })
    await expect(sinks[0]!(delivery)).rejects.toThrow(/no running 'slack' channel/)
  })

  it('stop() unregisters the sink and stops the runner', async () => {
    const { gateway, sinks } = fakeGateway()
    const { mod, seen } = fakeModule(true)

    const channels = await bootChannels({
      gateway,
      gatewayUrl: 'http://127.0.0.1:3011',
      dataDir: '/tmp/x',
      loader: async () => mod,
    })
    channels!.stop()
    expect(seen.stopped).toBe(true)
    expect(sinks).toEqual([expect.any(Function), null]) // registered, then cleared
  })

  it('missing @ownware/shuttle → null, nothing registered', async () => {
    const { gateway, sinks } = fakeGateway()
    const channels = await bootChannels({
      gateway,
      gatewayUrl: 'http://127.0.0.1:3011',
      dataDir: '/tmp/x',
      loader: async () => null,
    })
    expect(channels).toBeNull()
    expect(sinks).toHaveLength(0)
  })
})
