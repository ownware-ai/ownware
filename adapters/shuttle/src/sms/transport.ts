/**
 * SmsTransport — outbound SMS via Twilio. SMS can't edit or show typing, so
 * every delivery mode degrades to `final`; long replies are chunked. The
 * shuttle's fixed Twilio number is the `from`; `target` is the customer's number.
 */

import type { ChannelTransport } from '../delivery.js'
import type { TwilioApi } from './api.js'

export class SmsTransport implements ChannelTransport {
  readonly maxChars = 1600
  readonly supportsEdit = false
  readonly supportsTyping = false

  constructor(
    private readonly api: TwilioApi,
    private readonly from: string,
  ) {}

  async sendText(target: string, text: string): Promise<string | undefined> {
    const { sid } = await this.api.sendSms(this.from, target, text)
    return sid || undefined
  }

  async editText(): Promise<void> {
    /* SMS cannot edit a delivered message */
  }

  async sendTyping(): Promise<void> {
    /* SMS has no typing indicator */
  }
}
