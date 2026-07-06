/**
 * A minimal Telegram Bot API client (fetch-based, zero dependencies).
 *
 * Just the surface a shuttle needs: identity, long-poll, send, edit, typing.
 * Keeping it dependency-free (no grammY) matches Loom's ethos and makes the
 * whole channel unit-testable with an injected fetch — no live network.
 */

export interface TelegramApiOptions {
  readonly token: string
  readonly fetch?: typeof fetch
  /** Override for tests / self-hosted Bot API servers. Default api.telegram.org. */
  readonly baseUrl?: string
}

export interface TgUser {
  readonly id: number
  readonly is_bot: boolean
  readonly username?: string
  readonly first_name?: string
}

export interface TgChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
  readonly username?: string
}

export interface TgMessageEntity {
  readonly type: string
  readonly offset: number
  readonly length: number
  readonly user?: TgUser
}

export interface TgMessage {
  readonly message_id: number
  readonly from?: TgUser
  readonly chat: TgChat
  readonly text?: string
  readonly caption?: string
  readonly entities?: TgMessageEntity[]
  readonly message_thread_id?: number
  readonly reply_to_message?: TgMessage
}

export interface TgUpdate {
  readonly update_id: number
  readonly message?: TgMessage
  readonly edited_message?: TgMessage
}

export class TelegramApi {
  private readonly base: string
  private readonly doFetch: typeof fetch

  constructor(opts: TelegramApiOptions) {
    const root = (opts.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '')
    this.base = `${root}/bot${opts.token}`
    this.doFetch = opts.fetch ?? fetch
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const res = await this.doFetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params ?? {}),
    })
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string }
    if (!data.ok) {
      throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`)
    }
    return data.result as T
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe')
  }

  getUpdates(offset: number, timeout = 30): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout, allowed_updates: ['message'] })
  }

  sendMessage(
    chatId: number | string,
    text: string,
    opts?: { messageThreadId?: number },
  ): Promise<TgMessage> {
    const params: Record<string, unknown> = { chat_id: chatId, text }
    if (opts?.messageThreadId) params['message_thread_id'] = opts.messageThreadId
    return this.call<TgMessage>('sendMessage', params)
  }

  editMessageText(chatId: number | string, messageId: number, text: string): Promise<TgMessage | true> {
    return this.call<TgMessage | true>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
    })
  }

  sendChatAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action })
  }
}
