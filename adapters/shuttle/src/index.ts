/**
 * @ownware/shuttle — messaging channel adapters for ownware.
 *
 * A shuttle carries messages back and forth between a chat platform and the
 * agent. Each channel is a thin client of the ownware gateway wire contract:
 * receive a message → drive the agent (`POST /run` + tail SSE) → deliver the
 * reply back to the source. One agent, many identities, one thread per person.
 *
 * SH0 (this slice): the session-key oracle + the ThreadMap store — the seam
 * that keeps every conversation continuous and isolated without touching the
 * engine. The base adapter, policies, delivery modes, and channels (Telegram
 * first) build on top of these in later slices.
 */

export type {
  ChatType,
  SessionKeyParts,
  SessionKeyOptions,
  ThreadMap,
  ShuttleMessage,
  GroupPolicy,
} from './types.js'
export { isChatType } from './types.js'

export {
  sessionKey,
  isSessionKey,
  sessionKeyPrefix,
  parseSessionKey,
} from './session-key.js'

export { InMemoryThreadMap } from './thread-map.js'

export type {
  DeliveryMode,
  ReplyEvent,
  ChannelTransport,
  DeliveryPolicy,
  DeliveryResult,
} from './delivery.js'
export { deliver, resolveMode, chunkText } from './delivery.js'

export type {
  RunInput,
  RunResult,
  RunStreamEvent,
  StreamReplyOptions,
  GatewayClient,
  HttpGatewayClientOptions,
} from './gateway-client.js'
export {
  HttpGatewayClient,
  interpretSseEvent,
  parseSseFrames,
} from './gateway-client.js'

export type {
  ShuttleConfig,
  ShuttleDeps,
} from './adapter.js'
export { ShuttleAdapter } from './adapter.js'

export type {
  Disposition,
  DmPolicy,
  HandoffPolicy,
  LinePolicy,
  LlmGate,
  ResponseGate,
  PolicyGateDeps,
} from './gate.js'
export { PolicyGate } from './gate.js'

export type { PairingStore, InMemoryPairingOptions, FilePairingStoreOptions } from './pairing.js'
export { InMemoryPairingStore, FilePairingStore, PairingRateLimitError } from './pairing.js'

export type { DebouncerOptions } from './debouncer.js'
export { Debouncer } from './debouncer.js'
