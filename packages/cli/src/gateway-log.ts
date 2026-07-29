/**
 * Console redirection for the owned in-process gateway (BUGS #1).
 *
 * The gateway and engine log through `console.*` — boot traces, connector
 * status, pricing warnings, session-runner errors. When the CLI boots the
 * gateway in-process those lines land in the middle of the chat
 * transcript (one landed mid-word: `pong[loom/pricing]…`). The transcript
 * is the product; the logs still matter for debugging — so they are
 * redirected, not dropped: every console call goes to
 * `<dataDir>/cli/gateway.log` for the lifetime of the owned gateway.
 *
 * The CLI's own output never uses `console.*` (it writes to the output
 * stream directly), so redirection cannot eat product output. Attached
 * (`--base-url`) gateways log in their own process and need none of this.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug', 'trace']

/**
 * Route every `console.*` call to an append-only log file. Returns a
 * restore function; idempotent to call restore more than once.
 */
export function redirectConsoleToFile(file: string): () => void {
  mkdirSync(dirname(file), { recursive: true })
  const stream: WriteStream = createWriteStream(file, { flags: 'a' })
  const original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {}

  for (const method of METHODS) {
    original[method] = console[method]
    console[method] = (...args: unknown[]) => {
      // A dead stream must never take the logs down with it — logging
      // is best-effort; the product is the transcript.
      try {
        stream.write(`${new Date().toISOString()} [${method}] ${format(...args)}\n`)
      } catch {
        /* best-effort */
      }
    }
  }

  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const method of METHODS) {
      console[method] = original[method]!
    }
    stream.end()
  }
}
