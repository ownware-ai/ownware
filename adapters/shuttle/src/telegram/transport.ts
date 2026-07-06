/**
 * TelegramTransport — how the delivery layer sends on Telegram.
 *
 * Telegram supports editing and typing indicators, so it can do every
 * delivery mode (final / typing+final / edit-stream); the platform limit is
 * 4096 chars. `target` is the chat id (a string).
 */

import type { ChannelTransport } from '../delivery.js'
import type { TelegramApi } from './api.js'

export class TelegramTransport implements ChannelTransport {
  readonly maxChars = 4096
  readonly supportsEdit = true
  readonly supportsTyping = true

  constructor(private readonly api: TelegramApi) {}

  async sendText(target: string, text: string): Promise<string | undefined> {
    const m = await this.api.sendMessage(target, text)
    return String(m.message_id)
  }

  async editText(target: string, messageId: string, text: string): Promise<void> {
    await this.api.editMessageText(target, Number(messageId), text)
  }

  async sendTyping(target: string): Promise<void> {
    await this.api.sendChatAction(target, 'typing')
  }
}
