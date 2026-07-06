/**
 * SmsShuttle — the SMS (Twilio) channel, on the ShuttleAdapter base (SH7).
 *
 * The agent is a PHONE NUMBER here: a business points its Twilio number's
 * inbound webhook at `handleInbound`, and every customer who texts the number
 * talks to the agent, one thread per number. Reply goes out via the Twilio
 * REST API (async — the agent takes time, so we don't reply in the webhook
 * response). This is exactly the "deploy your agent on a number" case.
 */

import { ShuttleAdapter, type ShuttleConfig, type ShuttleDeps } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ThreadMap } from '../types.js'
import type { DeliveryPolicy, DeliveryResult } from '../delivery.js'
import type { GatewayClient } from '../gateway-client.js'
import { TwilioApi } from './api.js'
import { SmsTransport } from './transport.js'
import { parseTwilioForm, validateTwilioSignature } from './message.js'

export interface SmsShuttleOptions {
  readonly accountSid: string
  readonly authToken: string
  /** The business's Twilio number (the reply `from`). */
  readonly from: string
  readonly profileId: string
  readonly gateway: GatewayClient
  readonly threads?: ThreadMap
  readonly delivery?: DeliveryPolicy
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
}

export interface HandleInboundOptions {
  /** The public webhook URL, for signature validation. */
  readonly url?: string
  /** The `X-Twilio-Signature` header value. */
  readonly signature?: string
}

export class SmsShuttle {
  private readonly adapter: ShuttleAdapter
  private readonly authToken: string

  constructor(opts: SmsShuttleOptions) {
    const api = new TwilioApi({
      accountSid: opts.accountSid,
      authToken: opts.authToken,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    })
    this.authToken = opts.authToken

    const config: ShuttleConfig = {
      profileId: opts.profileId,
      channel: 'sms',
      delivery: opts.delivery ?? { mode: 'final' }, // SMS can't stream/edit
    }
    const deps: ShuttleDeps = {
      gateway: opts.gateway,
      threads: opts.threads ?? new InMemoryThreadMap(),
      transport: new SmsTransport(api, opts.from),
    }
    this.adapter = new ShuttleAdapter(config, deps)
  }

  /**
   * Handle one inbound Twilio webhook (the parsed form params). Mount this on
   * your HTTP endpoint. Pass `url`+`signature` to verify the request is Twilio's.
   * Returns what was delivered, or null if ignored (empty/non-message).
   */
  async handleInbound(
    params: Record<string, string>,
    opts: HandleInboundOptions = {},
  ): Promise<DeliveryResult | null> {
    if (opts.url && opts.signature) {
      if (!validateTwilioSignature(this.authToken, opts.url, params, opts.signature)) {
        throw new Error('invalid Twilio signature')
      }
    }
    const msg = parseTwilioForm(params)
    if (!msg) return null
    return this.adapter.handle(msg)
  }
}
