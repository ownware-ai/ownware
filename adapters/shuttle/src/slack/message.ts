/**
 * Map a Slack event → ShuttleMessage. The agent is a bot MEMBER of the
 * workspace: `app_mention` = @mentioned in a channel; `message` with
 * channel_type `im` = a DM. Bot echoes / edits / joins are ignored.
 */

import type { ShuttleMessage } from '../adapter.js'

export interface SlackEvent {
  readonly type?: string
  readonly subtype?: string
  readonly bot_id?: string
  readonly user?: string
  readonly text?: string
  readonly channel?: string
  readonly channel_type?: string
  readonly thread_ts?: string
}

function stripMention(text: string, botUserId?: string): string {
  if (!botUserId) return text.trim()
  return text.split(`<@${botUserId}>`).join('').trim()
}

export function toShuttleMessage(event: SlackEvent, botUserId?: string): ShuttleMessage | null {
  if (event.bot_id) return null // our own / other bots' messages
  if (event.subtype) return null // edits, joins, channel_topic, etc.

  const channel = event.channel
  const user = event.user
  if (!channel || !user) return null

  if (event.type === 'app_mention') {
    const text = stripMention(event.text ?? '', botUserId)
    if (!text) return null
    return {
      chatType: 'channel',
      chatId: channel,
      target: channel,
      text,
      userId: user,
      isMention: true,
      ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
    }
  }

  if (event.type === 'message') {
    const text = event.text
    if (!text || !text.trim()) return null

    if (event.channel_type === 'im') {
      return { chatType: 'dm', chatId: channel, target: channel, text: text.trim(), userId: user }
    }
    // A channel message. `app_mention` already covers the mention case — skip
    // messages that mention the bot here to avoid answering twice.
    if (botUserId && text.includes(`<@${botUserId}>`)) return null
    return {
      chatType: 'channel',
      chatId: channel,
      target: channel,
      text: text.trim(),
      userId: user,
      isMention: false,
      ...(event.thread_ts ? { threadId: event.thread_ts } : {}),
    }
  }

  return null
}
