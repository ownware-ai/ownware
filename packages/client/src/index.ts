/**
 * @ownware/client — talk to your Ownware agent from anywhere.
 *
 * The typed SDK over the gateway wire contract (HTTP + SSE). Zero
 * dependencies, no Node-only APIs: the same package works in Node and
 * the browser. The server half is the `ownware` package (OwnwareGateway);
 * this is the plug that connects to it.
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
 *   const { threadId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
 *   for await (const ev of ownware.streamReply(threadId)) {
 *     if (ev.type === 'delta') process.stdout.write(ev.text)
 *   }
 *
 * The wire contract itself is versioned in `spec/` (OpenAPI + AsyncAPI).
 */

export type {
  RunInput,
  RunResult,
  StreamReplyOptions,
  GatewayEvent,
  ResumeInput,
  ModelEntry,
  HealthResult,
  GatewayClient,
  OwnwareClientOptions,
  HttpGatewayClientOptions,
} from './client.js'
export { OwnwareClient, HttpGatewayClient } from './client.js'

export type { RunStreamEvent } from './run-stream.js'
export { interpretSseEvent } from './run-stream.js'

export { parseSseFrames } from './sse.js'
