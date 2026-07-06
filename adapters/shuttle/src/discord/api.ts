/**
 * Minimal Discord REST client (fetch-based, zero deps). Inbound arrives over
 * the gateway WebSocket (see shuttle.ts); replies go out via REST.
 */

export interface DiscordApiOptions {
  readonly token: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  readonly apiVersion?: string
}

export class DiscordApi {
  private readonly base: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(opts: DiscordApiOptions) {
    const root = (opts.baseUrl ?? 'https://discord.com/api').replace(/\/+$/, '')
    this.base = `${root}/${opts.apiVersion ?? 'v10'}`
    this.token = opts.token
    this.doFetch = opts.fetch ?? fetch
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' }
  }

  async sendMessage(channelId: string, content: string): Promise<{ id: string }> {
    const res = await this.doFetch(`${this.base}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`discord send failed: ${res.status}`)
    const data = (await res.json()) as { id?: string }
    return { id: data.id ?? '' }
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    const res = await this.doFetch(`${this.base}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`discord edit failed: ${res.status}`)
  }

  async triggerTyping(channelId: string): Promise<void> {
    await this.doFetch(`${this.base}/channels/${channelId}/typing`, { method: 'POST', headers: this.headers() })
  }

  async getGatewayUrl(): Promise<string> {
    const res = await this.doFetch(`${this.base}/gateway/bot`, { headers: this.headers() })
    if (!res.ok) return 'wss://gateway.discord.gg'
    const data = (await res.json()) as { url?: string }
    return data.url ?? 'wss://gateway.discord.gg'
  }
}
