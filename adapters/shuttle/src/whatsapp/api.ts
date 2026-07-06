/**
 * Minimal WhatsApp Cloud API client (fetch-based, zero deps). The OFFICIAL
 * Meta business path (not Baileys/QR) — REST out, webhook in — which is the
 * clean, scalable, fully-testable choice for a business line.
 */

export interface WhatsAppApiOptions {
  readonly accessToken: string
  /** The WhatsApp Business phone-number id (from Meta), not the display number. */
  readonly phoneNumberId: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly apiVersion?: string
}

export class WhatsAppApi {
  private readonly base: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(opts: WhatsAppApiOptions) {
    const root = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '')
    const ver = opts.apiVersion ?? 'v20.0'
    this.base = `${root}/${ver}/${opts.phoneNumberId}`
    this.token = opts.accessToken
    this.doFetch = opts.fetch ?? fetch
  }

  async sendText(to: string, body: string): Promise<{ id: string }> {
    const res = await this.doFetch(`${this.base}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
    })
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* ignore */
      }
      throw new Error(`whatsapp send failed: ${res.status} ${detail}`)
    }
    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    return { id: data.messages?.[0]?.id ?? '' }
  }
}
