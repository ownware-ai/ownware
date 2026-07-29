/**
 * The fallback renderer — one gateway event in, zero or more terminal
 * writes out. Append-only: nothing above the cursor is ever repainted,
 * so native scrollback, copy, and search survive.
 *
 * Pure with respect to the terminal: all output goes through the injected
 * `out` sink, all color through the injected `Style`. Tests fold a
 * recorded event stream through a string sink and assert the transcript.
 *
 * Row grammar (S1 subset of the render spec):
 *   text.delta        → streamed verbatim
 *   thinking          → exactly one dim line per thinking block
 *   tool.call.start   → `● name …`
 *   tool.call.progress→ `  · message`
 *   tool.call.end     → `  ✓ 843ms` / `  ✗ first-line-of-error · 843ms`
 *   agent.spawn/done  → `◇ agent started` / `◇ agent done`
 *   security.block    → red `⛔ blocked …`
 *   system lines      → one dim line each (compaction, pressure, redact…)
 *   permission.response → `✓ approved name` / dim strikethrough denied row
 *
 * Unknown event types render NOTHING by default (the wire adds types
 * additively; a chat transcript must not fill with noise), but
 * `debugEvents` surfaces them one dim line each so nothing is silently
 * invisible while developing.
 */

import { MarkdownStream } from './markdown-ansi.js'
import type { Style } from './style.js'
// Shared descriptor seam with the TUI renderer: one
// generic brain (`describeToolCall()` from @ownware/ui) rather than a
// per-tool catalogue in each renderer.
import {
  describeTool,
  gerund,
  targetFromPartialArgs,
  truncate,
  type ToolFacts,
} from './tui/collapse.js'

/** One dim system line per real event, 1:1 (render spec §11). */
const SYSTEM_LINE_TYPES: Record<string, string> = {
  'compaction.start': 'compacting context…',
  'compaction.complete': 'context compacted',
  'context.pressure': 'context pressure high',
  'security.redact': 'a secret was redacted from a tool result',
  'tool_result.drop': 'an old tool result was dropped from context',
  'recovery.applied': 'recovered from a provider error',
}

/**
 * What the run-stream machinery needs from a renderer — implemented by
 * `TranscriptRenderer` (S1 fallback: every row printed) and the TUI's
 * `CollapsingRenderer` (S2: grouped rows suppressed, settle lines only).
 */
export interface RunRenderer {
  handle(type: string, data: Record<string, unknown>): void
  flushLine(): void
}

export interface RendererOptions {
  readonly style: Style
  readonly out: (chunk: string) => void
  /** Print unknown/unrendered event types as dim lines. */
  readonly debugEvents?: boolean
}

export class TranscriptRenderer implements RunRenderer {
  private readonly style: Style
  private readonly out: (chunk: string) => void
  private readonly debugEvents: boolean

  /** Streams model text as rendered markdown, line-buffered. */
  private readonly markdown: MarkdownStream
  /** True once this thinking block has printed its one line. */
  private thinkingAnnounced = false
  /** toolCallId → what the row is doing, so the settle line can name it. */
  private readonly openTools = new Map<string, ToolFacts>()
  /** toolCallId → reassembled streamed arguments (`tool.call.args_delta`). */
  private readonly toolArgs = new Map<string, string>()
  /** requestId → toolName, so permission.response can label its row. */
  private readonly openPermissions = new Map<string, string>()

  /**
   * The tool's facts once the call has ended — the first moment the
   * arguments are certainly complete. Prefers the reassembled streamed
   * JSON, falls back to whatever `start` carried, and finally to a
   * partial-arguments scan so a truncated stream still names something.
   */
  private factsAtEnd(id: string, name: string, started: ToolFacts | undefined): ToolFacts {
    const raw = this.toolArgs.get(id)
    if (raw !== undefined && raw !== '') {
      try {
        return describeTool(name, JSON.parse(raw))
      } catch {
        const found = targetFromPartialArgs(raw)
        if (found !== null && found !== '') {
          const isShell = (started?.isShell ?? false) || raw.includes('"command"')
          const verb = started?.verb ?? name
          const target = `${isShell ? '$ ' : ''}${truncate(found.split('\n')[0] ?? '', 60)}`
          return { name, verb, target, label: `${verb} ${target}`, isShell }
        }
      }
    }
    return started ?? describeTool(name, undefined)
  }

  constructor(opts: RendererOptions) {
    this.style = opts.style
    this.out = opts.out
    this.debugEvents = opts.debugEvents === true
    this.markdown = new MarkdownStream(opts.style, opts.out)
  }

  /**
   * Close an open streamed-text run so the next output starts at column 0.
   * Public: the REPL calls it before printing its own cards and prompts.
   */
  flushLine(): void {
    this.markdown.flush()
  }

  private line(text: string): void {
    this.flushLine()
    this.out(text + '\n')
  }

