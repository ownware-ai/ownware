/**
 * Minimal Twilio REST client (fetch-based, zero dependencies) — just the
 * outbound send a shuttle needs. Inbound arrives as a webhook (see message.ts).
 */

export interface TwilioApiOptions {
  readonly accountSid: string
  readonly authToken: string
  readonly fetch?: typeof fetch
  /** Override for tests / regional endpoints. Default api.twilio.com. */
  readonly baseUrl?: string
}

export class TwilioApi {
  private readonly base: string
  private readonly auth: string
  private readonly doFetch: typeof fetch

  constructor(opts: TwilioApiOptions) {
    const root = (opts.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '')
    this.base = `${root}/2010-04-01/Accounts/${opts.accountSid}`
    this.auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64')}`
    this.doFetch = opts.fetch ?? fetch
  }

  /** Send an SMS. Twilio segments long bodies automatically (≤1600 chars/request). */
  async sendSms(from: string, to: string, body: string): Promise<{ sid: string }> {
    const form = new URLSearchParams({ From: from, To: to, Body: body })
    const res = await this.doFetch(`${this.base}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: this.auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* ignore */
      }
      throw new Error(`twilio send failed: ${res.status} ${detail}`)
    }
    const data = (await res.json()) as { sid?: string }
    return { sid: data.sid ?? '' }
  }
}
