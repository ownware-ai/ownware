/**
 * ShuttleAdapter — the base every channel builds on (SH1 + SH2).
 *
 * It owns the steps a messaging channel shares, so a channel (Telegram, Slack,
 * SMS…) only normalizes its platform's updates into a {@link ShuttleMessage}
 * and provides a {@link ChannelTransport}:
 *
 *   1. RECEIVE   the channel hands us a normalized ShuttleMessage
 *   2. GATE      decide WHETHER/HOW to answer → a reply disposition (SH2)
 *   3. DRIVE     key it (session-key oracle) → resolve the thread → POST /run
 *   4. DELIVER   tail the reply and send it back to the SOURCE (deterministic —
 *                the model never picks the channel), per the delivery mode
 */

import { sessionKey } from './session-key.js'
import { deliver } from './delivery.js'
import { Debouncer } from './debouncer.js'
import { PolicyGate, type LinePolicy, type ResponseGate, type LlmGate } from './gate.js'
import type { ChannelTransport, DeliveryPolicy, DeliveryResult, ReplyEvent } from './delivery.js'
import type { ShuttleMessage, GroupPolicy, ThreadMap } from './types.js'
import type { PairingStore } from './pairing.js'
import type { GatewayClient } from './gateway-client.js'

export interface ShuttleConfig {
  /** Which agent answers (profile slug). */
  readonly profileId: string
  /** Which channel this shuttle is (e.g. `telegram`). */
  readonly channel: string
  /** How the reply is delivered on this platform. */
  readonly delivery: DeliveryPolicy
  /** The access + response policy (personal ↔ business). */
  readonly line?: LinePolicy
  /** Back-compat shortcut for `line.group`. */
  readonly groupPolicy?: GroupPolicy
  /** Isolate each group participant into their own thread. Default false. */
  readonly groupPerUser?: boolean
  /** Coalesce rapid messages per person before answering (SH-deb). Off if omitted. */
  readonly debounce?: { readonly ms: number; readonly maxWaitMs?: number }
  /**
   * How long a pause-for-approval stays answerable from this chat
   * (ms). Mirrors the gateway's HITL window — after it, the gateway
   * has already denied the request, so the stale entry is dropped.
   * Default 30 minutes.
   */
  readonly approvalTtlMs?: number
}

export interface ShuttleDeps {
  readonly gateway: GatewayClient
  readonly threads: ThreadMap
  readonly transport: ChannelTransport
  /** Override the default policy gate entirely. */
  readonly gate?: ResponseGate
  /** Pairing store (required when `line.dm: 'pairing'`). */
  readonly pairing?: PairingStore
  /** Optional cheap LLM "is this for us?" pre-filter. */
  readonly llmGate?: LlmGate
  /** Whether a thread is handed off to a human right now. */
  readonly isPaused?: (msg: ShuttleMessage) => boolean | Promise<boolean>
}

/** One paused tool call awaiting a chat decision. */
interface PendingApproval {
  readonly threadId: string
  readonly requestId: string
  readonly toolName: string
  readonly expiresAt: number
}

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000

/** Chat replies that mean approve / deny. Normalized: trim + lowercase. */
const APPROVE_REPLIES = new Set(['yes', 'y', 'approve', 'approved', 'ok', '✅', '👍'])
const DENY_REPLIES = new Set(['no', 'n', 'deny', 'denied', 'reject', 'rejected', '❌', '👎'])

export class ShuttleAdapter {
  private readonly cursors = new Map<string, number>()
  private readonly gate: ResponseGate
  private readonly debouncer: Debouncer<ShuttleMessage> | undefined
  /**
   * Pause-for-approval state, per session key. A FIFO queue: the
   * loop asks serially for write tools, but parallel read-only calls
   * can raise several approvals at once — a reply answers the OLDEST,
   * then the next one is re-prompted.
   */
  private readonly pendingApprovals = new Map<string, PendingApproval[]>()

