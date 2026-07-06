/**
 * Custom Test Assertions
 *
 * Reusable assertion helpers for common test patterns.
 * Use these instead of inline expect() chains for better failure messages.
 */

import { expect } from 'vitest'
import type { ZodType } from 'zod'
import type { ApiResponse } from './api-client.js'
import type { SSEStream } from './sse-parser.js'

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export function assertSchema<T>(value: unknown, schema: ZodType<T>, label = 'response'): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const errors = result.error.errors.map(e => `  - ${e.path.join('.')}: ${e.message}`).join('\n')
    throw new Error(`Schema validation failed for ${label}:\n${errors}\n\nValue: ${JSON.stringify(value, null, 2)}`)
  }
  return result.data
}

// ---------------------------------------------------------------------------
// HTTP responses
// ---------------------------------------------------------------------------

export function assertOk<T>(response: ApiResponse<T>, label?: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Expected 2xx response${label ? ` for ${label}` : ''}, got ${response.status}\n` +
      `Body: ${JSON.stringify(response.body, null, 2)}`,
    )
  }
}

export function assertStatus<T>(response: ApiResponse<T>, expected: number, label?: string): void {
  if (response.status !== expected) {
    throw new Error(
      `Expected status ${expected}${label ? ` for ${label}` : ''}, got ${response.status}\n` +
      `Body: ${JSON.stringify(response.body, null, 2)}`,
    )
  }
}

export function assertError<T>(response: ApiResponse<T>, expectedStatus: number): void {
  expect(response.status).toBe(expectedStatus)
  expect(response.body).toMatchObject({
    error: expect.any(String),
    message: expect.any(String),
  })
}

// ---------------------------------------------------------------------------
// SSE streams
// ---------------------------------------------------------------------------

export function assertStreamCompleted(stream: SSEStream): void {
  if (!stream.completed()) {
    throw new Error(
      `SSE stream did not complete (no 'done' event).\n` +
      `Events received: ${JSON.stringify(stream.eventCounts(), null, 2)}\n` +
      `Errors: ${JSON.stringify(stream.errors(), null, 2)}`,
    )
  }
  if (stream.errors().length > 0) {
    throw new Error(
      `SSE stream completed but had errors:\n${JSON.stringify(stream.errors(), null, 2)}`,
    )
  }
}

export function assertHasEvent(stream: SSEStream, eventType: string): void {
  if (!stream.hasEvent(eventType)) {
    throw new Error(
      `Expected SSE stream to contain '${eventType}' event.\n` +
      `Events seen: ${Object.keys(stream.eventCounts()).join(', ')}`,
    )
  }
}

export function assertEventCount(stream: SSEStream, eventType: string, count: number): void {
  const actual = stream.eventCounts()[eventType] ?? 0
  if (actual !== count) {
    throw new Error(
      `Expected ${count} '${eventType}' events, got ${actual}.\n` +
      `All counts: ${JSON.stringify(stream.eventCounts(), null, 2)}`,
    )
  }
}

export function assertHasUsage(stream: SSEStream): void {
  const usage = stream.usage()
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    throw new Error(
      `SSE stream has zero usage. Expected both inputTokens and outputTokens > 0.\n` +
      `Got: ${JSON.stringify(usage)}`,
    )
  }
}

export function assertTextContains(stream: SSEStream, substring: string, caseSensitive = false): void {
  const text = caseSensitive ? stream.text() : stream.text().toUpperCase()
  const needle = caseSensitive ? substring : substring.toUpperCase()
  if (!text.includes(needle)) {
    throw new Error(
      `Expected SSE text to contain "${substring}".\n` +
      `Got: "${stream.text().slice(0, 500)}${stream.text().length > 500 ? '...' : ''}"`,
    )
  }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function assertPaginated(value: unknown, opts?: {
  totalAtLeast?: number
  itemsLength?: number
  limit?: number
}): void {
  expect(value).toMatchObject({
    items: expect.any(Array),
    total: expect.any(Number),
    offset: expect.any(Number),
    limit: expect.any(Number),
  })
  const v = value as { items: unknown[]; total: number; limit: number }
  if (opts?.totalAtLeast !== undefined) {
    expect(v.total).toBeGreaterThanOrEqual(opts.totalAtLeast)
  }
  if (opts?.itemsLength !== undefined) {
    expect(v.items).toHaveLength(opts.itemsLength)
  }
  if (opts?.limit !== undefined) {
    expect(v.limit).toBe(opts.limit)
  }
}
