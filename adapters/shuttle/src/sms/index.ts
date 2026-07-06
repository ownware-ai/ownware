/**
 * @ownware/shuttle/sms — the SMS (Twilio) channel. The agent is a phone number.
 *
 * Usage (mount handleInbound on your Twilio inbound webhook):
 *   import { SmsShuttle } from '@ownware/shuttle/sms'
 *   import { HttpGatewayClient } from '@ownware/shuttle'
 *
 *   const sms = new SmsShuttle({
 *     accountSid: process.env.TWILIO_SID!,
 *     authToken: process.env.TWILIO_TOKEN!,
 *     from: '+15551234567',
 *     profileId: 'acme-support',
 *     gateway: new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3011' }),
 *   })
 *   // in your webhook: await sms.handleInbound(formParams, { url, signature })
 */

export { TwilioApi } from './api.js'
export type { TwilioApiOptions } from './api.js'
export { SmsTransport } from './transport.js'
export { parseTwilioForm, validateTwilioSignature } from './message.js'
export { SmsShuttle } from './shuttle.js'
export type { SmsShuttleOptions, HandleInboundOptions } from './shuttle.js'
