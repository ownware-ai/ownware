/**
 * Channel config — what a stored channel is (SH1 part 3). One record per
 * connected channel: which platform, which agent, the credential (encrypted at
 * rest by the store), and the line policy.
 */

import type { LinePolicy } from '../gate.js'

export type ChannelKind = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'sms'

export interface ChannelConfig {
  /** Unique id, e.g. `telegram-acme`. */
  readonly id: string
  readonly channel: ChannelKind
  /** Which agent answers (profile slug). */
  readonly profileId: string
  /** Platform secrets (bot token, OAuth, etc.). Encrypted at rest by the store. */
  readonly credentials: Readonly<Record<string, string>>
  /** Personal ↔ business policy. */
  readonly line?: LinePolicy
  readonly enabled?: boolean
}

/** Credential keys each channel requires (used for validation + CLI mapping). */
export const REQUIRED_CREDENTIALS: Record<ChannelKind, readonly string[]> = {
  telegram: ['token'],
  slack: ['botToken', 'appToken'],
  discord: ['token'],
  // A public webhook without both values cannot authenticate Meta or complete
  // the verification handshake. Treating them as optional made an unsigned
  // production path look supported.
  whatsapp: ['accessToken', 'phoneNumberId', 'appSecret', 'verifyToken'],
  sms: ['accountSid', 'authToken', 'from'],
}

export const CHANNEL_KINDS = Object.keys(REQUIRED_CREDENTIALS) as ChannelKind[]

export function isChannelKind(value: string): value is ChannelKind {
  return (CHANNEL_KINDS as string[]).includes(value)
}

/** Returns an error string if the config is invalid, else null. */
export function validateChannelConfig(config: ChannelConfig): string | null {
  if (!isChannelKind(config.channel)) return `unknown channel: ${config.channel}`
  if (!config.profileId.trim()) return 'profileId is required'
  if (!config.id.trim()) return 'id is required'
  for (const key of REQUIRED_CREDENTIALS[config.channel]) {
    if (!config.credentials[key]?.trim()) return `${config.channel} requires credential: ${key}`
  }
  return null
}
