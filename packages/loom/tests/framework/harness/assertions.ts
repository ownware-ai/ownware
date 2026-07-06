/**
 * Custom Assertions
 *
 * Typed assertion helpers for event streams. Every assertion throws with
 * a detailed error message including context (event counts, stream state, etc.)
 * so failures are immediately diagnosable.
 */

import { expect } from 'vitest'
import type { EventStream, ToolCallRecord } from './event-collector.js'

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Assert the stream completed successfully (session.end with non-error reason).
 * Throws with event counts and error details if not.
 */
export function assertStreamCompleted(stream: EventStream): void {
  const errors = stream.errors()
  const counts = stream.eventCounts()

  if (stream.error) {
    throw new Error(
      `Stream threw an error: ${stream.error.message}\n` +
      `Events collected before error: ${stream.count}\n` +
      `Event counts: ${JSON.stringify(counts, null, 2)}`,
    )
  }

  if (!stream.completed()) {
    const endReason = stream.endReason()
    throw new Error(
      `Stream did not complete successfully.\n` +
      `End reason: ${endReason ?? 'no session.end event'}\n` +
      `Errors: ${errors.length > 0 ? JSON.stringify(errors) : 'none'}\n` +
      `Event counts: ${JSON.stringify(counts, null, 2)}`,
    )
  }
}

/**
 * Assert the stream ended with a specific reason.
 */
