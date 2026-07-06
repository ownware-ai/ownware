/**
 * GatewayClient — how a shuttle talks to the ownware gateway (SH1).
 *
 * The implementation was born here and PROMOTED to `@ownware/client`
 * (packages/client) — the public SDK every consumer shares (channels,
 * the web widget, customer apps). This file re-exports it so shuttle
 * keeps exactly one seam (`GatewayClient` = run + streamReply) and the
 * whole package keeps working unchanged; there is deliberately no
 * second copy of the transport code.
 */

export type {
  RunInput,
  RunResult,
  RunStreamEvent,
  StreamReplyOptions,
  GatewayClient,
  HttpGatewayClientOptions,
} from '@ownware/client'
export { HttpGatewayClient, OwnwareClient, interpretSseEvent, parseSseFrames } from '@ownware/client'
