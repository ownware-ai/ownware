/**
 * WhatsAppTransport — outbound via the Cloud API. WhatsApp text can't be edited
 * and (in v1) we don't drive typing, so delivery degrades to `final`; long
 * replies chunk at 4096. `target` is the customer's WhatsApp number.
 */

import type { ChannelTransport } from '../delivery.js'
import type { WhatsAppApi } from './api.js'

export class WhatsAppTransport implements ChannelTransport {
  readonly maxChars = 4096
  readonly supportsEdit = false
  readonly supportsTyping = false

  constructor(private readonly api: WhatsAppApi) {}

  async sendText(target: string, text: string): Promise<string | undefined> {
    const { id } = await this.api.sendText(target, text)
    return id || undefined
  }

  async editText(): Promise<void> {
    /* WhatsApp cannot edit a delivered message */
  }

  async sendTyping(): Promise<void> {
    /* not driven in v1 */
  }
}
