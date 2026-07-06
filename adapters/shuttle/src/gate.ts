/**
 * The response gate (SH2) — the mandatory stage BEFORE `POST /run` that decides
 * WHETHER and HOW to answer. Learned from the omni/omniagent study: omni ships a
 * working two-tier gate; omniagent defined a gate but never wired it (every
 * message hit the LLM). The lesson: the gate is a required stage, not an optional
 * library.
 *
 * It returns a reply DISPOSITION, which the base acts on:
 *   agent_reply     run the agent (the normal path)
 *   canned_reply    send a fixed message, no LLM (pairing code, out-of-office…)
 *   drop            silently ignore (unmentioned group, not on allowlist, spam)
 *   defer_to_human  a person takes over this thread (handoff)
 *
 * Keyed on the message + the line's policy (personal ↔ business).
 */

import type { ShuttleMessage, GroupPolicy } from './types.js'
import type { PairingStore } from './pairing.js'
import { PairingRateLimitError } from './pairing.js'

export type Disposition =
  | { readonly kind: 'agent_reply' }
  | { readonly kind: 'canned_reply'; readonly text: string }
  | { readonly kind: 'drop'; readonly reason: string }
  | { readonly kind: 'defer_to_human'; readonly reason: string }

/** Who may start a DM. `open` = business line; `pairing`/`allowlist` = personal/closed. */
export type DmPolicy = 'open' | 'pairing' | 'allowlist'
export type HandoffPolicy = 'off' | 'on-request' | 'on-signal'

/** The access + response policy for one line (personal vs business). */
export interface LinePolicy {
  /** DM access. Default `open`. Personal lines set `pairing`. */
  readonly dm?: DmPolicy
  /** Group/channel answering. Default `mention`. */
  readonly group?: GroupPolicy
  /** Allowed user ids when `dm: 'allowlist'`. */
  readonly allowlist?: readonly string[]
  /** Human handoff. Default `off`. */
  readonly handoff?: HandoffPolicy
}

/** Optional cheap "is this message even for us?" pre-filter (business/group lines). */
export interface LlmGate {
  shouldRespond(msg: ShuttleMessage): Promise<boolean>
}

export interface ResponseGate {
  evaluate(msg: ShuttleMessage): Promise<Disposition>
}

export interface PolicyGateDeps {
  /** Required when `dm: 'pairing'`. */
  readonly pairing?: PairingStore
  /** Optional cheap LLM pre-filter (business/group lines). */
  readonly llmGate?: LlmGate
  /** Whether this thread is currently handed off to a human. */
  readonly isPaused?: (msg: ShuttleMessage) => boolean | Promise<boolean>
}

function pairingInstructions(channel: string, code: string): string {
  return `🔑 Your pairing code: ${code}\nAsk the owner to approve you:\n  ownware channel approve ${channel} ${code}`
}

/** The default gate: deterministic policy checks, then an optional fail-open LLM gate. */
export class PolicyGate implements ResponseGate {
  constructor(
    private readonly channel: string,
    private readonly policy: LinePolicy,
    private readonly deps: PolicyGateDeps = {},
  ) {}

  async evaluate(msg: ShuttleMessage): Promise<Disposition> {
    // 1. Handoff — a paused thread waits for a person.
    if ((this.policy.handoff ?? 'off') !== 'off' && this.deps.isPaused) {
      if (await this.deps.isPaused(msg)) return { kind: 'defer_to_human', reason: 'thread paused for human' }
    }

    // 2. Group / channel — gate on @mention (support channels can use `all`).
    if (msg.chatType !== 'dm') {
      const group = this.policy.group ?? 'mention'
      if (group === 'off') return { kind: 'drop', reason: 'group policy off' }
      if (group === 'mention' && msg.isMention !== true) return { kind: 'drop', reason: 'not mentioned' }
    } else {
      // 3. DM access — open (business) / pairing (personal) / allowlist.
      const dm = this.policy.dm ?? 'open'
      const userId = msg.userId ?? msg.chatId
      if (dm === 'allowlist') {
        if (!(this.policy.allowlist ?? []).includes(userId)) return { kind: 'drop', reason: 'not in allowlist' }
      } else if (dm === 'pairing') {
        if (!this.deps.pairing) return { kind: 'drop', reason: 'pairing required but no store configured' }
        if (!(await this.deps.pairing.isApproved(this.channel, userId))) {
          try {
            const code = await this.deps.pairing.requestCode(this.channel, userId)
            return { kind: 'canned_reply', text: pairingInstructions(this.channel, code) }
          } catch (err) {
            if (err instanceof PairingRateLimitError) {
              return { kind: 'canned_reply', text: 'You already have a pending pairing code — ask the owner to approve it.' }
            }
            throw err
          }
        }
      }
      // dm === 'open' → fall through
    }

    // 4. Optional cheap LLM gate — fail-open (never go silent on a gate error).
    if (this.deps.llmGate) {
      let should = true
      try {
        should = await this.deps.llmGate.shouldRespond(msg)
      } catch {
        should = true
      }
      if (!should) return { kind: 'drop', reason: 'llm gate: not for us' }
    }

    return { kind: 'agent_reply' }
  }
}
