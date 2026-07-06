/**
 * SMS inbound: parse a Twilio webhook form → ShuttleMessage, and validate the
 * Twilio request signature. Both pure and fully testable (no live network).
 *
 * A Twilio inbound webhook is `application/x-www-form-urlencoded` with fields
 * like From, To, Body, MessageSid. Every phone number is its own DM thread.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ShuttleMessage } from '../adapter.js'

export function parseTwilioForm(params: Record<string, string>): ShuttleMessage | null {
  const from = params['From']
  const body = params['Body']
  if (!from || !body || !body.trim()) return null
  return {
    chatType: 'dm',
    chatId: from,
    target: from,
    text: body,
    userId: from,
  }
}

/**
 * Validate a Twilio webhook signature (`X-Twilio-Signature`).
 * Twilio signs: the full request URL + each POST param (sorted by key,
 * concatenated key+value), HMAC-SHA1 with the auth token, base64.
 */
export function validateTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  let data = fullUrl
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]
  }
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64')
  return safeEqual(expected, signature)
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