  handle(type: string, data: Record<string, unknown>): void {
    const s = this.style
    switch (type) {
      case 'text.delta': {
        const text = typeof data['text'] === 'string' ? data['text'] : ''
        if (text.length === 0) return
        this.markdown.feed(text)
        return
      }

      case 'thinking.delta': {
        if (!this.thinkingAnnounced) {
          this.thinkingAnnounced = true
          this.line(s.dim('✻ Thinking...'))
        }
        return
      }
      case 'thinking.complete': {
        this.thinkingAnnounced = false
        return
      }

      case 'tool.call.start': {
        const name = typeof data['toolName'] === 'string' ? data['toolName'] : 'tool'
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const facts = describeTool(name, data['input'])
        if (id !== '') this.openTools.set(id, facts)
        // Running rows take the gerund. The target may still be unknown
        // here — Anthropic-style providers send an EMPTY input at start
        // and stream the path through `args_delta` — so the settle line
        // below is what guarantees the file is named at least once.
        this.line(s.dim(`● ${gerund(facts.verb)}${facts.target === '' ? '' : ` ${facts.target}`}`))
        return
      }
      case 'tool.call.args_delta': {
        // Accumulate only. This renderer is append-only: the row above
        // is already committed to scrollback and must never be rewritten.
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const delta = typeof data['delta'] === 'string' ? data['delta'] : ''
        if (id === '' || delta === '') return
        this.toolArgs.set(id, (this.toolArgs.get(id) ?? '') + delta)
        return
      }
      case 'tool.call.progress': {
        const message = typeof data['progress'] === 'string' ? data['progress'] : ''
        if (message !== '') this.line(s.dim(`  · ${message}`))
        return
      }
      case 'tool.call.end': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const started = this.openTools.get(id)
        const name =
          started?.name ?? (typeof data['toolName'] === 'string' ? data['toolName'] : 'tool')
        // Recompute from the reassembled arguments: with a streaming
        // provider this is the first point the real target is known.
        const facts = this.factsAtEnd(id, name, started)
        this.openTools.delete(id)
        this.toolArgs.delete(id)
        const durationMs = typeof data['durationMs'] === 'number' ? data['durationMs'] : null
        const duration = durationMs === null ? '' : ` · ${formatDuration(durationMs)}`
        if (data['isError'] === true) {
          const result = typeof data['result'] === 'string' ? data['result'] : ''
          const firstLine = result.split('\n', 1)[0]?.slice(0, 120) ?? ''
          this.line(s.red(`  ✗ ${facts.label} ${firstLine}`.trimEnd() + duration))
        } else {
          // The label always rides the settle line. Dropping it whenever
          // a duration was present is how `● readFile` / `✓ · 2ms` left
          // the customer unable to see WHICH file was read (FINDINGS F10).
          this.line(s.dim(`  ✓ ${facts.label}${duration}`))
        }
        return
      }

      case 'agent.spawn': {
        const id = typeof data['agentId'] === 'string' ? data['agentId'] : 'agent'
        this.line(s.dim(`◇ ${id} started`))
        return
      }
      case 'agent.complete': {
        const id = typeof data['agentId'] === 'string' ? data['agentId'] : 'agent'
        this.line(s.dim(`◇ ${id} done`))
        return
      }

      case 'permission.request': {
        // The card itself is the REPL's job (it must block on a key).
        // Remember the tool name so the response row can be labeled.
        const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : ''
        const toolName = typeof data['toolName'] === 'string' ? data['toolName'] : 'tool'
        if (requestId !== '') this.openPermissions.set(requestId, toolName)
        return
      }
      case 'permission.response': {
        const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : ''
        const toolName = this.openPermissions.get(requestId) ?? 'tool'
        this.openPermissions.delete(requestId)
        if (data['granted'] === true) {
          this.line(s.dim(`✓ approved ${toolName}`))
        } else {
          // Denied is a decision, not an error (render spec): strikethrough, not red.
          this.line(s.dim(s.strike(`● ${toolName}`) + ' denied'))
        }
        return
      }

      case 'security.block': {
        const command = typeof data['command'] === 'string' ? data['command'] : ''
        const reason = typeof data['reason'] === 'string' ? data['reason'] : 'blocked by security policy'
        const detail = command === '' ? reason : `${reason} — ${command.slice(0, 80)}`
        this.line(this.style.red(`⛔ ${detail}`))
        return
      }

      case 'error': {
        const message = typeof data['message'] === 'string' ? data['message'] : 'agent error'
        this.line(s.red(`✖ ${message}`))
        return
      }
      case 'turn.interrupted': {
        const reason = typeof data['reason'] === 'string' ? data['reason'] : 'interrupted'
        this.line(s.dim(`⎋ run ${reason}`))
        return
      }

      default: {
        const systemLine = SYSTEM_LINE_TYPES[type]
        if (systemLine !== undefined) {
          this.line(s.dim(`· ${systemLine}`))
          return
        }
        if (this.debugEvents) this.line(s.dim(`[event] ${type}`))
      }
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${m}m ${sec}s`
}
