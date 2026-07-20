/**
 * WhatsAppTransport — outbound via the Cloud API. WhatsApp text can't be edited
 * and (in v1) we don't drive typing, so delivery degrades to `final`; long
 * replies chunk at 4096. `target` is the customer's WhatsApp number.
 */

import type { ChannelTransport } from '../delivery.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { WhatsAppSendError, type WhatsAppApi } from './api.js'

export interface WhatsAppSendObserver {
  prepare(target: string, text: string): Promise<string> | string
  accepted(attemptId: string, providerMessageId: string): Promise<void> | void
  rejected(attemptId: string, code: string): Promise<void> | void
  unknown(attemptId: string, code: string): Promise<void> | void
}

export class WhatsAppTransport implements ChannelTransport {
  readonly maxChars = 4096
  readonly supportsEdit = false
  readonly supportsTyping = false

  private readonly observers = new AsyncLocalStorage<WhatsAppSendObserver>()

  constructor(private readonly api: WhatsAppApi) {}

  withObserver<T>(observer: WhatsAppSendObserver | undefined, work: () => Promise<T>): Promise<T> {
    return observer ? this.observers.run(observer, work) : work()
  }

  async sendText(target: string, text: string): Promise<string | undefined> {
    const observer = this.observers.getStore()
    const attemptId = observer ? await observer.prepare(target, text) : undefined
    try {
      const { id } = await this.api.sendText(target, text)
      if (observer && attemptId) await observer.accepted(attemptId, id)
      return id
    } catch (error) {
      if (observer && attemptId) {
        if (error instanceof WhatsAppSendError && error.acceptance === 'rejected') {
          await observer.rejected(attemptId, error.code)
        } else {
          const code = error instanceof WhatsAppSendError ? error.code : 'unexpected_send_error'
          await observer.unknown(attemptId, code)
        }
      }
      throw error
    }
  }

  async editText(): Promise<void> {
    /* WhatsApp cannot edit a delivered message */
  }

  async sendTyping(): Promise<void> {
    /* not driven in v1 */
  }
}