  constructor(
    private readonly config: ShuttleConfig,
    private readonly deps: ShuttleDeps,
  ) {
    this.gate =
      deps.gate ??
      new PolicyGate(
        config.channel,
        { ...(config.line ?? {}), group: config.line?.group ?? config.groupPolicy },
        {
          ...(deps.pairing ? { pairing: deps.pairing } : {}),
          ...(deps.llmGate ? { llmGate: deps.llmGate } : {}),
          ...(deps.isPaused ? { isPaused: deps.isPaused } : {}),
        },
      )
    this.debouncer = config.debounce
      ? new Debouncer<ShuttleMessage>(
          { debounceMs: config.debounce.ms, ...(config.debounce.maxWaitMs ? { maxWaitMs: config.debounce.maxWaitMs } : {}) },
          (_key, items) => this.processBatch(items),
        )
      : undefined
  }

  /** The canonical session key for a message (one thread per person). */
  keyFor(msg: ShuttleMessage): string {
    return sessionKey(
      {
        profile: this.config.profileId,
        channel: this.config.channel,
        chatType: msg.chatType,
        chatId: msg.chatId,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.userId ? { userId: msg.userId } : {}),
      },
      { groupPerUser: this.config.groupPerUser === true },
    )
  }

  /**
   * Handle one inbound message. With debounce configured, rapid messages from
   * the same person are buffered and answered once (this returns `null` and the
   * reply is delivered when the batch flushes). Otherwise it processes inline
   * and returns what was delivered (or `null` if the gate dropped it).
   */
  async handle(msg: ShuttleMessage): Promise<DeliveryResult | null> {
    if (!msg.text.trim()) return null
    // Approval interception runs BEFORE the debouncer — a "yes" must
    // answer the paused run now, never be coalesced into a prompt batch.
    if (await this.interceptApprovalReply(msg)) return null
    if (this.debouncer) {
      this.debouncer.push(this.keyFor(msg), msg)
      return null
    }
    return this.process(msg)
  }

  /**
   * While a run is paused on an approval for this chat, EVERY inbound
   * message is the decision surface: yes/no answers it; anything else
   * gets a one-line hint (the paused thread couldn't take a new prompt
   * anyway — the gateway 409s an active thread). Returns true when the
   * message was consumed here.
   */
  private async interceptApprovalReply(msg: ShuttleMessage): Promise<boolean> {
    const key = this.keyFor(msg)
    const queue = this.pendingApprovals.get(key)
    if (!queue || queue.length === 0) return false

    // Drop entries the gateway has already timed out server-side.
    const now = Date.now()
    while (queue.length > 0 && queue[0]!.expiresAt <= now) queue.shift()
    if (queue.length === 0) {
      this.pendingApprovals.delete(key)
      return false
    }

    const head = queue[0]!
    const reply = msg.text.trim().toLowerCase()
    const approved = APPROVE_REPLIES.has(reply)
    const denied = !approved && DENY_REPLIES.has(reply)

    if (!approved && !denied) {
      await this.deps.transport.sendText(
        msg.target,
        `The agent is paused waiting for your decision on "${head.toolName}". Reply "yes" to approve or "no" to deny.`,
      )
      return true
    }

    queue.shift()
    if (queue.length === 0) this.pendingApprovals.delete(key)

    try {
      await this.deps.gateway.resume(head.threadId, {
        action: approved ? 'approve' : 'deny',
        requestId: head.requestId,
      })
      await this.deps.transport.sendText(
        msg.target,
        approved ? `Approved — continuing.` : `Denied — the agent will work around it.`,
      )
    } catch (err) {
      // The decision channel failing must be VISIBLE — a silently lost
      // "yes" leaves the person believing they approved while the
      // gateway times the request out to deny.
      const detail = err instanceof Error ? err.message : String(err)
      await this.deps.transport.sendText(
        msg.target,
        `Could not deliver your decision (${detail}). The request will time out safely (denied).`,
      )
    }

    // More approvals queued behind this one → surface the next.
    const next = this.pendingApprovals.get(key)?.[0]
    if (next) {
      await this.deps.transport.sendText(
        msg.target,
        `Next: the agent also wants to run "${next.toolName}". Reply "yes" to approve or "no" to deny.`,
      )
    }
    return true
  }

  /** Gate → act on the disposition. The core per-message decision. */
  private async process(msg: ShuttleMessage): Promise<DeliveryResult | null> {
    const disposition = await this.gate.evaluate(msg)
    switch (disposition.kind) {
      case 'drop':
        return null
      case 'defer_to_human':
        // A person takes over this thread; the agent stays silent. SH8 fleshes
        // out notification/ack.
        return null
      case 'canned_reply': {
        const id = await this.deps.transport.sendText(msg.target, disposition.text)
        return { text: disposition.text, messageIds: id ? [id] : [], mode: 'final', chunks: 1 }
      }
      case 'agent_reply':
        return this.runAndDeliver(msg)
    }
  }

  /** Flush handler: combine a person's buffered messages into one and process. */
  private async processBatch(items: ShuttleMessage[]): Promise<void> {
    if (items.length === 0) return
    const last = items[items.length - 1]!
    const combined: ShuttleMessage = {
      ...last,
      text: items.map((m) => m.text).join('\n'),
      isMention: items.some((m) => m.isMention === true),
    }
    try {
      await this.process(combined)
    } catch {
      // A failed batch must not crash the debounce timer callback; per-message
      // agent/network errors are already surfaced as an error reply in deliver().
    }
  }

  /** The agent path: key → resolve/reuse thread → run → tail → deliver back. */
  private async runAndDeliver(msg: ShuttleMessage): Promise<DeliveryResult> {
    const key = this.keyFor(msg)

    const existing = await this.deps.threads.get(key)
    const { threadId } = await this.deps.gateway.run({
      profileId: this.config.profileId,
      prompt: msg.text,
      ...(existing ? { threadId: existing } : {}),
    })
    await this.deps.threads.set(key, threadId)

    const since = this.cursors.get(key) ?? 0
    let cursor = since
    const gateway = this.deps.gateway
    const transport = this.deps.transport
    const pending = this.pendingApprovals
    const ttl = this.config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    const target = msg.target
    async function* replyStream(): AsyncIterable<ReplyEvent> {
      for await (const ev of gateway.streamReply(threadId, { since })) {
        if (ev.seq > cursor) cursor = ev.seq
        if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
        else if (ev.type === 'permission') {
          // The run PAUSED on a human decision. Surface it on the chat
          // immediately — sendText directly, NOT via the delivery
          // pipeline: `typing+final` buffers until the run ends, and a
          // paused run never ends until this very question is answered.
          const entry: PendingApproval = {
            threadId,
            requestId: ev.requestId,
            toolName: ev.toolName,
            expiresAt: Date.now() + ttl,
          }
          const queue = pending.get(key)
          if (queue) queue.push(entry)
          else pending.set(key, [entry])
          await transport.sendText(
            target,
            `Approval needed: the agent wants to run "${ev.toolName}". ` +
              `${ev.reason} Reply "yes" to approve or "no" to deny.`,
          )
        } else if (ev.type === 'done') {
          // Terminal: anything still pending for this chat is stale
          // (the gateway resolved or timed the requests out).
          pending.delete(key)
          yield { type: 'done' }
        } else {
          pending.delete(key)
          yield { type: 'error', message: ev.message }
        }
      }
    }

    const result = await deliver(msg.target, replyStream(), this.deps.transport, this.config.delivery)
    this.cursors.set(key, cursor)
    return result
  }
}

export type { ShuttleMessage, GroupPolicy } from './types.js'
export type { ChannelTransport, DeliveryPolicy, DeliveryResult }
