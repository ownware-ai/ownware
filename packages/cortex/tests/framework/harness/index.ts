/**
 * Harness barrel export — single import point for all tests.
 *
 * Usage:
 *   import { createTestGateway, ApiClient, parseSSE, ... } from '../harness/index.js'
 */

export { createTestGateway } from './gateway.js'
export type { TestGateway, TestGatewayOptions, ProfileDefinition } from './gateway.js'

export { ApiClient } from './api-client.js'
export type { ApiResponse } from './api-client.js'

export {
  parseSSE,
} from './sse-parser.js'
export type {
  SSEStream,
  SSEEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  AgentSpawnEvent,
  AgentCompleteEvent,
  PermissionRequestEvent,
  PermissionResponseEvent,
  TurnEndEvent,
} from './sse-parser.js'

export { FixtureRecorder } from './fixture-recorder.js'

export * from './schema-validator.js'
export * from './assertions.js'
