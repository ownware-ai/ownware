/**
 * DiscordShuttle — the Discord channel via the gateway WebSocket (SH6).
 *
 * The agent is a bot member; DMs go straight to it, servers require @mention.
 * Inbound is the gateway WS (HELLO → IDENTIFY → heartbeat → MESSAGE_CREATE);
 * replies go out via REST. `processMessage` is public so mapping+dispatch is
 * testable without a live socket; `start()` runs the real gateway loop.
 *
 * NOTE: the WS loop uses the global `WebSocket` (Node ≥ 22) and needs the
 * privileged MESSAGE_CONTENT intent enabled in the Discord dev portal to read
 * message text. Exercised by a live pass, not unit tests.
 */

import { ShuttleAdapter, type ShuttleConfig, type ShuttleDeps } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ThreadMap, GroupPolicy, ShuttleMessage } from '../types.js'
import type { DeliveryPolicy } from '../delivery.js'
import type { LinePolicy, LlmGate } from '../gate.js'
import type { PairingStore } from '../pairing.js'
import type { GatewayClient } from '../gateway-client.js'
import { DiscordApi } from './api.js'
import { DiscordTransport } from './transport.js'
import { toShuttleMessage, type DiscordMessageCreate } from './message.js'

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

export interface DiscordShuttleOptions {
  readonly token: string
  readonly profileId: string
  readonly gateway: GatewayClient
  readonly threads?: ThreadMap
  /** Default `typing+final`. */
  readonly delivery?: DeliveryPolicy
  readonly line?: LinePolicy
  readonly groupPolicy?: GroupPolicy
  readonly pairing?: PairingStore
  readonly llmGate?: LlmGate
  readonly isPaused?: (msg: ShuttleMessage) => boolean | Promise<boolean>
  readonly debounce?: { readonly ms: number; readonly maxWaitMs?: number }
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  /** Bot user id; resolved from the READY dispatch on start if omitted. */
  readonly botUserId?: string
}

const DEFAULT_DELIVERY: DeliveryPolicy = { mode: 'typing+final' }

export class DiscordShuttle {
  private readonly api: DiscordApi
  private readonly adapter: ShuttleAdapter
  private readonly transport: DiscordTransport
  private readonly token: string
  private botUserId: string | undefined
  private ws: WebSocket | undefined
  private running = false
  private seq: number | null = null
  private hbTimer: ReturnType<typeof setInterval> | undefined

  constructor(opts: DiscordShuttleOptions) {
    this.token = opts.token
    this.api = new DiscordApi({
      token: opts.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    })
    this.botUserId = opts.botUserId
    this.transport = new DiscordTransport(this.api)

    const config: ShuttleConfig = {
      profileId: opts.profileId,
      channel: 'discord',
      delivery: opts.delivery ?? DEFAULT_DELIVERY,
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.groupPolicy ? { groupPolicy: opts.groupPolicy } : {}),
      ...(opts.debounce ? { debounce: opts.debounce } : {}),
    }
    const deps: ShuttleDeps = {
      gateway: opts.gateway,
      threads: opts.threads ?? new InMemoryThreadMap(),
      transport: this.transport,
      ...(opts.pairing ? { pairing: opts.pairing } : {}),
      ...(opts.llmGate ? { llmGate: opts.llmGate } : {}),
      ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
    }
    this.adapter = new ShuttleAdapter(config, deps)
  }

  /** Outbound push (schedule delivery): send `text` to a channel id. */
  async sendText(target: string, text: string): Promise<void> {
    await this.transport.sendText(target, text)
  }

  /** Map + handle one MESSAGE_CREATE. Public for testing without a live socket. */
  async processMessage(d: DiscordMessageCreate): Promise<void> {
    const msg = toShuttleMessage(d, this.botUserId)
    if (!msg) return
    try {
      await this.adapter.handle(msg)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[shuttle:discord] handle failed:', err instanceof Error ? err.message : err)
    }
  }

  async start(): Promise<void> {
    this.running = true
    const url = await this.api.getGatewayUrl()
    this.connect(url)
  }

  private connect(url: string): void {
    const ws = new WebSocket(`${url}/?v=10&encoding=json`)
    this.ws = ws
    ws.addEventListener('message', (ev: MessageEvent) => {
      let payload: { op?: number; t?: string; s?: number | null; d?: Record<string, unknown> }
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (typeof payload.s === 'number') this.seq = payload.s

      if (payload.op === 10) {
        // HELLO → start heartbeat + IDENTIFY
        const interval = (payload.d?.['heartbeat_interval'] as number) ?? 41250
        this.startHeartbeat(interval)
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token: this.token, intents: INTENTS, properties: { os: 'linux', browser: 'ownware', device: 'ownware' } },
          }),
        )
      } else if (payload.op === 0) {
        // DISPATCH
        if (payload.t === 'READY') {
          const user = payload.d?.['user'] as { id?: string } | undefined
          if (user?.id) this.botUserId = user.id
        } else if (payload.t === 'MESSAGE_CREATE') {
          void this.processMessage((payload.d ?? {}) as DiscordMessageCreate)
        }
      }
      // op 11 = heartbeat ack (no-op)
    })
    ws.addEventListener('close', () => {
      this.stopHeartbeat()
      if (this.running) void this.reconnect()
    })
    ws.addEventListener('error', () => {
      /* the close handler drives reconnect */
    })
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.seq }))
    }, intervalMs)
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = undefined
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return
    try {
      const url = await this.api.getGatewayUrl()
      this.connect(url)
    } catch {
      /* give up until next start() */
    }
  }

  stop(): void {
    this.running = false
    this.stopHeartbeat()
    this.ws?.close()
  }
}
