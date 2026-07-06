import { describe, it, expect } from 'vitest'
import { MetricsCollector } from '../../../src/observability/metrics.js'

describe('MetricsCollector — tool call tracking (bytes optional)', () => {
  it('tracks count, duration, errors with no byte data (back-compat)', () => {
    const m = new MetricsCollector()
    m.trackToolCall('readFile', 12, false)
    m.trackToolCall('readFile', 8, true)

    const summary = m.getSummary()
    expect(summary.toolCalls.readFile?.count).toBe(2)
    expect(summary.toolCalls.readFile?.totalDurationMs).toBe(20)
    expect(summary.toolCalls.readFile?.errorCount).toBe(1)
    expect(summary.toolCalls.readFile?.bytesRaw).toBe(0)
    expect(summary.toolCalls.readFile?.bytesToModel).toBe(0)
  })

  it('aggregates byte counts and surfaces savings', () => {
    const m = new MetricsCollector()
    // Three tool calls — two truncated, one not
    m.trackToolCall('shell', 50, false, { raw: 100_000, toModel: 50_000, truncated: true })
    m.trackToolCall('shell', 40, false, { raw: 250_000, toModel: 50_000, truncated: true })
    m.trackToolCall('readFile', 5, false, { raw: 2_000, toModel: 2_000, truncated: false })

    const summary = m.getSummary()
    expect(summary.toolCalls.shell?.bytesRaw).toBe(350_000)
    expect(summary.toolCalls.shell?.bytesToModel).toBe(100_000)
    expect(summary.toolCalls.shell?.truncatedCount).toBe(2)

    expect(summary.toolCalls.readFile?.bytesRaw).toBe(2_000)
    expect(summary.toolCalls.readFile?.truncatedCount).toBe(0)

    expect(summary.contextSavings.totalBytesRaw).toBe(352_000)
    expect(summary.contextSavings.totalBytesToModel).toBe(102_000)
    expect(summary.contextSavings.bytesSaved).toBe(250_000)
    expect(summary.contextSavings.savingsRatio).toBeCloseTo(250_000 / 352_000, 5)
  })

  it('reports zero savings when no tool output produced', () => {
    const m = new MetricsCollector()
    m.trackTokenUsage('claude', 100, 50, 0, 0)
    expect(m.getSummary().contextSavings.savingsRatio).toBe(0)
    expect(m.getSummary().contextSavings.bytesSaved).toBe(0)
  })

  it('reset clears byte counters', () => {
    const m = new MetricsCollector()
    m.trackToolCall('shell', 10, false, { raw: 1000, toModel: 200, truncated: true })
    m.reset()
    const summary = m.getSummary()
    expect(summary.contextSavings.totalBytesRaw).toBe(0)
    expect(summary.toolCalls).toEqual({})
  })
})
