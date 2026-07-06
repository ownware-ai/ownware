/**
 * ChannelRunner — starts the connected channels from the store against a
 * running gateway (SH1 part 3). This is the "always-on" process that hosts the
 * channels: read the store → build each shuttle → start it. `reload()` diffs
 * the store vs what's running so adding/removing a channel takes effect WITHOUT
 * a restart (the deploy-once, connect-at-runtime model).
 *
 * Self-driving channels (telegram/slack/discord) start here; webhook channels
 * (whatsapp/sms) return null (they mount on an HTTP endpoint separately).
 */

import { HttpGatewayClient, type GatewayClient } from '../gateway-client.js'
import { TelegramShuttle } from '../telegram/shuttle.js'
import { SlackShuttle } from '../slack/shuttle.js'
import { DiscordShuttle } from '../discord/shuttle.js'
import type { PairingStore } from '../pairing.js'
import type { ChannelConfig } from './config.js'
import type { ChannelStore } from './store.js'

export interface RunnableShuttle {
  start(): Promise<void>
  stop(): void
  /** Outbound push (schedule delivery). Optional — webhook channels may lack it. */
  sendText?(target: string, text: string): Promise<void>
}

export interface ShuttleFactoryDeps {
  /** Pairing store for personal lines (`line.dm: 'pairing'`). */
  readonly pairing?: PairingStore
}

export type ShuttleFactory = (
  config: ChannelConfig,
  gateway: GatewayClient,
  deps?: ShuttleFactoryDeps,
) => RunnableShuttle | null

function cred(config: ChannelConfig, key: string): string {
  const v = config.credentials[key]
  if (!v) throw new Error(`channel "${config.id}" missing credential: ${key}`)
  return v
}

/** Default factory: the self-driving channels. Webhook channels return null. */
export function defaultShuttleFactory(
  config: ChannelConfig,
  gateway: GatewayClient,
  deps: ShuttleFactoryDeps = {},
): RunnableShuttle | null {
  const line = config.line ? { line: config.line } : {}
  // Pairing rides along unconditionally — the gate only consults it when
  // the channel's dm policy is 'pairing', and without it that policy
  // fail-closes to dropping every DM (gate: "pairing required but no
  // store configured").
  const pairing = deps.pairing ? { pairing: deps.pairing } : {}
  switch (config.channel) {
    case 'telegram':
      return new TelegramShuttle({ token: cred(config, 'token'), profileId: config.profileId, gateway, ...line, ...pairing })
    case 'slack':
      return new SlackShuttle({
        botToken: cred(config, 'botToken'),
        appToken: cred(config, 'appToken'),
        profileId: config.profileId,
        gateway,
        ...line,
        ...pairing,
      })
    case 'discord':
      return new DiscordShuttle({ token: cred(config, 'token'), profileId: config.profileId, gateway, ...line, ...pairing })
    default:
      return null // whatsapp / sms are webhook-based — mounted on an HTTP server
  }
}

export interface ChannelRunnerOptions {
  readonly gateway?: GatewayClient
  readonly gatewayUrl?: string
  readonly gatewayToken?: string
  readonly factory?: ShuttleFactory
  /** Pairing store handed to the factory (personal-line channels). */
  readonly pairing?: PairingStore
}

export class ChannelRunner {
  private readonly running = new Map<string, { kind: string; shuttle: RunnableShuttle }>()
  private readonly gateway: GatewayClient
  private readonly factory: ShuttleFactory
  private readonly factoryDeps: ShuttleFactoryDeps

  constructor(
    private readonly store: ChannelStore,
    opts: ChannelRunnerOptions = {},
  ) {
    this.gateway =
      opts.gateway ??
      new HttpGatewayClient({
        baseUrl: opts.gatewayUrl ?? 'http://127.0.0.1:3011',
        ...(opts.gatewayToken ? { token: opts.gatewayToken } : {}),
      })
    this.factory = opts.factory ?? defaultShuttleFactory
    this.factoryDeps = opts.pairing ? { pairing: opts.pairing } : {}
  }

  /** Start every enabled, self-driving channel. Returns the ids started. */
  async start(): Promise<string[]> {
    const started: string[] = []
    for (const config of await this.enabledConfigs()) {
      if (this.running.has(config.id)) continue
      const shuttle = this.factory(config, this.gateway, this.factoryDeps)
      if (!shuttle) continue
      this.running.set(config.id, { kind: config.channel, shuttle })
      void shuttle.start()
      started.push(config.id)
    }
    return started
  }

  /** Diff the store vs running: start newly-added, stop removed/disabled. No restart. */
  async reload(): Promise<{ started: string[]; stopped: string[] }> {
    const wanted = new Map((await this.enabledConfigs()).map((c) => [c.id, c]))
    const started: string[] = []
    const stopped: string[] = []

    for (const [id, entry] of this.running) {
      if (!wanted.has(id)) {
        entry.shuttle.stop()
        this.running.delete(id)
        stopped.push(id)
      }
    }
    for (const [id, config] of wanted) {
      if (this.running.has(id)) continue
      const shuttle = this.factory(config, this.gateway, this.factoryDeps)
      if (!shuttle) continue
      this.running.set(id, { kind: config.channel, shuttle })
      void shuttle.start()
      started.push(id)
    }
    return { started, stopped }
  }

  /**
   * Outbound push (schedule delivery): send `text` to `target` on the first
   * running channel of `kind` (e.g. 'slack' → a channel/DM id). Returns false
   * when no running channel of that kind can send — the caller decides whether
   * that's an error (a schedule that asked for it) or a quiet no-op.
   */
  async deliver(kind: string, target: string, text: string): Promise<boolean> {
    for (const entry of this.running.values()) {
      if (entry.kind !== kind || typeof entry.shuttle.sendText !== 'function') continue
      await entry.shuttle.sendText(target, text)
      return true
    }
    return false
  }

  stop(): void {
    for (const entry of this.running.values()) entry.shuttle.stop()
    this.running.clear()
  }

  get activeIds(): string[] {
    return [...this.running.keys()]
  }

  private async enabledConfigs(): Promise<ChannelConfig[]> {
    return (await this.store.list()).filter((c) => c.enabled !== false)
  }
}
