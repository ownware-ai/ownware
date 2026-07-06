/**
 * WhatsAppShuttle — the WhatsApp (Cloud API) channel, on the base (SH5).
 *
 * The agent is a WhatsApp Business NUMBER: a business points its Meta webhook at
 * `handleInbound`, and every customer who texts the number talks to the agent,
 * one thread per number. Reply goes out via the Cloud REST API. The webhook GET
 * verification handshake is handled by `verifyChallenge`.
 */

import { ShuttleAdapter, type ShuttleConfig, type ShuttleDeps } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ThreadMap } from '../types.js'
import type { DeliveryPolicy, DeliveryResult } from '../delivery.js'
import type { LinePolicy } from '../gate.js'
import type { PairingStore } from '../pairing.js'
import type { GatewayClient } from '../gateway-client.js'
import { WhatsAppApi } from './api.js'
import { WhatsAppTransport } from './transport.js'
import { parseWhatsAppWebhook, verifyWhatsAppSignature, verifyWebhookChallenge, type WhatsAppWebhookBody } from './message.js'

export interface WhatsAppShuttleOptions {
  readonly accessToken: string
  readonly phoneNumberId: string
  readonly profileId: string
  readonly gateway: GatewayClient
  readonly threads?: ThreadMap
  readonly delivery?: DeliveryPolicy
  readonly line?: LinePolicy
  readonly pairing?: PairingStore
  /** Meta app secret — enables `X-Hub-Signature-256` verification. */
  readonly appSecret?: string
  /** Coalesce rapid messages per person. */
  readonly debounce?: { readonly ms: number; readonly maxWaitMs?: number }
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly apiVersion?: string
}

export interface WhatsAppInboundOptions {
  /** Raw request body (needed for signature verification). */
  readonly rawBody?: string
  /** The `X-Hub-Signature-256` header. */
  readonly signature?: string
}

export class WhatsAppShuttle {
  private readonly adapter: ShuttleAdapter
  private readonly appSecret: string | undefined

  constructor(opts: WhatsAppShuttleOptions) {
    const api = new WhatsAppApi({
      accessToken: opts.accessToken,
      phoneNumberId: opts.phoneNumberId,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}),
    })
    this.appSecret = opts.appSecret

    const config: ShuttleConfig = {
      profileId: opts.profileId,
      channel: 'whatsapp',
      delivery: opts.delivery ?? { mode: 'final' },
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.debounce ? { debounce: opts.debounce } : {}),
    }
    const deps: ShuttleDeps = {
      gateway: opts.gateway,
      threads: opts.threads ?? new InMemoryThreadMap(),
      transport: new WhatsAppTransport(api),
      ...(opts.pairing ? { pairing: opts.pairing } : {}),
    }
    this.adapter = new ShuttleAdapter(config, deps)
  }

  /**
   * Handle one inbound webhook (a Meta POST — may carry multiple messages).
   * Pass `rawBody`+`signature` to verify the request came from Meta.
   */
  async handleInbound(body: WhatsAppWebhookBody, opts: WhatsAppInboundOptions = {}): Promise<DeliveryResult[]> {
    if (opts.rawBody && opts.signature) {
      if (!this.appSecret) throw new Error('appSecret required to verify the WhatsApp signature')
      if (!verifyWhatsAppSignature(this.appSecret, opts.rawBody, opts.signature)) {
        throw new Error('invalid WhatsApp signature')
      }
    }
    const results: DeliveryResult[] = []
    for (const msg of parseWhatsAppWebhook(body)) {
      const r = await this.adapter.handle(msg)
      if (r) results.push(r)
    }
    return results
  }

  /** GET webhook verification handshake — echo the challenge when the token matches. */
  verifyChallenge(
    params: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string },
    verifyToken: string,
  ): string | null {
    return verifyWebhookChallenge(params, verifyToken)
  }
}
