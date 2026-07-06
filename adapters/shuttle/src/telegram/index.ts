/**
 * @ownware/shuttle/telegram — the Telegram channel.
 *
 * Usage:
 *   import { TelegramShuttle } from '@ownware/shuttle/telegram'
 *   import { HttpGatewayClient } from '@ownware/shuttle'
 *
 *   const shuttle = new TelegramShuttle({
 *     token: process.env.TELEGRAM_BOT_TOKEN!,
 *     profileId: 'acme-support',
 *     gateway: new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3011', token }),
 *   })
 *   await shuttle.start()
 */

export { TelegramApi } from './api.js'
export type {
  TelegramApiOptions,
  TgUpdate,
  TgMessage,
  TgMessageEntity,
  TgUser,
  TgChat,
} from './api.js'
export { TelegramTransport } from './transport.js'
export { toShuttleMessage, isBotMentioned } from './message.js'
export { TelegramShuttle } from './shuttle.js'
export type { TelegramShuttleOptions } from './shuttle.js'
