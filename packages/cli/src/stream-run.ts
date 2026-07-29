/**
 * One run's stream, from first event to terminal — the testable core of
 * the chat loop.
 *
 * Extracted from the REPL so the approval round-trip, esc-cancel, and
 * reconnect behavior can be proven over the REAL wire with a scripted
 * key source (a TTY isn't scriptable from a test). The REPL wires
 * `process.stdin` raw mode into `KeyChannel`; tests emit keys directly.
 *
 * Decision delivery: prefer the exact run-permission route
 * (`decidePermission` with the wire's `operationHash` — one response
 * can never affect sibling requests); fall back to the legacy thread
 * `resume` route only when the event carries no hash.
 */

import { OwnwareClient, interpretSseEvent, type GatewayEvent } from '@ownware/client'
import type { RunRenderer } from './render.js'
import type { Style } from './style.js'

export const KEY_ESC = '\u001b'
export const KEY_CTRL_C = '\u0003'

/**
 * A source of raw keypresses for the duration of one run. `capture`
 * installs the single active handler and returns a dispose function.
 * `null` capability means no raw keys (non-TTY) — approvals fall back
 * to line input and esc-cancel is unavailable.
 */
export interface KeyChannel {
  capture(handler: (key: string) => void): () => void
}

/** Sanitized wire truth of one pending approval, for presentation. */
export interface ApprovalInfo {
  readonly requestId: string
  readonly toolName: string
  readonly reason: string
  readonly inputSummary: string | null
  readonly zoneName: string | null
  readonly severityTag: string | null
}

export interface StreamRunDeps {
  readonly client: OwnwareClient
  readonly renderer: RunRenderer
  readonly style: Style
  readonly out: (chunk: string) => void
  readonly keys: KeyChannel | null
  /** Line-based question (readline) — the non-TTY approval fallback. */
  readonly askLine: (question: string) => Promise<string>
  /**
   * Owns approval presentation when set (the TUI pins a card in the
   * composed bottom — render spec: it can never scroll away). When
   * absent, the card prints inline into the transcript and y/n come
   * from `keys`/`askLine`. Either way the DECISION is posted by
   * streamRun on the exact run-permission route.
   */
  readonly presentApproval?: (info: ApprovalInfo) => Promise<ApprovalDecision>
  /** Observe every raw event (sub-agent lifecycle, metrics) — never renders. */
  readonly onEvent?: (ev: GatewayEvent) => void
  /**
   * Reconnect state for the status line: attempt number while retrying
   * (`⟳ retry 2`), 0 when the stream is healthy again.
   */
  readonly onRetry?: (attempt: number) => void
}

/**
 * `always-tool` / `always-profile` grant via the legacy resume route
 * (`action:'always'` + scope) — the gateway grants at the request's own
 * zone and persists the rule; the pending request resolves with it.
 */
export type ApprovalDecision = 'approve' | 'deny' | 'always-tool' | 'always-profile'

export interface StreamRunParams {
  /** What to subscribe to: a runId (bounded) or legacy threadId. */
  readonly streamId: string
  /** The run being streamed; null when tailing a legacy thread stream. */
  readonly runId: string | null
  readonly threadId: string
  /** Resume cursor — replay events with seq > since. */
  readonly since?: number
}

