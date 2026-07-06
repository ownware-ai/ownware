/**
 * DiscordTransport — outbound via REST. Discord supports editing and typing,
 * so it can do every delivery mode; the message limit is 2000 chars. `target`
 * is the channel id.
 */

import type { ChannelTransport } from '../delivery.js'
import type { DiscordApi } from './api.js'

export class DiscordTransport implements ChannelTransport {
  readonly maxChars = 2000
  readonly supportsEdit = true
  readonly supportsTyping = true

  constructor(private readonly api: DiscordApi) {}

  async sendText(target: string, text: string): Promise<string | undefined> {
    const { id } = await this.api.sendMessage(target, text)
    return id || undefined
  }

  async editText(target: string, messageId: string, text: string): Promise<void> {
    await this.api.editMessage(target, messageId, text)
  }

  async sendTyping(target: string): Promise<void> {
    await this.api.triggerTyping(target)
  }
}
