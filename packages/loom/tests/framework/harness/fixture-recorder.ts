/**
 * Fixture Recorder
 *
 * Saves real event streams to disk as JSON files for:
 * 1. Automated LLM review (feed to Sonnet for protocol analysis)
 * 2. Regression detection (compare against previous runs)
 * 3. Frontend development (client devs use fixtures as test data)
 *
 * Adapted from the Cortex framework's fixture-recorder.ts but works
 * with Loom's EventStream instead of SSE text.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventStream } from './event-collector.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureMetadata {
  /** The prompt that generated this stream. */
  readonly prompt?: string
  /** Model used. */
  readonly model?: string
  /** What behavior was expected. */
  readonly expectedBehavior?: string
  /** Tool preset or custom tool names. */
  readonly tools?: string
  /** Any additional context. */
  readonly [key: string]: string | undefined
}

interface RecordedFixture {
  readonly recordedAt: string
  readonly metadata: FixtureMetadata
  readonly eventCount: number
  readonly eventCounts: Record<string, number>
  readonly completed: boolean
  readonly endReason: string | null
  readonly errors: Array<{ code: string; message: string }>
  readonly analysis: {
    readonly text: string
    readonly thinking: string
    readonly tools: Array<{
      readonly toolName: string
      readonly result: string
      readonly isError: boolean
      readonly durationMs: number
    }>
    readonly agents: Array<{
      readonly agentId: string
      readonly profileName: string
      readonly result: string
      readonly durationMs: number
    }>
    readonly permissions: Array<{
      readonly toolName: string
      readonly granted: boolean | null
    }>
    readonly usage: { inputTokens: number; outputTokens: number; costUsd: number }
    readonly turnCount: number
  }
  readonly events: ReadonlyArray<{ type: string; data: unknown; index: number }>
}

export interface RecorderOptions {
  /** Whether recording is enabled. Default: false. */
  readonly enabled?: boolean
  /** Output directory. Default: tests/framework/fixtures/ */
  readonly dir?: string
}

// ---------------------------------------------------------------------------
// FixtureRecorder
// ---------------------------------------------------------------------------

export class FixtureRecorder {
  private enabled: boolean
  private dir: string
  private runDir: string | null = null
  private fixtureIndex = 0
  private pending: Array<{ name: string; fixture: RecordedFixture }> = []

  constructor(opts: RecorderOptions = {}) {
    this.enabled = opts.enabled ?? (process.env['RECORD_FIXTURES'] === '1')
    this.dir = opts.dir ?? join(__dirname, '..', 'fixtures')
  }

  /**
   * Record an event stream to disk.
   *
   * @param name - Descriptive name (becomes filename)
   * @param stream - The collected EventStream
   * @param metadata - Context about what generated this stream
   */
  record(name: string, stream: EventStream, metadata: FixtureMetadata = {}): void {
    if (!this.enabled) return

    this.fixtureIndex++
    const fixture = buildFixture(stream, metadata)
    this.pending.push({
      name: `${String(this.fixtureIndex).padStart(2, '0')}-${name}`,
      fixture,
    })
  }

  /**
   * Flush all pending recordings to disk.
   * Call this in afterAll() to write fixtures.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.pending.length === 0) return

    // Create timestamped run directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.runDir = join(this.dir, timestamp)
    await mkdir(this.runDir, { recursive: true })

    // Write index
    const index = {
      recordedAt: new Date().toISOString(),
      fixtureCount: this.pending.length,
      fixtures: this.pending.map(p => p.name),
    }
    await writeFile(join(this.runDir, 'index.json'), JSON.stringify(index, null, 2))

    // Write each fixture
    for (const { name, fixture } of this.pending) {
      await writeFile(
        join(this.runDir, `${name}.json`),
        JSON.stringify(fixture, null, 2),
      )
    }

    this.pending = []
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildFixture(stream: EventStream, metadata: FixtureMetadata): RecordedFixture {
  return {
    recordedAt: new Date().toISOString(),
    metadata,
    eventCount: stream.count,
    eventCounts: stream.eventCounts(),
    completed: stream.completed(),
    endReason: stream.endReason(),
    errors: stream.errors().map(e => ({ code: e.code, message: e.message })),
    analysis: {
      text: stream.text(),
      thinking: stream.thinking(),
      tools: stream.tools().map(t => ({
        toolName: t.toolName,
        result: t.result.slice(0, 500),
        isError: t.isError,
        durationMs: t.durationMs,
      })),
      agents: stream.agents(),
      permissions: stream.permissions().map(p => ({
        toolName: p.toolName,
        granted: p.granted,
      })),
      usage: stream.usage(),
      turnCount: stream.turnCount(),
    },
    events: stream.events.map((e, i) => ({
      type: e.type,
      data: e,
      index: i,
    })),
  }
}

// ---------------------------------------------------------------------------
// __dirname shim for ESM
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
