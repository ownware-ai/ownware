/**
 * Map a Telegram update → the normalized {@link ShuttleMessage} the base runs.
 * Pure and testable. Returns null for anything we don't answer (no text, etc.).
 */

import type { ShuttleMessage } from '../adapter.js'
import type { ChatType } from '../types.js'
import type { TgMessage, TgUpdate } from './api.js'

function chatTypeOf(t: TgChatType): ChatType {
  if (t === 'private') return 'dm'
  if (t === 'channel') return 'channel'
  return 'group' // group | supergroup
}

type TgChatType = 'private' | 'group' | 'supergroup' | 'channel'

/** True if the bot was @mentioned (or replied-to) — gates group responses. */
export function isBotMentioned(m: TgMessage, text: string, botUsername?: string): boolean {
  if (!botUsername) return false
  // A reply to one of the bot's own messages counts as addressing it.
  if (m.reply_to_message?.from?.username === botUsername) return true
  const handle = `@${botUsername}`
  for (const e of m.entities ?? []) {
    if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length) === handle) return true
    if (e.type === 'text_mention' && e.user?.username === botUsername) return true
  }
  return false
}

export function toShuttleMessage(update: TgUpdate, botUsername?: string): ShuttleMessage | null {
  const m = update.message ?? update.edited_message
  if (!m) return null

  const text = m.text ?? m.caption
  if (!text || !text.trim()) return null

  const chatType = chatTypeOf(m.chat.type)
  const chatId = String(m.chat.id)

  const msg: ShuttleMessage = {
    chatType,
    chatId,
    target: chatId,
    text,
    ...(m.from ? { userId: String(m.from.id) } : {}),
    ...(m.message_thread_id ? { threadId: String(m.message_thread_id) } : {}),
    ...(chatType !== 'dm' ? { isMention: isBotMentioned(m, text, botUsername) } : {}),
  }
  return msg
}
