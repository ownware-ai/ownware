/**
 * The S1 chat loop — plain readline prompt, streamed replies, approval
 * cards, esc-to-cancel, `--resume`.
 *
 * Everything flows over the wire contract via `@ownware/client`:
 * `run()` → raw `events()` (the normalized streamReply drops tools/
 * thinking) → `decidePermission()` / `cancel()`. The per-run stream
 * machinery lives in `stream-run.ts` (extracted for wire-level tests);
 * this module owns the terminal: readline, raw-mode keys, the prompt,
 * and `--resume` hydration.
 */

import * as readline from 'node:readline'
import { OwnwareClient } from '@ownware/client'
import { buildBanner, type BannerInfo } from './banner.js'
import { TranscriptRenderer } from './render.js'
import type { Style } from './style.js'
import { SessionStore } from './session-store.js'
import { streamRun, errorMessage, KEY_CTRL_C, KEY_ESC, type KeyChannel } from './stream-run.js'

export interface ReplOptions {
  readonly client: OwnwareClient
  readonly baseUrl: string
  readonly token: string | undefined
  readonly profileId: string
  readonly model?: string
  readonly style: Style
  readonly sessionStore: SessionStore
  readonly cwd: string
  readonly resume: boolean
  readonly banner?: BannerInfo
  /** Gateway workspace for this cwd — the zone boundary for file access. */
  readonly workspaceId?: string
  readonly debugEvents?: boolean
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  readonly output?: NodeJS.WritableStream
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const out = (chunk: string) => {
    output.write(chunk)
  }
  const s = opts.style
  const renderer = new TranscriptRenderer({
    style: s,
    out,
    debugEvents: opts.debugEvents === true,
  })

  if (opts.banner !== undefined) out(buildBanner(opts.banner, s))

  const rl = readline.createInterface({ input, output, terminal: input.isTTY === true })
  let closed = false

  // `rl.question` NEVER calls back if the interface closes while a
  // question is outstanding — and at an idle prompt there is always one
  // outstanding. Ctrl-C therefore closed readline while the loop stayed
  // parked forever on a promise that could no longer settle, and the CLI
  // hung until it was killed. Settling the pending ask on close is what
  // lets the loop see `closed` and leave.
  let pendingAsk: ((answer: string) => void) | null = null
  const settlePending = (): void => {
    const resolvePending = pendingAsk
    pendingAsk = null
    if (resolvePending !== null) resolvePending('')
  }
  rl.on('close', () => {
    closed = true
    settlePending()
  })

  const ask = (question: string): Promise<string> =>
    new Promise((resolveAnswer) => {
      if (closed) {
        resolveAnswer('')
        return
      }
      pendingAsk = resolveAnswer
      rl.question(question, (answer) => {
        pendingAsk = null
        resolveAnswer(answer)
      })
    })


  // Raw single-keypress channel (esc-cancel, y/n cards). TTY only: the
  // readline interface is paused while a turn owns the keys.
  //
  // The channel is refcounted and held for the WHOLE turn — from the
  // moment the customer submits, not from the first stream event. It
  // used to open only inside `streamRun`, which left the window between
  // submit and the first event owned by readline: an esc pressed there
  // did not cancel, and the byte was echoed into the next prompt as a
  // literal `^[`, corrupting the following input (FINDINGS F6).
  //
  // Keys arriving in that window are BUFFERED and flushed to the first
  // handler that registers, so an early esc cancels through exactly the
  // same wire path as a mid-stream one. Only esc/ctrl-c are buffered:
  // replaying arbitrary typing could auto-answer an approval card that
  // opens later, which would be far worse than dropping a keystroke.
  const rawCapable = input.isTTY === true && typeof input.setRawMode === 'function'
  const handlers = new Set<(key: string) => void>()
  const buffered: string[] = []
  let holds = 0
  let closeRaw: (() => void) | null = null

  /** Take a share of the raw-key hold; the last release closes it. */
  const acquireKeys = (): (() => void) => {
    if (!rawCapable) return () => {}
    if (holds === 0) {
      const listener = (chunk: Buffer | string) => {
        const key = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        if (handlers.size === 0) {
          if (key === KEY_ESC || key === KEY_CTRL_C) buffered.push(key)
          return
        }
        for (const handler of [...handlers]) handler(key)
      }
      rl.pause()
      input.setRawMode!(true)
      input.on('data', listener)
      // `rl.pause()` pauses stdin EXPLICITLY, and attaching a `data`
      // listener does not undo that. Without this resume the keystroke
      // is not delivered to anyone: it sits in the stream buffer until
      // the turn ends, then flows to readline and surfaces on the next
      // prompt as a literal `^[` — which is why esc appeared to do
      // nothing and corrupted the following message (FINDINGS F6).
      // Proven with an isolated readline probe before changing this.
      input.resume()
      closeRaw = () => {
        input.off('data', listener)
        input.setRawMode!(false)
        // Whatever the line editor buffered during the turn is stale: a
        // trailing esc that arrived in the SAME tty read as the enter
        // (readline consumes the whole chunk, so no listener swap can
        // intercept it), or type-ahead the fallback renderer has no
        // queue for. Left in place it reappears on the next prompt as
        // `❯ ^[…` and corrupts the next message (FINDINGS F6).
        rl.write(null, { ctrl: true, name: 'u' })
        rl.resume()
      }
    }
    holds++
    let released = false
    return () => {
      if (released) return
      released = true
      holds--
      if (holds === 0 && closeRaw !== null) {
        closeRaw()
        closeRaw = null
        buffered.length = 0
      }
    }
  }

