/**
 * Map a Discord MESSAGE_CREATE → ShuttleMessage. The agent is a bot MEMBER:
 * a message with no `guild_id` is a DM; in a server it answers on @mention
 * (bot in `mentions`, or `@everyone`). Bots (incl. self) are ignored.
 */

import type { ShuttleMessage } from '../adapter.js'

export interface DiscordUser {
  readonly id?: string
  readonly bot?: boolean
  readonly username?: string
}

export interface DiscordMessageCreate {
  readonly id?: string
  readonly channel_id?: string
  readonly guild_id?: string
  readonly content?: string
  readonly author?: DiscordUser
  readonly mentions?: ReadonlyArray<DiscordUser>
  readonly mention_everyone?: boolean
}

export function toShuttleMessage(d: DiscordMessageCreate, botUserId?: string): ShuttleMessage | null {
  if (d.author?.bot) return null // ignore other bots + our own echoes

  const channel = d.channel_id
  const user = d.author?.id
  const content = d.content
  if (!channel || !user || !content || !content.trim()) return null

  if (!d.guild_id) {
    return { chatType: 'dm', chatId: channel, target: channel, text: content.trim(), userId: user }
  }

  const mentioned =
    (botUserId ? (d.mentions ?? []).some((m) => m.id === botUserId) : false) || d.mention_everyone === true

  return {
    chatType: 'channel',
    chatId: channel,
    target: channel,
    text: content.trim(),
    userId: user,
    isMention: mentioned,
  }
}
