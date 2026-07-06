/**
 * TelegramShuttle — the Telegram channel, on the ShuttleAdapter base (SH3).
 *
 * Proof of the "adding a channel is a weekend" promise: this file is thin
 * because the base does the hard part. It wires a fetch-based Bot API client +
 * a TelegramTransport into a ShuttleAdapter, maps updates → ShuttleMessage,
 * and long-polls. The agent is a *bot identity* here (its @username); DMs go
 * straight to the agent, groups require an @mention (default policy).
 */

import { ShuttleAdapter, type ShuttleConfig, type ShuttleDeps } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ThreadMap, GroupPolicy, ShuttleMessage } from '../types.js'
import type { DeliveryPolicy } from '../delivery.js'
import type { LinePolicy, LlmGate } from '../gate.js'
import type { PairingStore } from '../pairing.js'
import type { GatewayClient } from '../gateway-client.js'
import { TelegramApi, type TgUpdate } from './api.js'
import { TelegramTransport } from './transport.js'
import { toShuttleMessage } from './message.js'

export interface TelegramShuttleOptions {
  /** Bot token (from @BotFather). SH1 part 3 will source this from the vault. */
  readonly token: string
  /** Which agent answers (profile slug). */
  readonly profileId: string
  /** How the shuttle reaches the agent. */
  readonly gateway: GatewayClient
  /** Thread map (default in-memory). */
  readonly threads?: ThreadMap
  /** Delivery mode (default `typing+final` — natural for Telegram). */
  readonly delivery?: DeliveryPolicy
  /** Access + response policy (personal ↔ business). */
  readonly line?: LinePolicy
  /** Group behavior (default `mention`). Back-compat shortcut for `line.group`. */
  readonly groupPolicy?: GroupPolicy
  /** Isolate each group participant into their own thread. */
  readonly groupPerUser?: boolean
  /** Pairing store (required when `line.dm: 'pairing'`). */
  readonly pairing?: PairingStore
  /** Optional cheap LLM "is this for us?" pre-filter. */
  readonly llmGate?: LlmGate
  /** Whether a thread is handed off to a human. */
  readonly isPaused?: (msg: ShuttleMessage) => boolean | Promise<boolean>
  /** Injected fetch (tests / custom TLS). */
  readonly fetch?: typeof fetch
  /** Bot API base override (tests / self-hosted). */
  readonly baseUrl?: string
  /** Bot @username. If omitted, resolved via getMe on start (needed for @mention). */
  readonly botUsername?: string
  /** Long-poll timeout in seconds (default 30). */
  readonly pollTimeoutSec?: number
}

const DEFAULT_DELIVERY: DeliveryPolicy = { mode: 'typing+final' }

export class TelegramShuttle {
  private readonly api: TelegramApi
  private readonly adapter: ShuttleAdapter
  private readonly transport: TelegramTransport
  private readonly pollTimeout: number
  private botUsername: string | undefined
  private running = false
  private offset = 0

  constructor(opts: TelegramShuttleOptions) {
    this.api = new TelegramApi({
      token: opts.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    })
    this.botUsername = opts.botUsername
    this.pollTimeout = opts.pollTimeoutSec ?? 30
    this.transport = new TelegramTransport(this.api)

    const config: ShuttleConfig = {
      profileId: opts.profileId,
      channel: 'telegram',
      delivery: opts.delivery ?? DEFAULT_DELIVERY,
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.groupPolicy ? { groupPolicy: opts.groupPolicy } : {}),
      ...(opts.groupPerUser ? { groupPerUser: opts.groupPerUser } : {}),
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

  /** Outbound push (schedule delivery): send `text` to a chat id. */
  async sendText(target: string, text: string): Promise<void> {
    await this.transport.sendText(target, text)
  }

  /** Resolve the bot's @username (needed for @mention detection in groups). */
  async ensureIdentity(): Promise<string | undefined> {
    if (!this.botUsername) {
      const me = await this.api.getMe()
      this.botUsername = me.username
    }
    return this.botUsername
  }

  /** Map + handle one update. Public so it's testable without polling. */
  async processUpdate(update: TgUpdate): Promise<void> {
    const msg = toShuttleMessage(update, this.botUsername)
    if (!msg) return
    try {
      await this.adapter.handle(msg)
    } catch (err) {
      // One bad message must not kill the poll loop.
      // eslint-disable-next-line no-console
      console.error('[shuttle:telegram] handle failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Start the long-poll loop. Resolves once {@link stop} is called. */
  async start(): Promise<void> {
    await this.ensureIdentity()
    this.running = true
    while (this.running) {
      let updates: TgUpdate[]
      try {
        updates = await this.api.getUpdates(this.offset, this.pollTimeout)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[shuttle:telegram] getUpdates failed:', err instanceof Error ? err.message : err)
        await sleep(1000)
        continue
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1)
        if (!this.running) break
        await this.processUpdate(u)
      }
    }
  }

  stop(): void {
    this.running = false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
