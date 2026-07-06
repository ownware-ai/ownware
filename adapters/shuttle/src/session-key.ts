/**
 * The session-key oracle (SH0).
 *
 * ONE function that turns a platform message's identity into a canonical,
 * stable key. Every shuttle calls this — it is the conformance oracle for
 * "one brain, one thread per person, no context bleed." Never re-implement
 * keying anywhere else.
 *
 * Format:  `ownware:<profile>:<channel>:<chatType>:<chatId>[:thread:<threadId>][:user:<userId>]`
 *
 *   ownware:acme-support:telegram:dm:12345
 *   ownware:acme-support:slack:channel:C0ABC:thread:1712345678.9001
 *   ownware:acme-support:whatsapp:group:120363@g.us:user:15551234567   (groupPerUser)
 */

import type { SessionKeyParts, SessionKeyOptions } from './types.js'
import { isChatType } from './types.js'

const DELIM = ':'
const PREFIX = 'ownware'

/**
 * Replace the delimiter and whitespace in an id so a component can never
 * break the key structure or the parser. Deterministic and stable — the
 * same input always yields the same component. (WhatsApp JID canonicalization
 * is a future refinement layered above this.)
 */
function part(value: string): string {
  return value.replace(/[\s:]+/g, '_')
}

/**
 * Build the canonical session key for one conversation.
 * @throws {Error} if `profile`, `channel`, or `chatId` is empty.
 */
export function sessionKey(parts: SessionKeyParts, opts: SessionKeyOptions = {}): string {
  const { profile, channel, chatType, chatId, threadId, userId } = parts

  if (!profile.trim()) throw new Error('sessionKey: profile is required')
  if (!channel.trim()) throw new Error('sessionKey: channel is required')
  if (!chatId.trim()) throw new Error('sessionKey: chatId is required')

  let key = [PREFIX, part(profile), part(channel), chatType, part(chatId)].join(DELIM)

  if (threadId && threadId.trim()) {
    key += `${DELIM}thread${DELIM}${part(threadId)}`
  }
  // A DM is already 1:1 — per-user isolation only applies to group/channel.
  if (chatType !== 'dm' && opts.groupPerUser && userId && userId.trim()) {
    key += `${DELIM}user${DELIM}${part(userId)}`
  }

  return key
}

/** True if a string looks like a session key this oracle produced. */
export function isSessionKey(value: string): boolean {
  const segs = value.split(DELIM)
  return segs.length >= 5 && segs[0] === PREFIX && !!segs[3] && isChatType(segs[3])
}

/**
 * The stable prefix for every conversation of one agent on one channel —
 * useful for listing/scoping all threads for `acme-support` on `telegram`.
 */
export function sessionKeyPrefix(profile: string, channel: string): string {
  return [PREFIX, part(profile), part(channel)].join(DELIM)
}

/**
 * Parse a key back into its parts (the inverse of {@link sessionKey}).
 * Returns null if the string is not a well-formed session key. Components
 * are the sanitized forms (colons/whitespace already collapsed to `_`).
 */
export function parseSessionKey(value: string): SessionKeyParts | null {
  const segs = value.split(DELIM)
  if (segs.length < 5) return null

  const [prefix, profile, channel, chatType, chatId, ...rest] = segs
  if (prefix !== PREFIX) return null
  if (!profile || !channel || !chatType || !chatId) return null
  if (!isChatType(chatType)) return null

  const parts: SessionKeyParts = { profile, channel, chatType, chatId }
  let threadId: string | undefined
  let userId: string | undefined
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const marker = rest[i]
    const val = rest[i + 1]
    if (!val) continue
    if (marker === 'thread') threadId = val
    else if (marker === 'user') userId = val
  }
  return { ...parts, ...(threadId ? { threadId } : {}), ...(userId ? { userId } : {}) }
}
