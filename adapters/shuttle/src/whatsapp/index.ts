/**
 * @ownware/shuttle/whatsapp — the WhatsApp (Cloud API) channel. The agent is a
 * WhatsApp Business number.
 *
 * Usage (mount on your Meta webhook):
 *   import { WhatsAppShuttle } from '@ownware/shuttle/whatsapp'
 *   import { HttpGatewayClient } from '@ownware/shuttle'
 *
 *   const wa = new WhatsAppShuttle({
 *     accessToken: process.env.WA_TOKEN!,
 *     phoneNumberId: process.env.WA_PHONE_ID!,
 *     appSecret: process.env.WA_APP_SECRET,
 *     profileId: 'acme-support',
 *     gateway: new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3011' }),
 *   })
 *   // GET  verify: res.send(wa.verifyChallenge(query, process.env.WA_VERIFY_TOKEN!))
 *   // POST inbound: await wa.handleInbound(body, { rawBody, signature })
 */

export { WhatsAppApi } from './api.js'
export type { WhatsAppApiOptions } from './api.js'
export { WhatsAppTransport } from './transport.js'
export { parseWhatsAppWebhook, verifyWhatsAppSignature, verifyWebhookChallenge } from './message.js'
export type { WhatsAppWebhookBody } from './message.js'
export { WhatsAppShuttle } from './shuttle.js'
export type { WhatsAppShuttleOptions, WhatsAppInboundOptions } from './shuttle.js'
