/**
 * Barrel export for the Loom test framework harness.
 *
 * Usage:
 *   import { createTestSession, assertStreamCompleted, collectEvents } from './harness/index.js'
 */

// Session
export { createTestSession } from './session.js'
export type { TestSession, TestSessionOptions } from './session.js'

// Event collection
export { collectEvents, collectEventsWithResponder } from './event-collector.js'
export type { EventStream, ToolCallRecord, AgentRecord, PermissionRecord } from './event-collector.js'

// Sandbox
export { createSandbox } from './sandbox.js'
export type { Sandbox } from './sandbox.js'

// Tool fixtures
export {
  fullToolSet,
  codingToolSet,
  readOnlyToolSet,
  noTools,
  calculatorTool,
  failingTool,
  slowTool,
  permissionTool,
  resolveTools,
} from './tools-fixture.js'
export type { ToolPreset } from './tools-fixture.js'

// Fixture recording
export { FixtureRecorder } from './fixture-recorder.js'
export type { FixtureMetadata } from './fixture-recorder.js'

// Assertions
export {
  assertStreamCompleted,
  assertEndReason,
  assertHasEvent,
  assertNoEvent,
  assertEventCount,
  assertTextContains,
  assertTextNotContains,
  assertHasUsage,
  assertToolCalled,
  assertToolSucceeded,
  assertToolFailed,
  getToolCalls,
  assertAgentSpawned,
  assertPermissionRequested,
  assertNoPermissionRequests,
  assertEventOrder,
} from './assertions.js'
