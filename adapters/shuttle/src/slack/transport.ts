/**
 * SlackTransport — outbound via the Web API. Slack supports editing
 * (`chat.update`), so `edit-stream` gives a live-typing feel; no bot typing
 * indicator, so `typing+final` degrades to `final`. `target` is the channel id;
 * the message id used for edits is the message `ts`.
 */

import type { ChannelTransport } from '../delivery.js'
import type { SlackApi } from './api.js'

export class SlackTransport implements ChannelTransport {
  readonly maxChars = 3900
  readonly supportsEdit = true
  readonly supportsTyping = false

  constructor(private readonly api: SlackApi) {}

  async sendText(target: string, text: string): Promise<string | undefined> {
    const { ts } = await this.api.postMessage(target, text)
    return ts || undefined
  }

  async editText(target: string, messageId: string, text: string): Promise<void> {
    await this.api.updateMessage(target, messageId, text)
  }

  async sendTyping(): Promise<void> {
    /* no bot typing indicator in the Web API */
  }
}
