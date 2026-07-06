/**
 * Fixture Recorder
 *
 * Saves real API responses and SSE streams to disk as JSON files.
 * Two purposes:
 *
 *   1. Frontend dev: a UI client can use these as Storybook fixtures so devs
 *      can build UI offline against real response shapes.
 *
 *   2. SSE analysis: Saves complete event streams with timestamps so we
 *      can later feed them to Sonnet/Haiku for automated review of agent
 *      behavior, edge cases, and protocol correctness.
 *
 * Activation:
 *   - Set RECORD_FIXTURES=1 env var, OR
 *   - Pass { recordFixtures: true } to createTestGateway()
 *
 * Output structure:
 *   fixtures/
 *   ├── http/                    ← HTTP response snapshots
 *   │   ├── threads-list.json
 *   │   ├── profile-detail.json
 *   │   └── ...
 *   └── sse/                     ← SSE stream snapshots
 *       └── 2026-04-08T12-34-56/  (per-run timestamped folder)
 *           ├── 01-simple-prompt.json
 *           ├── 02-tool-use.json
 *           ├── 03-subagent.json
 *           └── ...
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ApiResponse } from './api-client.js'
import type { SSEStream } from './sse-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureRecorderOptions {
  /** Whether recording is enabled (default: false) */
  readonly enabled: boolean
  /** Output directory (typically <framework>/fixtures) */
  readonly dir: string
}

interface PendingHttpFixture {
  name: string
  payload: unknown
}

interface PendingSseFixture {
  name: string
  payload: unknown
}

// ---------------------------------------------------------------------------
// FixtureRecorder
// ---------------------------------------------------------------------------

export class FixtureRecorder {
  private readonly httpFixtures: PendingHttpFixture[] = []
  private readonly sseFixtures: PendingSseFixture[] = []
  private readonly runStamp: string

  constructor(private readonly opts: FixtureRecorderOptions) {
    // ISO timestamp safe for filenames: 2026-04-08T12-34-56
    this.runStamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
  }

  /**
   * Record an HTTP response. Captures status, body, headers.
   */
  record(name: string, response: ApiResponse<unknown>): void {
    if (!this.opts.enabled) return
    this.httpFixtures.push({
      name,
      payload: {
        recordedAt: new Date().toISOString(),
        status: response.status,
        headers: response.headers,
        body: response.body,
      },
    })
  }

  /**
   * Record an SSE stream. Captures every event with full data, plus
   * derived analysis (text, tools, usage, etc.) for quick review.
   */
  recordSSE(name: string, stream: SSEStream, metadata?: {
    prompt?: string
    profileId?: string
    threadId?: string
    expectedBehavior?: string
  }): void {
    if (!this.opts.enabled) return
    this.sseFixtures.push({
      name,
      payload: {
        recordedAt: new Date().toISOString(),
        metadata: metadata ?? {},
        eventCount: stream.count,
        eventCounts: stream.eventCounts(),
        completed: stream.completed(),
        errors: stream.errors(),
        analysis: {
          text: stream.text(),
          thinking: stream.thinking(),
          tools: stream.tools(),
          agents: stream.agents(),
          permissions: stream.permissions(),
          usage: stream.usage(),
        },
        events: stream.events,
      },
    })
  }

  /**
   * Write all pending fixtures to disk. Called automatically by gw.stop().
   */
  async flush(): Promise<void> {
    if (!this.opts.enabled) return
    if (this.httpFixtures.length === 0 && this.sseFixtures.length === 0) return

    const httpDir = join(this.opts.dir, 'http')
    const sseDir = join(this.opts.dir, 'sse', this.runStamp)

    if (this.httpFixtures.length > 0) {
      await mkdir(httpDir, { recursive: true })
      for (const f of this.httpFixtures) {
        await writeFile(
          join(httpDir, `${f.name}.json`),
          JSON.stringify(f.payload, null, 2),
        )
      }
    }

    if (this.sseFixtures.length > 0) {
      await mkdir(sseDir, { recursive: true })
      // Number them so order is preserved in directory listings
      let i = 1
      for (const f of this.sseFixtures) {
        const numbered = `${String(i).padStart(2, '0')}-${f.name}.json`
        await writeFile(
          join(sseDir, numbered),
          JSON.stringify(f.payload, null, 2),
        )
        i++
      }
      // Also write an index.json summarizing the run
      await writeFile(
        join(sseDir, 'index.json'),
        JSON.stringify({
          runStamp: this.runStamp,
          totalStreams: this.sseFixtures.length,
          streams: this.sseFixtures.map((f, idx) => ({
            file: `${String(idx + 1).padStart(2, '0')}-${f.name}.json`,
            name: f.name,
            metadata: (f.payload as any).metadata,
            eventCount: (f.payload as any).eventCount,
            completed: (f.payload as any).completed,
          })),
        }, null, 2),
      )
    }
  }
}
