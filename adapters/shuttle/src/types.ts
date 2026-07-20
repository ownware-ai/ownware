/**
 * Shuttle core types.
 *
 * A shuttle is a messaging channel adapter — a client of the ownware gateway
 * wire contract. It never runs the agent; it drives one over HTTP + SSE and
 * routes the reply back to the platform it came from. These are the shared
 * types every channel (Telegram, Slack, WhatsApp, SMS…) keys off.
 */

/**
 * The kind of chat a message arrived in. Determines session isolation:
 * - `dm`      — a 1:1 direct message (the chat id usually *is* the person)
 * - `group`   — a many-person group chat (Telegram/WhatsApp group)
 * - `channel` — a broadcast/workspace channel (Slack channel, Discord channel)
 */
export type ChatType = 'dm' | 'group' | 'channel'

const CHAT_TYPES: readonly ChatType[] = ['dm', 'group', 'channel']

/** Type guard for a raw string → ChatType. */
export function isChatType(value: string): value is ChatType {
  return (CHAT_TYPES as readonly string[]).includes(value)
}

/**
 * The parts that identify one conversation on one platform. Fed to
 * {@link sessionKey} to produce the canonical, stable key.
 */
export interface SessionKeyParts {
  /** Profile slug — WHICH agent (e.g. `acme-support`). */
  readonly profile: string
  /** Channel slug — WHICH platform (e.g. `telegram`, `slack`). */
  readonly channel: string
  /** The kind of chat. */
  readonly chatType: ChatType
  /** The platform's id for the chat (chat/group/channel id, or the sender in a DM). */
  readonly chatId: string
  /** Optional platform sub-thread (Slack `thread_ts`, Telegram topic, Discord thread). */
  readonly threadId?: string
  /** The sender's platform user id — used only when isolating group participants. */
  readonly userId?: string
}

/** Options controlling how a key is built. */
export interface SessionKeyOptions {
  /**
   * When true, each participant in a group/channel gets their own isolated
   * thread (the sender's `userId` is folded into the key). Default false —
   * a group is one shared conversation. Ignored for `dm`.
   */
  readonly groupPerUser?: boolean
}

/** When the agent answers in a group/channel. */
export type GroupPolicy = 'mention' | 'all' | 'off'

/** A platform message normalized by a channel adapter (the shuttle's inbound). */
export interface ShuttleMessage {
  readonly chatType: ChatType
  /** Platform id for the chat (group/channel id, or the sender in a DM). */
  readonly chatId: string
  /** Opaque platform destination the reply is routed back to (deterministic). */
  readonly target: string
  /** The user's text. */
  readonly text: string
  /** Platform sub-thread (Slack thread_ts, Telegram topic, Discord thread). */
  readonly threadId?: string
  /** Sender's platform user id (for group-per-user isolation + pairing/allowlist). */
  readonly userId?: string
  /** Was the agent @mentioned? (gates group/channel responses under `mention`). */
  readonly isMention?: boolean
  /**
   * UUID fencing one exact provider event at the Gateway run boundary.
   * Channel adapters set this only when the provider supplies a stable event
   * identity; it is not inferred from message text or participant identity.
   */
  readonly runIdempotencyKey?: string
  /** Frozen Gateway thread input paired with runIdempotencyKey; null means create. */
  readonly gatewayThreadId?: string | null
}

/**
 * Maps a stable session key → the ownware gateway `threadId` it resolved to.
 *
 * The gateway's `POST /run` has no notion of an external key: passing no
 * `threadId` creates a fresh thread. So a shuttle owns this mapping — it
 * looks up the key, reuses the thread if seen before, and remembers the
 * `threadId` the gateway returns on first contact. This is what keeps one
 * customer's conversation continuous across many messages, without touching
 * the engine.
 */
export interface ThreadMap {
  /** The threadId previously bound to this key, or undefined if never seen. */
  get(sessionKey: string): Promise<string | undefined>
  /** Bind a key to a gateway threadId (remember it for next time). */
  set(sessionKey: string, threadId: string): Promise<void>
  /** Forget a key (e.g. after `/new` or a reset). */
  delete(sessionKey: string): Promise<void>
}