export async function streamRun(deps: StreamRunDeps, params: StreamRunParams): Promise<void> {
  const { renderer, style: s, out } = deps
  const abort = new AbortController()
  let cancelRequested = false

  // Single active key handler: normally the esc-cancel watcher; while an
  // approval card is open, a one-shot waiter takes priority.
  let waiter: ((key: string) => void) | null = null
  const nextKey = (): Promise<string> =>
    new Promise((resolveKey) => {
      waiter = resolveKey
    })

  const requestCancel = () => {
    if (cancelRequested) return
    cancelRequested = true
    renderer.flushLine()
    out(s.dim('⎋ cancelling...\n'))
    void (params.runId !== null
      ? deps.client.cancel(params.runId)
      : deps.client.abort(params.threadId)
    ).catch((err: unknown) => {
      out(s.red(`✖ cancel failed: ${errorMessage(err)}\n`))
    })
  }

  const dispose = deps.keys?.capture((key) => {
    if (waiter !== null) {
      const resolveKey = waiter
      waiter = null
      resolveKey(key)
      return
    }
    if (key === KEY_ESC || key === KEY_CTRL_C) requestCancel()
  })

  const decideApproval = async (
    ev: { requestId: string; toolName: string; reason: string; operationHash?: string },
    raw: Record<string, unknown>,
  ): Promise<void> => {
    renderer.flushLine()
    const summary = typeof raw['inputSummary'] === 'string' ? raw['inputSummary'] : null
    const zone = typeof raw['zoneName'] === 'string' ? raw['zoneName'] : null
    const severity = typeof raw['severityTag'] === 'string' ? raw['severityTag'] : null

    let decision: ApprovalDecision
    if (deps.presentApproval !== undefined) {
      decision = await deps.presentApproval({
        requestId: ev.requestId,
        toolName: ev.toolName,
        reason: ev.reason,
        inputSummary: summary,
        zoneName: zone,
        severityTag: severity,
      })
    } else {
      decision = await inlineApproval(ev, summary, zone)
    }

    try {
      if (decision === 'always-tool' || decision === 'always-profile') {
        const scope = decision === 'always-profile' ? 'profile' : 'tool'
        await deps.client.resume(params.threadId, {
          action: 'always',
          scope,
          requestId: ev.requestId,
        })
        out(
          s.green('✓') +
            ` allowed ${s.bold(ev.toolName)} ` +
            s.dim(
              `· always for ${scope === 'profile' ? 'this profile' : 'this tool'} · rule saved at its zone`,
            ) +
            '\n',
        )
      } else if (params.runId !== null && ev.operationHash !== undefined) {
        await deps.client.decidePermission(params.runId, ev.requestId, {
          decision,
          operationHash: ev.operationHash,
        })
      } else {
        await deps.client.resume(params.threadId, { action: decision, requestId: ev.requestId })
      }
    } catch (err) {
      out(s.red(`✖ could not deliver the decision: ${errorMessage(err)}\n`))
    }
  }

  const inlineApproval = async (
    ev: { toolName: string; reason: string },
    summary: string | null,
    zone: string | null,
  ): Promise<ApprovalDecision> => {
    out('\n' + s.bold('Approval needed') + '\n')
    out(`  ${s.cyan(ev.toolName)} — ${ev.reason}\n`)
    if (summary !== null) out(s.dim(`  ${summary}${zone !== null ? ` · zone ${zone}` : ''}\n`))
    out(s.dim('  arguments withheld by the gateway\n'))

    let decision: 'approve' | 'deny'
    if (deps.keys !== null) {
      out(s.dim('  [y] approve · [n] deny · [esc] deny\n'))
      for (;;) {
        const key = await nextKey()
        if (key === 'y' || key === 'Y') {
          decision = 'approve'
          break
        }
        if (key === 'n' || key === 'N' || key === KEY_ESC || key === KEY_CTRL_C) {
          decision = 'deny'
          break
        }
      }
    } else {
      const answer = (await deps.askLine('  approve? (y/n) ')).trim().toLowerCase()
      decision = answer === 'y' || answer === 'yes' ? 'approve' : 'deny'
    }
    return decision
  }

  // The stream survives drops: reconnect with `since=lastSeq` (the wire
  // replays only seq > since — no duplicated output), bounded backoff,
  // the status line told via onRetry. A user cancel is never retried.
  const MAX_RETRIES = 5
  let lastSeq = params.since ?? 0
  let attempts = 0
  try {
    stream: for (;;) {
      try {
        const streamOpts =
          lastSeq === 0
            ? { signal: abort.signal }
            : { since: lastSeq, signal: abort.signal }
        for await (const ev of deps.client.events(params.streamId, streamOpts)) {
          if (attempts > 0) {
            attempts = 0
            deps.onRetry?.(0)
          }
          deps.onEvent?.(ev)
          renderer.handle(ev.type, ev.data)
          const interpreted = interpretSseEvent(ev.type, ev.data, lastSeq)
          lastSeq = interpreted.seq
          if (interpreted.event?.type === 'permission') {
            await decideApproval(interpreted.event, ev.data)
          }
          if (interpreted.stop) break stream
        }
        // A bounded run stream closing without its terminal event is a
        // drop in disguise — fall through to the retry path.
        throw new Error('stream closed before the run finished')
      } catch (err) {
        if (abort.signal.aborted || cancelRequested) break
        attempts += 1
        if (attempts > MAX_RETRIES) {
          renderer.flushLine()
          out(s.red(`✖ stream lost after ${MAX_RETRIES} reconnect attempts: ${errorMessage(err)}\n`))
          break
        }
        deps.onRetry?.(attempts)
        if (attempts === 1) {
          renderer.flushLine()
          out(s.dim(`⟳ reconnecting…\n`))
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(1000 * attempts, 5000)))
      }
    }
  } finally {
    deps.onRetry?.(0)
    abort.abort()
    dispose?.()
    renderer.flushLine()
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
