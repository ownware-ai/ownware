/**
 * @ownware/shuttle/discord — the Discord channel via the gateway WebSocket.
 * The agent is a bot member; DMs go straight to it, servers require @mention.
 *
 * Usage:
 *   import { DiscordShuttle } from '@ownware/shuttle/discord'
 *   import { HttpGatewayClient } from '@ownware/shuttle'
 *
 *   const discord = new DiscordShuttle({
 *     token: process.env.DISCORD_BOT_TOKEN!,
 *     profileId: 'acme-community',
 *     gateway: new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3011' }),
 *   })
 *   await discord.start()   // needs the MESSAGE_CONTENT intent enabled
 */

export { DiscordApi } from './api.js'
export type { DiscordApiOptions } from './api.js'
export { DiscordTransport } from './transport.js'
export { toShuttleMessage } from './message.js'
export type { DiscordMessageCreate, DiscordUser } from './message.js'
export { DiscordShuttle } from './shuttle.js'
export type { DiscordShuttleOptions } from './shuttle.js'