  const keys: KeyChannel | null = rawCapable
    ? {
        capture: (handler) => {
          const release = acquireKeys()
          handlers.add(handler)
          // Anything pressed before this handler existed is delivered now.
          for (const key of buffered.splice(0)) handler(key)
          return () => {
            handlers.delete(handler)
            release()
          }
        },
      }
    : null

  const stream = (streamId: string, runId: string | null, threadId: string, since?: number) =>
    streamRun(
      { client: opts.client, renderer, style: s, out, keys, askLine: ask },
      { streamId, runId, threadId, ...(since !== undefined ? { since } : {}) },
    )

  // ── resume: replay history via /hydrate, live-tail if running ──────
  let threadId: string | null = null
  if (opts.resume) {
    const last = opts.sessionStore.lastThread(opts.cwd, opts.profileId)
    if (last === null) {
      out(s.dim('no previous session here — starting fresh\n'))
    } else {
      threadId = last
      const hydrated = await hydrateThread(opts.baseUrl, opts.token, last)
      if (hydrated === null) {
        out(s.dim(`could not load previous session ${last} — starting fresh\n`))
        threadId = null
      } else {
        out(s.dim(`↺ resumed ${last}\n`))
        printHistory(hydrated, out, s)
        if (hydrated.runningAgentId !== null) {
          out(s.dim('a run is still active — streaming…\n'))
          await stream(last, null, last, hydrated.lastClosedTurnEndSeq)
        }
      }
    }
  }

  // ── the loop ───────────────────────────────────────────────────────
  rl.on('SIGINT', () => {
    // Ctrl-C at the idle prompt: exit the CLI (mid-run Ctrl-C cancels
    // the run instead, via the raw-mode key channel).
    rl.close()
  })

  for (;;) {
    if (closed) break
    let prompt: string
    try {
      prompt = (await ask(s.cyan('❯ '))).trim()
    } catch {
      break
    }
    if (closed) break
    if (prompt === '') continue
    if (prompt === '/exit' || prompt === '/quit' || prompt === '/q') break

    // Hold the raw-key channel for the WHOLE turn, so an esc arriving
    // between submit and the first stream event is captured and replayed
    // into the run's handler rather than left to readline (FINDINGS F6).
    const releaseTurnKeys = acquireKeys()
    try {
      const started = await opts.client.run({
        profileId: opts.profileId,
        prompt,
        ...(threadId !== null ? { threadId } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
      })
      threadId = started.threadId
      const runId = started.runId ?? null
      opts.sessionStore.saveThread(opts.cwd, opts.profileId, started.threadId)
      await stream(runId ?? started.threadId, runId, started.threadId)
    } catch (err) {
      // The parked prompt is the contract: a failed run NEVER dead-ends
      // the CLI. Provider-not-configured errors already carry the
      // keyless (ollama) instructions in their message.
      renderer.flushLine()
      out(s.red(`✖ ${errorMessage(err)}\n`))
    } finally {
      releaseTurnKeys()
    }
  }

  rl.close()
}

// ── /hydrate (wire contract; not yet surfaced by @ownware/client) ────

interface HydratedThread {
  readonly messages: ReadonlyArray<Record<string, unknown>>
  readonly runningAgentId: string | null
  readonly lastClosedTurnEndSeq: number
}

async function hydrateThread(
  baseUrl: string,
  token: string | undefined,
  threadId: string,
): Promise<HydratedThread | null> {
  try {
    const headers: Record<string, string> = {}
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(
      `${baseUrl}/api/v1/threads/${encodeURIComponent(threadId)}/hydrate`,
      { headers },
    )
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown>
    const messages = Array.isArray(body['messages'])
      ? (body['messages'] as ReadonlyArray<Record<string, unknown>>)
      : []
    return {
      messages,
      runningAgentId:
        typeof body['runningAgentId'] === 'string' ? body['runningAgentId'] : null,
      lastClosedTurnEndSeq:
        typeof body['lastClosedTurnEndSeq'] === 'number' ? body['lastClosedTurnEndSeq'] : 0,
    }
  } catch {
    return null
  }
}

function printHistory(
  hydrated: HydratedThread,
  out: (chunk: string) => void,
  s: Style,
): void {
  for (const msg of hydrated.messages) {
    const role = typeof msg['role'] === 'string' ? msg['role'] : 'system'
    const text = typeof msg['content'] === 'string' ? msg['content'] : ''
    if (role === 'user') {
      out(s.cyan('❯ ') + text + '\n')
    } else if (role === 'assistant') {
      if (text !== '') out(text.endsWith('\n') ? text : text + '\n')
      const tools = Array.isArray(msg['tools']) ? msg['tools'].length : 0
      if (tools > 0) out(s.dim(`  · ${tools} tool call${tools === 1 ? '' : 's'}\n`))
    } else {
      const firstLine = text.split('\n', 1)[0] ?? ''
      if (firstLine !== '') out(s.dim(`· ${firstLine.slice(0, 100)}\n`))
    }
  }
}
