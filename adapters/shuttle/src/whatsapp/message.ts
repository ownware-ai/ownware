/**
 * WhatsApp Cloud inbound: parse Meta's webhook → ShuttleMessages, verify the
 * request signature, and handle the GET verification handshake. All pure/testable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ShuttleMessage } from '../adapter.js'

export interface WhatsAppWebhookBody {
  readonly object?: string
  readonly entry?: ReadonlyArray<{
    readonly changes?: ReadonlyArray<{
      readonly value?: {
        readonly messaging_product?: string
        readonly metadata?: { readonly phone_number_id?: string }
        readonly messages?: ReadonlyArray<{
          readonly from?: string
          readonly id?: string
          readonly type?: string
          readonly text?: { readonly body?: string }
        }>
        readonly statuses?: ReadonlyArray<{
          readonly id?: string
          readonly status?: string
          readonly timestamp?: string
          readonly errors?: ReadonlyArray<{
            readonly code?: number
            readonly title?: string
          }>
        }>
      }
      readonly field?: string
    }>
  }>
}

/** Extract text messages (ignores statuses, non-text). Every number = its own DM. */
export function parseWhatsAppWebhook(body: WhatsAppWebhookBody): ShuttleMessage[] {
  const out: ShuttleMessage[] = []
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type !== 'text') continue
        const from = m.from
        const text = m.text?.body
        if (!from || !text || !text.trim()) continue
        out.push({ chatType: 'dm', chatId: from, target: from, text, userId: from })
      }
    }
  }
  return out
}

/** Verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(appSecret, rawBody). */
export function verifyWhatsAppSignature(appSecret: string, rawBody: string, signatureHeader: string): boolean {
  const expected = `sha256=${createHmac('sha256', appSecret).update(Buffer.from(rawBody, 'utf-8')).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** GET webhook verification: echo `hub.challenge` when the token matches, else null. */
export function verifyWebhookChallenge(
  params: { readonly 'hub.mode'?: string; readonly 'hub.verify_token'?: string; readonly 'hub.challenge'?: string },
  verifyToken: string,
): string | null {
  if (params['hub.mode'] === 'subscribe' && params['hub.verify_token'] === verifyToken) {
    return params['hub.challenge'] ?? null
  }
  return null
}
