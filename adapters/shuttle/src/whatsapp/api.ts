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

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    readonly acceptance: 'rejected' | 'unknown',
    readonly code: string,
  ) {
    super(message)
    this.name = 'WhatsAppSendError'
  }
}

export class WhatsAppApi {
  private readonly base: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(opts: WhatsAppApiOptions) {
    const root = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '')
    const ver = opts.apiVersion ?? 'v24.0'
    this.base = `${root}/${ver}/${opts.phoneNumberId}`
    this.token = opts.accessToken
    this.doFetch = opts.fetch ?? fetch
  }

  async sendText(to: string, body: string): Promise<{ id: string }> {
    let res: Response
    try {
      res = await this.doFetch(`${this.base}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
      })
    } catch (error) {
      throw new WhatsAppSendError(
        `whatsapp send outcome unknown: ${error instanceof Error ? error.message : error}`,
        'unknown',
        'transport_error',
      )
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        /* ignore */
      }
      throw new WhatsAppSendError(`whatsapp send rejected: ${res.status} ${detail}`, 'rejected', `http_${res.status}`)
    }
    let data: { messages?: Array<{ id?: string }> }
    try {
      data = (await res.json()) as { messages?: Array<{ id?: string }> }
    } catch {
      throw new WhatsAppSendError('whatsapp send outcome unknown: invalid success response', 'unknown', 'invalid_success_response')
    }
    const id = data.messages?.[0]?.id
    if (!id) {
      throw new WhatsAppSendError('whatsapp send outcome unknown: success response omitted message id', 'unknown', 'message_id_missing')
    }
    return { id }
  }
}
