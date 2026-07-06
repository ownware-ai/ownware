/**
 * Delivery — HOW a reply comes out on a messaging channel (SH1).
 *
 * The agent produces a token STREAM. A rich web UI shows it live; a messaging
 * channel collects it and sends a MESSAGE. This module owns that translation
 * so every channel gets it for free — a channel only supplies a
 * {@link ChannelTransport} (how to send/edit/type on its platform) and a mode.
 *
 * Modes:
 *   final          collect the whole reply → send one message
 *   typing+final   show a typing indicator while it works → send one message
 *   edit-stream    send a placeholder → edit it as text arrives (looks live)
 *   chunked        (composes) split a long reply across messages at the limit
 *
 * A mode gracefully degrades to what the platform supports (edit-stream on a
 * platform that can't edit → typing+final; typing on one that can't → final).
 */

/** How a reply is delivered. `chunked` is expressed via {@link DeliveryPolicy.maxChars}. */
export type DeliveryMode = 'final' | 'typing+final' | 'edit-stream'

/** One event from the agent's reply stream (a GatewayClient produces these). */
export type ReplyEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string }

/**
 * What a channel supplies so the base can deliver a reply on its platform.
 * `target` is the platform's opaque destination (chat id, channel, number).
 */
export interface ChannelTransport {
  /** Platform message length limit (SMS ~160, Telegram 4096, Discord 2000…). */
  readonly maxChars: number
  /** Can an already-sent message be edited? (enables edit-stream) */
  readonly supportsEdit: boolean
  /** Can a "typing…" indicator be shown? */
  readonly supportsTyping: boolean
  /** Send a message; return a message id when the platform gives one (needed for editing). */
  sendText(target: string, text: string): Promise<string | undefined>
  /** Edit a previously-sent message (only called when supportsEdit). */
  editText(target: string, messageId: string, text: string): Promise<void>
  /** Show a typing indicator (only called when supportsTyping). */
  sendTyping(target: string): Promise<void>
}

/** Per-delivery settings. */
export interface DeliveryPolicy {
  readonly mode: DeliveryMode
  /** Chunk threshold; defaults to the transport's `maxChars`. */
  readonly maxChars?: number
  /** edit-stream: re-edit once accumulated text has grown by this many chars. Default 60. */
  readonly editThrottleChars?: number
}

/** What actually happened (effective mode after capability fallback). */
export interface DeliveryResult {
  readonly text: string
  readonly messageIds: string[]
  readonly mode: DeliveryMode
  readonly chunks: number
}

/** Reduce the requested mode to what the platform can actually do. */
export function resolveMode(mode: DeliveryMode, transport: ChannelTransport): DeliveryMode {
  if (mode === 'edit-stream' && !transport.supportsEdit) {
    mode = 'typing+final'
  }
  if (mode === 'typing+final' && !transport.supportsTyping) {
    mode = 'final'
  }
  return mode
}

/**
 * Split text into ≤maxChars pieces, preferring to break at a newline or space
 * near the end of the window so words/lines aren't cut mid-token.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length === 0) return []
  if (text.length <= maxChars) return [text]

  const chunks: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    const nl = window.lastIndexOf('\n')
    const sp = window.lastIndexOf(' ')
    let cut = maxChars
    if (nl >= maxChars * 0.6) cut = nl + 1
    else if (sp >= maxChars * 0.6) cut = sp + 1
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut)
  }
  if (rest.length) chunks.push(rest)
  return chunks
}

/**
 * Consume the agent's reply stream and deliver it on `target` per `policy`.
 * Returns what was actually sent (including the effective mode).
 */
export async function deliver(
  target: string,
  stream: AsyncIterable<ReplyEvent>,
  transport: ChannelTransport,
  policy: DeliveryPolicy,
): Promise<DeliveryResult> {
  const mode = resolveMode(policy.mode, transport)
  const maxChars = policy.maxChars ?? transport.maxChars
  const throttle = policy.editThrottleChars ?? 60
  const messageIds: string[] = []

  if (mode === 'typing+final') {
    await transport.sendTyping(target)
  }

  let acc = ''
  let liveMsgId: string | undefined
  let lastEditLen = 0

  for await (const ev of stream) {
    if (ev.type === 'error') {
      const msg = `⚠️ ${ev.message}`
      const id = await transport.sendText(target, msg)
      if (id) messageIds.push(id)
      return { text: msg, messageIds, mode, chunks: 1 }
    }
    if (ev.type === 'delta') {
      acc += ev.text
      // Live editing only while the reply still fits one message; overflow is
      // handled as extra messages at finalize.
      if (mode === 'edit-stream' && acc.length <= maxChars) {
        if (liveMsgId === undefined) {
          const id = await transport.sendText(target, acc)
          if (id) {
            liveMsgId = id
            messageIds.push(id)
            lastEditLen = acc.length
          }
        } else if (acc.length - lastEditLen >= throttle) {
          await transport.editText(target, liveMsgId, acc)
          lastEditLen = acc.length
        }
      }
      continue
    }
    // ev.type === 'done' — fall through to finalize
  }

  const chunks = chunkText(acc, maxChars)

  if (mode === 'edit-stream' && liveMsgId !== undefined) {
    // Final edit for the first chunk; any overflow goes as new messages.
    await transport.editText(target, liveMsgId, chunks[0] ?? acc)
    for (const c of chunks.slice(1)) {
      const id = await transport.sendText(target, c)
      if (id) messageIds.push(id)
    }
  } else {
    for (const c of chunks) {
      const id = await transport.sendText(target, c)
      if (id) messageIds.push(id)
    }
  }

  return { text: acc, messageIds, mode, chunks: chunks.length }
}
