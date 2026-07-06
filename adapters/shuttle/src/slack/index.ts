/**
 * @ownware/shuttle/slack — the Slack channel via Socket Mode. The agent is a bot
 * member you @mention.
 *
 * Usage:
 *   import { SlackShuttle } from '@ownware/shuttle/slack'
 *   import { HttpGatewayClient } from '@ownware/shuttle'
 *
 *   const slack = new SlackShuttle({
 *     botToken: process.env.SLACK_BOT_TOKEN!,   // xoxb-
 *     appToken: process.env.SLACK_APP_TOKEN!,   // xapp-
 *     profileId: 'acme-ops',
 *     gateway: new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3011' }),
 *   })
 *   await slack.start()
 */

export { SlackApi } from './api.js'
export type { SlackApiOptions } from './api.js'
export { SlackTransport } from './transport.js'
export { toShuttleMessage } from './message.js'
export type { SlackEvent } from './message.js'
export { SlackShuttle } from './shuttle.js'
export type { SlackShuttleOptions } from './shuttle.js'