export function assertEndReason(stream: EventStream, reason: string): void {
  const actual = stream.endReason()
  if (actual !== reason) {
    throw new Error(
      `Expected end reason "${reason}" but got "${actual}"\n` +
      `Event counts: ${JSON.stringify(stream.eventCounts(), null, 2)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Event presence
// ---------------------------------------------------------------------------

/**
 * Assert that at least one event of the given type exists in the stream.
 */
export function assertHasEvent(stream: EventStream, eventType: string): void {
  if (!stream.hasEvent(eventType)) {
    throw new Error(
      `Expected event "${eventType}" but it was not found.\n` +
      `Available events: ${Object.keys(stream.eventCounts()).join(', ')}`,
    )
  }
}

/**
 * Assert that no events of the given type exist in the stream.
 */
export function assertNoEvent(stream: EventStream, eventType: string): void {
  if (stream.hasEvent(eventType)) {
    const count = stream.eventCounts()[eventType]
    throw new Error(
      `Expected no "${eventType}" events but found ${count}.`,
    )
  }
}

/**
 * Assert the exact count of a specific event type.
 */
export function assertEventCount(stream: EventStream, eventType: string, expected: number): void {
  const actual = stream.eventCounts()[eventType] ?? 0
  if (actual !== expected) {
    throw new Error(
      `Expected ${expected} "${eventType}" events but found ${actual}.\n` +
      `All counts: ${JSON.stringify(stream.eventCounts(), null, 2)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Assert the accumulated text contains a substring (case-insensitive by default).
 */
export function assertTextContains(
  stream: EventStream,
  substring: string,
  caseSensitive = false,
): void {
  const text = stream.text()
  const match = caseSensitive
    ? text.includes(substring)
    : text.toLowerCase().includes(substring.toLowerCase())

  if (!match) {
    const preview = text.length > 200 ? text.slice(0, 200) + '...' : text
    throw new Error(
      `Expected text to contain "${substring}" (caseSensitive=${caseSensitive})\n` +
      `Actual text: "${preview}"`,
    )
  }
}

/**
 * Assert the accumulated text does NOT contain a substring.
 */
export function assertTextNotContains(
  stream: EventStream,
  substring: string,
  caseSensitive = false,
): void {
  const text = stream.text()
  const match = caseSensitive
    ? text.includes(substring)
    : text.toLowerCase().includes(substring.toLowerCase())

  if (match) {
    throw new Error(`Expected text NOT to contain "${substring}" but it does.`)
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Assert the stream has non-zero usage (inputTokens > 0 AND outputTokens > 0).
 */
export function assertHasUsage(stream: EventStream): void {
  const usage = stream.usage()
  if (usage.inputTokens <= 0 || usage.outputTokens <= 0) {
    throw new Error(
      `Expected non-zero usage but got: ` +
      `inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Assert at least one tool call exists with the given name.
 */
export function assertToolCalled(stream: EventStream, toolName: string): void {
  const tools = stream.tools()
  const match = tools.find(t => t.toolName === toolName)
  if (!match) {
    const called = tools.map(t => t.toolName)
    throw new Error(
      `Expected tool "${toolName}" to be called.\n` +
      `Tools called: ${called.length > 0 ? called.join(', ') : 'none'}`,
    )
  }
}

/**
 * Assert a tool call succeeded (isError === false).
 */
export function assertToolSucceeded(stream: EventStream, toolName: string): void {
  const tools = stream.tools()
  const match = tools.find(t => t.toolName === toolName)
  if (!match) {
    throw new Error(`Tool "${toolName}" was not called.`)
  }
  if (match.isError) {
    throw new Error(
      `Expected tool "${toolName}" to succeed but it returned error:\n${match.result}`,
    )
  }
}

/**
 * Assert a tool call failed (isError === true).
 */
export function assertToolFailed(stream: EventStream, toolName: string): void {
  const tools = stream.tools()
  const match = tools.find(t => t.toolName === toolName)
  if (!match) {
    throw new Error(`Tool "${toolName}" was not called.`)
  }
  if (!match.isError) {
    throw new Error(
      `Expected tool "${toolName}" to fail but it succeeded:\n${match.result.slice(0, 200)}`,
    )
  }
}

/**
 * Get all tool calls matching a name. Throws if none found.
 */
export function getToolCalls(stream: EventStream, toolName: string): ToolCallRecord[] {
  const calls = stream.tools().filter(t => t.toolName === toolName)
  if (calls.length === 0) {
    throw new Error(
      `No tool calls found for "${toolName}".\n` +
      `Available: ${stream.tools().map(t => t.toolName).join(', ') || 'none'}`,
    )
  }
  return calls
}

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

/**
 * Assert at least one sub-agent was spawned.
 */
export function assertAgentSpawned(stream: EventStream, profileName?: string): void {
  const agents = stream.agents()
  if (profileName) {
    const match = agents.find(a => a.profileName === profileName)
    if (!match) {
      throw new Error(
        `Expected agent "${profileName}" to be spawned.\n` +
        `Agents spawned: ${agents.map(a => a.profileName).join(', ') || 'none'}`,
      )
    }
  } else if (agents.length === 0) {
    throw new Error('Expected at least one agent to be spawned but none were.')
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Assert that a permission request was made for a tool.
 */
export function assertPermissionRequested(stream: EventStream, toolName: string): void {
  const perms = stream.permissions()
  const match = perms.find(p => p.toolName === toolName)
  if (!match) {
    throw new Error(
      `Expected permission request for "${toolName}".\n` +
      `Permission requests: ${perms.map(p => p.toolName).join(', ') || 'none'}`,
    )
  }
}

/**
 * Assert that no permission requests were made.
 */
export function assertNoPermissionRequests(stream: EventStream): void {
  const perms = stream.permissions()
  if (perms.length > 0) {
    throw new Error(
      `Expected no permission requests but got ${perms.length}: ` +
      perms.map(p => p.toolName).join(', '),
    )
  }
}

// ---------------------------------------------------------------------------
// Event ordering
// ---------------------------------------------------------------------------

/**
 * Assert that event type A appears before event type B in the stream.
 */
export function assertEventOrder(stream: EventStream, before: string, after: string): void {
  const events = stream.events
  const firstBefore = events.findIndex(e => e.type === before)
  const firstAfter = events.findIndex(e => e.type === after)

  if (firstBefore === -1) {
    throw new Error(`Event "${before}" not found in stream.`)
  }
  if (firstAfter === -1) {
    throw new Error(`Event "${after}" not found in stream.`)
  }
  if (firstBefore >= firstAfter) {
    throw new Error(
      `Expected "${before}" (index ${firstBefore}) to appear before "${after}" (index ${firstAfter}).`,
    )
  }
}
