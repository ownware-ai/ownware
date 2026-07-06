/**
 * Access logging middleware — structured JSONL output.
 *
 * Writes one JSON object per line to access.jsonl in the configured log directory.
 * Append-only, non-blocking writes via a write stream.
 */

import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessLogEntry {
  readonly ts: string
  readonly method: string
  readonly url: string
  readonly status: number
  readonly durationMs: number
  readonly ip: string | undefined
  readonly userAgent: string | undefined
}

// ---------------------------------------------------------------------------
// Access Logger
// ---------------------------------------------------------------------------

export interface AccessLogger {
  /** Log a completed request. */
  log(req: IncomingMessage, res: ServerResponse, durationMs: number): void
  /** Flush and close the log stream. */
  close(): Promise<void>
  /** Path to the log file. */
  readonly logPath: string
}

export function createAccessLogger(logDir: string): AccessLogger {
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'access.jsonl')
  const stream: WriteStream = createWriteStream(logPath, { flags: 'a' })

  function log(req: IncomingMessage, res: ServerResponse, durationMs: number): void {
    const entry: AccessLogEntry = {
      ts: new Date().toISOString(),
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    }
    stream.write(JSON.stringify(entry) + '\n')
  }

  function close(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stream.end(() => {
        resolve()
      })
      stream.on('error', reject)
    })
  }

  return { log, close, logPath }
}
