/**
 * Stress Test: Parallel Sessions
 *
 * Runs multiple independent sessions concurrently.
 * Verifies no cross-contamination between sessions.
 */

import { describe, it, expect } from 'vitest'
import {
  createTestSession,
  assertStreamCompleted,
  assertTextContains,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Stress: Parallel Sessions', () => {
  it('3 concurrent sessions produce independent results', async () => {
    const codes = ['ALPHA-111', 'BETA-222', 'GAMMA-333']
    const sessions = await Promise.all(
      codes.map(() => createTestSession({
        tools: 'none',
        maxTurns: 1,
        maxTokens: 128,
      })),
    )

    try {
      // Run all 3 sessions in parallel with unique content
      const streams = await Promise.all(
        sessions.map((ts, i) =>
          ts.run(`Say exactly: ${codes[i]}. Nothing else.`),
        ),
      )

      // Each should complete independently
      for (let i = 0; i < 3; i++) {
        assertStreamCompleted(streams[i]!)
        assertTextContains(streams[i]!, codes[i]!)
      }

      // No cross-contamination: each session's text should only contain its code
      for (let i = 0; i < 3; i++) {
        const text = streams[i]!.text()
        for (let j = 0; j < 3; j++) {
          if (i !== j) {
            expect(text).not.toContain(codes[j])
          }
        }
      }
    } finally {
      await Promise.all(sessions.map(ts => ts.cleanup()))
    }
  }, 60_000)

  it('5 sessions with tools run without interference', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => createTestSession({
        tools: 'readonly',
        maxTurns: 3,
        maxTokens: 256,
      })),
    )

    try {
      // Each reads its own unique file
      await Promise.all(sessions.map(async (ts, i) => {
        await ts.sandbox!.writeFile(`data-${i}.txt`, `SESSION_${i}_DATA`)
      }))

      const streams = await Promise.all(
        sessions.map((ts, i) =>
          ts.run(`Read the file ${ts.sandbox!.path}/data-${i}.txt and report its contents.`),
        ),
      )

      for (let i = 0; i < 5; i++) {
        assertStreamCompleted(streams[i]!)
        assertTextContains(streams[i]!, `SESSION_${i}_DATA`)
      }
    } finally {
      await Promise.all(sessions.map(ts => ts.cleanup()))
    }
  }, 120_000)
})
