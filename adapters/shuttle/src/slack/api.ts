/**
 * Minimal Slack API client (fetch-based, zero deps): the Web API methods a
 * shuttle needs + Socket Mode connection open. Socket Mode means NO public
 * webhook / app review — the bot dials out over a WebSocket.
 */

export interface SlackApiOptions {
  /** Bot token `xoxb-…` (Web API calls). */
  readonly botToken: string
  /** App-level token `xapp-…` (Socket Mode). */
  readonly appToken?: string
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
}

export class SlackApi {
  private readonly base: string
  private readonly botToken: string
  private readonly appToken: string | undefined
  private readonly doFetch: typeof fetch

  constructor(opts: SlackApiOptions) {
    this.base = (opts.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
    this.botToken = opts.botToken
    this.appToken = opts.appToken
    this.doFetch = opts.fetch ?? fetch
  }

  private async call<T>(method: string, token: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.doFetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as { ok: boolean; error?: string } & T
    if (!data.ok) throw new Error(`slack ${method} failed: ${data.error ?? res.status}`)
    return data
  }

  authTest(): Promise<{ user_id: string; team_id: string }> {
    return this.call('auth.test', this.botToken, {})
  }

  openConnection(): Promise<{ url: string }> {
    if (!this.appToken) throw new Error('appToken (xapp-…) required for Socket Mode')
    return this.call('apps.connections.open', this.appToken, {})
  }

  postMessage(channel: string, text: string, opts?: { threadTs?: string }): Promise<{ ts: string }> {
    return this.call('chat.postMessage', this.botToken, {
      channel,
      text,
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
    })
  }

  updateMessage(channel: string, ts: string, text: string): Promise<{ ts: string }> {
    return this.call('chat.update', this.botToken, { channel, ts, text })
  }
}
