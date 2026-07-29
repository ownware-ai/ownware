/**
 * The collapse law: grouped tool rows are never
 * printed into the transcript. While a group runs, the composed bottom
 * shows a two-liner (header + current action); when it settles, exactly
 * ONE line lands in scrollback:
 *
 *   settled group   ✓ Worked through 12 steps · 26s
 *   lone tool       ● readFile · 843ms ✓        (the exception: a single
 *                                                tool call between agent
 *                                                sentences keeps its row)
 *   failed tool     ✗ shell_execute exit 1 …    (errors are load-bearing —
 *                                                they always print, never
 *                                                collapse)
 *
 * Thinking is always exactly one line: the block streams silently, and
 * on `thinking.complete` a `**Title**` parsed from the text becomes
 * `✱ Title` (falling back to `✱ Thinking…`). While streaming, the live
 * two-liner carries the thinking state instead — layout never shifts.
 *
 * Pure with respect to the terminal AND the clock (`now` injectable),
 * so the whole law is provable by folding recorded event streams.
 */

import { describeToolCall } from '@ownware/ui'
import { formatDuration, type RunRenderer } from '../render.js'
import { MarkdownStream } from '../markdown-ansi.js'
import type { Style } from '../style.js'

/** What the composed bottom shows for the running group. */
export interface LiveGroup {
  /** Tool calls started in this group so far. */
  readonly steps: number
  /** The current action line — running tool, or thinking. */
  readonly action: string
  /** Milliseconds since the group opened. */
  readonly elapsedMs: number
}

export interface CollapsingRendererOptions {
  readonly style: Style
  readonly out: (chunk: string) => void
  /** Live-group updates for the footer; null = group settled/none. */
  readonly onLive: (live: LiveGroup | null) => void
  readonly debugEvents?: boolean
  /** Clock, injectable for tests. */
  readonly now?: () => number
  /** Called with `usage.costUsd` from each turn.end — the status line's session cost. */
  readonly onCost?: (costUsd: number) => void
  /** Called with `context.pressure.level` (0–1) — the status-line meter. */
  readonly onPressure?: (level: number) => void
}

/** One dim system line per real event, 1:1 (mirrors TranscriptRenderer). */
const SYSTEM_LINE_TYPES: Record<string, string> = {
  'compaction.start': 'compacting context…',
  'compaction.complete': 'context compacted',
  'security.redact': 'a secret was redacted from a tool result',
  'tool_result.drop': 'an old tool result was dropped from context',
  'recovery.applied': 'recovered from a provider error',
}

export interface ToolFacts {
  readonly name: string
  /** The descriptor verb — `Read`, `Ran`, or the tool name fallback. */
  readonly verb: string
  /** The object of the verb — path, command, query. Empty when unknown. */
  readonly target: string
  /** `Verb target` — plain-text form for summaries. */
  readonly label: string
  readonly isShell: boolean
}

/**
 * Running rows use the gerund (render spec §1): descriptors carry past
 * tense only, so a small map covers the built-ins; unknown verbs run
 * with an ellipsis instead of a fake conjugation.
 */
const GERUNDS: Record<string, string> = {
  Read: 'Reading',
  Ran: 'Running',
  Wrote: 'Writing',
  Edited: 'Editing',
  Listed: 'Listing',
  Searched: 'Searching',
  'Searched web': 'Searching web',
  Matched: 'Matching',
  Fetched: 'Fetching',
  Clicked: 'Clicking',
  Remembered: 'Remembering',
  Delegated: 'Delegating',
}

export function gerund(verb: string): string {
  return GERUNDS[verb] ?? verb
}

/**
 * Describe a tool call through the shared seam: `describeToolCall()` from
 * `@ownware/ui` (the same headless brain the web widget uses; zero
 * per-tool CLI code). Known tools get their verb grammar (`Read path`,
 * `Ran $ command`); unknown tools fall back to generic signal keys and
 * finally to their bare name — the open world stays honest.
 */
export function describeTool(name: string, input: unknown): ToolFacts {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const render = describeToolCall({ id: '', name, input: record, status: 'running' })
  const command = typeof record['command'] === 'string' ? record['command'] : null
  const isShell = render.kind === 'shell' || command !== null

  const fallbackTarget =
    command ??
    (['path', 'file_path', 'filePath', 'pattern', 'url', 'query'] as const)
      .map((key) => (typeof record[key] === 'string' ? (record[key] as string) : null))
      .find((value) => value !== null) ??
    null
  const primary = render.primary ?? fallbackTarget
  const target =
    primary === null || primary === ''
      ? ''
      : `${isShell ? '$ ' : ''}${truncate(primary.split('\n')[0] ?? '', 60)}`
  return {
    name,
    verb: render.verb,
    target,
    label: target === '' ? render.verb : `${render.verb} ${target}`,
    isShell,
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/**
 * Pull a target out of PARTIAL argument JSON while it streams — the
 * first complete string value of a known signal key. Cheap and honest:
 * no match means "no target yet", never a guess.
 */
const PARTIAL_TARGET =
  /"(?:file_path|filePath|path|command|pattern|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)"/

/**
 * Fold ONE sub-agent's own event stream into a live action + step count
 * (render spec §5): the parent's ◇ line derives `◐ Reading path… ·
 * step 3` from the child's stream — no proxying, no extra protocol.
 */
export class SubagentActivity {
  private stepsCount = 0
  private current = ''
  private readonly open = new Map<string, ToolFacts>()
  private readonly args = new Map<string, string>()

  get steps(): number {
    return this.stepsCount
  }

  /** `◐ Reading path…` / `✳ Thinking…` / done form — '' before any work. */
  get action(): string {
    return this.current
  }

  handle(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case 'tool.call.start': {
        const name = typeof data['toolName'] === 'string' ? data['toolName'] : 'tool'
        const facts = describeTool(name, data['input'])
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        if (id !== '') this.open.set(id, facts)
        this.stepsCount += 1
        this.current = `◐ ${gerund(facts.verb)}${facts.target === '' ? '' : ` ${facts.target}`}…`
        return
      }
      case 'tool.call.args_delta': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const delta = typeof data['delta'] === 'string' ? data['delta'] : ''
        if (id === '' || delta === '') return
        const raw = (this.args.get(id) ?? '') + delta
        this.args.set(id, raw)
        const facts = this.open.get(id)
        if (facts === undefined || facts.target !== '') return
        const found = targetFromPartialArgs(raw)
        if (found === null || found === '') return
        const isShell = facts.isShell || raw.includes('"command"')
        const target = `${isShell ? '$ ' : ''}${truncate(found.split('\n')[0] ?? '', 50)}`
        this.open.set(id, { ...facts, target, label: `${facts.verb} ${target}`, isShell })
        this.current = `◐ ${gerund(facts.verb)} ${target}…`
        return
      }
      case 'tool.call.end': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const facts = this.open.get(id)
        this.open.delete(id)
        this.args.delete(id)
        if (facts !== undefined) this.current = `● ${facts.label}`
        return
      }
      case 'thinking.delta':
        if (!this.current.startsWith('✳')) this.current = '✳ Thinking…'
        return
      default:
        return
    }
  }
}

export function targetFromPartialArgs(raw: string): string | null {
  const match = PARTIAL_TARGET.exec(raw)
  if (match === null) return null
  try {
    return JSON.parse(`"${match[1]!}"`) as string
  } catch {
    return match[1]!
  }
}

interface SettledTool {
  readonly facts: ToolFacts
  readonly durationMs: number | null
  readonly result: string
}

interface StepRow {
  readonly label: string
  readonly durationMs: number | null
  readonly failed: boolean
}

interface OpenGroup {
  startedAt: number
  steps: number
  shellSteps: number
  lastTool: SettledTool | null
  action: string
  verbs: string[]
  rows: StepRow[]
  /** Total thinking time absorbed into this group. */
  thinkingMs: number
}

export class CollapsingRenderer implements RunRenderer {
  private readonly style: Style
  private readonly out: (chunk: string) => void
  private readonly onLive: (live: LiveGroup | null) => void
  private readonly debugEvents: boolean
  private readonly now: () => number
  private readonly onCost: ((costUsd: number) => void) | undefined
  private readonly onPressure: ((level: number) => void) | undefined

  private readonly markdown: MarkdownStream
  /** A structural line (settle/thought/row) just printed — the next
   *  prose gets one blank line first (vertical rhythm, owner feedback). */
  private gapBeforeText = false
  private group: OpenGroup | null = null
  private thinkingText = ''
  private thinkingOpen = false
  private thinkingStartedAt = 0
  private readonly openTools = new Map<string, ToolFacts>()
  /** Streamed argument JSON per toolCallId (Anthropic-style providers
   *  send `start` with an EMPTY input; the real path/command arrives as
   *  `args_delta` — render spec §1: the deltas fill the object slot). */
  private readonly toolArgs = new Map<string, string>()
  private readonly openPermissions = new Map<string, string>()

  constructor(opts: CollapsingRendererOptions) {
    this.style = opts.style
    this.out = opts.out
    this.onLive = opts.onLive
    this.debugEvents = opts.debugEvents === true
    this.now = opts.now ?? Date.now
    this.onCost = opts.onCost
    this.onPressure = opts.onPressure
    this.markdown = new MarkdownStream(opts.style, opts.out)
  }

  flushLine(): void {
    this.markdown.flush()
  }

  /** Settle the open group into its one scrollback line. */
  private settle(): void {
    const group = this.group
    if (group === null) return
    this.group = null
    this.onLive(null)
    const s = this.style
    const elapsed = formatDuration(this.now() - group.startedAt)
    if (group.steps === 1 && group.lastTool !== null) {
      // The lone-tool exception: the single row keeps its full story.
      // No green tick — success is silence (render spec §1).
      const { facts, durationMs, result } = group.lastTool
      const meta = durationMs === null ? '' : `${formatDuration(durationMs)} ›`
      this.line(this.toolRow(facts, meta))
      if (facts.isShell) this.printResultPreview(result)
      this.gapBeforeText = true
    } else if (group.steps > 0) {
      // Name the work: verbs with counts, so the summary answers "what
      // were the steps?" at a glance (owner feedback). `›` marks that
      // `/expand` can reprint the full rows.
      const counts = new Map<string, number>()
      for (const verb of group.verbs) counts.set(verb, (counts.get(verb) ?? 0) + 1)
      const named = [...counts.entries()]
        .map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb))
        .slice(0, 4)
        .join(', ')
      const overflow = counts.size > 4 ? ', …' : ''
      const thought =
        group.thinkingMs >= 1000 ? ` · thought ${formatDuration(group.thinkingMs)}` : ''
      this.line(
        s.green('✓') +
          ' Worked through ' +
          s.bold(`${group.steps} step${group.steps === 1 ? '' : 's'}`) +
          s.dim(`${named === '' ? '' : ` · ${named}${overflow}`}${thought} · ${elapsed}`) +
          ' ' +
          s.dim2('›'),
      )
      this.settledGroups.push(group.rows)
      this.expandCursor = 0
      if (this.settledGroups.length > 10) this.settledGroups.shift()
      this.gapBeforeText = true
    }
  }

  /** Settled groups' step rows, newest last — `/expand` reprints them. */
  private readonly settledGroups: StepRow[][] = []
  /** How many groups back the next expand reaches (ctrl+o walks). */
  private expandCursor = 0

  /**
   * Live update for a running sub-agent's ◇ line, derived by the shell
   * from the CHILD's own stream (`SubagentActivity`): the parent stream
   * deliberately carries only spawn/complete.
   */
  updateSubagentLive(agentId: string, childAction: string, childSteps: number): void {
    const group = this.group
    if (group === null) return
    const detail = childAction === '' ? 'working…' : childAction
    group.action = `◇ ${agentId} ${detail}${childSteps > 0 ? ` · step ${childSteps}` : ''}`
    this.publishLive()
  }

  /**
   * Reprint the last settled group's rows (append-only, render spec's
   * expand level 1). Returns false when there is nothing to expand.
   */
  expandLast(): boolean {
    const index = this.settledGroups.length - 1 - this.expandCursor
    const rows = this.settledGroups[index]
    if (rows === undefined || rows.length === 0) return false
    this.expandCursor += 1
    const s = this.style
    const back = this.expandCursor > 1 ? ` (${this.expandCursor - 1} earlier)` : ''
    this.line(s.dim2('⎿ ') + s.dim(`${rows.length} step${rows.length === 1 ? '' : 's'}${back}`))
    for (const row of rows) {
      const duration = row.durationMs === null ? '' : ` · ${formatDuration(row.durationMs)}`
      if (row.failed) {
        this.line(s.red(`   ✗ ${row.label}${duration}`))
      } else {
        this.line(`   ${s.dim('●')} ${s.dim(row.label)}${s.dim2(duration)}`)
      }
    }
    return true
  }

  /** First lines of a tool result, dim + indented, with the hidden count. */
  private printResultPreview(result: string, max = 4): void {
    const all = result.split('\n').filter((line) => line.trim() !== '')
    for (const line of all.slice(0, max)) {
      this.line(this.style.dim(`  ${truncate(line, 110)}`))
    }
    if (all.length > max) this.line(this.style.dim(`  … +${all.length - max} lines`))
  }

  /**
   * Close an open thinking block IN ORDER — before text or tools print.
   *
   * Thinking that happens INSIDE a working group is part of the group's
   * work (owner's collapse law): it is absorbed into the group's
   * `thinkingMs` and surfaces in the settle summary — never as stacked
   * `✳ Thought for 1.3s` lines. A line prints only for:
   *   - a TITLED thought (a real headline narrates the story), or
   *   - thinking with no tool work around it (a pure-thought reply).
   */
  private closeThinking(before: 'tool' | 'text' | 'end'): void {
    if (!this.thinkingOpen) return
    this.thinkingOpen = false
    const title = parseThinkingTitle(this.thinkingText)
    this.thinkingText = ''
    const tookMs = this.now() - this.thinkingStartedAt
    const group = this.group
    const inWork = before === 'tool' || (group !== null && group.steps > 0)
    if (group !== null) group.thinkingMs += tookMs
    const s = this.style
    if (title !== null) {
      this.line(s.dim(s.italic(`✳ Thought: ${title} · ${formatDuration(tookMs)}`)))
      this.gapBeforeText = true
    } else if (!inWork) {
      this.line(s.dim(s.italic(`✳ Thought for ${formatDuration(tookMs)}`)))
      this.gapBeforeText = true
    }
    if (group !== null && group.action.startsWith('✳')) {
      group.action = ''
      this.publishLive()
    }
  }

  private ensureGroup(): OpenGroup {
    if (this.group === null) {
      this.group = { startedAt: this.now(), steps: 0, shellSteps: 0, lastTool: null, action: '', verbs: [], rows: [], thinkingMs: 0 }
    }
    return this.group
  }

  private publishLive(): void {
    const group = this.group
    if (group === null) {
      this.onLive(null)
      return
    }
    this.onLive({
      steps: group.steps,
      action: group.action,
      elapsedMs: this.now() - group.startedAt,
    })
  }

  private line(text: string): void {
    this.flushLine()
    this.out(text + '\n')
  }

  /** Tool row: `● Verb object  meta ›` — state dot dim, verb bold,
   *  object accent, meta in the quieter structure dim. */
  private toolRow(facts: ToolFacts, meta: string, indent = ''): string {
    const s = this.style
    return (
      indent +
      s.dim('●') +
      ' ' +
      s.bold(facts.verb) +
      (facts.target === '' ? '' : ' ' + s.cyan(facts.target)) +
      (meta === '' ? '' : '  ' + s.dim2(meta))
    )
  }

  handle(type: string, data: Record<string, unknown>): void {
    const s = this.style
    switch (type) {
      case 'text.delta': {
        const text = typeof data['text'] === 'string' ? data['text'] : ''
        if (text.length === 0) return
        // Whitespace between tool batches must not split the group —
        // swallow it while a group is live (double-settle glitch).
        if (text.trim() === '' && (this.group !== null || this.thinkingOpen)) return
        // Thinking closes first (its one line must precede the prose —
        // the owner's screenshot showed it landing after), then the
        // group settles, then the story resumes.
        this.closeThinking('text')
        this.settle()
        if (this.gapBeforeText) {
          this.gapBeforeText = false
          this.out('\n')
        }
        this.markdown.feed(text)
        return
      }

      case 'thinking.delta': {
        const text = typeof data['text'] === 'string' ? data['text'] : ''
        this.thinkingText += text
        if (!this.thinkingOpen) {
          this.thinkingOpen = true
          this.thinkingStartedAt = this.now()
          const group = this.ensureGroup()
          group.action = '✳ Thinking…'
          this.publishLive()
        }
        return
      }
      case 'thinking.complete': {
        this.closeThinking('end')
        return
      }

      case 'tool.call.start': {
        this.closeThinking('tool')
        const name = typeof data['toolName'] === 'string' ? data['toolName'] : 'tool'
        const facts = describeTool(name, data['input'])
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        if (id !== '') this.openTools.set(id, facts)
        const group = this.ensureGroup()
        group.steps += 1
        if (facts.isShell) group.shellSteps += 1
        group.verbs.push(facts.verb)
        group.action = `◐ ${gerund(facts.verb)}${facts.target === '' ? '' : ` ${facts.target}`}…`
        this.publishLive()
        return
      }
      case 'tool.call.args_delta': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        const delta = typeof data['delta'] === 'string' ? data['delta'] : ''
        if (id === '' || delta === '') return
        const raw = (this.toolArgs.get(id) ?? '') + delta
        this.toolArgs.set(id, raw)
        const facts = this.openTools.get(id)
        if (facts === undefined || facts.target !== '') return
        const found = targetFromPartialArgs(raw)
        if (found === null || found === '') return
        const isShell = facts.isShell || raw.includes('"command"')
        const target = `${isShell ? '$ ' : ''}${truncate(found.split('\n')[0] ?? '', 60)}`
        const updated: ToolFacts = {
          name: facts.name,
          verb: facts.verb,
          target,
          label: `${facts.verb} ${target}`,
          isShell,
        }
        this.openTools.set(id, updated)
        const group = this.group
        if (group !== null) {
          group.action = `◐ ${gerund(updated.verb)} ${target}…`
          this.publishLive()
        }
        return
      }

      case 'tool.call.progress': {
        const message = typeof data['progress'] === 'string' ? data['progress'] : ''
        const group = this.group
        if (message !== '' && group !== null) {
          group.action = `· ${message}`
          this.publishLive()
        }
        return
      }
      case 'tool.call.end': {
        const id = typeof data['toolCallId'] === 'string' ? data['toolCallId'] : ''
        let facts = this.openTools.get(id)
          ?? describeTool(typeof data['toolName'] === 'string' ? data['toolName'] : 'tool', undefined)
        // Streaming providers deliver the real input via args_delta —
        // the reassembled JSON is the authoritative source for the row.
        const rawArgs = this.toolArgs.get(id)
        if (rawArgs !== undefined) {
          this.toolArgs.delete(id)
          try {
            const parsed: unknown = JSON.parse(rawArgs)
            if (parsed !== null && typeof parsed === 'object') {
              facts = describeTool(facts.name, parsed)
            }
          } catch {
            // Partial/malformed args — keep whatever the deltas gave us.
          }
        }
        this.openTools.delete(id)
        const durationMs = typeof data['durationMs'] === 'number' ? data['durationMs'] : null
        const result = typeof data['result'] === 'string' ? data['result'] : ''
        if (data['isError'] === true) {
          // Errors never collapse — the row AND a result preview print.
          const duration = durationMs === null ? '' : ` · ${formatDuration(durationMs)}`
          this.line(s.red(`✗ ${facts.label}`.trimEnd() + duration))
          this.printResultPreview(result)
          this.group?.rows.push({ label: facts.label, durationMs, failed: true })
          this.publishLive()
          return
        }
        const group = this.group
        if (group !== null) {
          group.lastTool = { facts, durationMs, result }
          group.rows.push({ label: facts.label, durationMs, failed: false })
          // Keep the finished action visible (done form) until the next
          // step replaces it — a blank pulse line reads as "stuck".
          group.action = `● ${facts.label}`
          this.publishLive()
        }
        return
      }

      case 'agent.spawn': {
        const id = typeof data['agentId'] === 'string' ? data['agentId'] : 'agent'
        const group = this.ensureGroup()
        group.steps += 1
        group.verbs.push('Delegated')
        group.rows.push({ label: `◇ ${id}`, durationMs: null, failed: false })
        group.action = `◇ ${id} starting…`
        this.publishLive()
        return
      }
      case 'agent.complete': {
        const group = this.group
        if (group !== null) {
          group.action = ''
          this.publishLive()
        }
        return
      }

      case 'permission.request': {
        const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : ''
        const toolName = typeof data['toolName'] === 'string' ? data['toolName'] : 'tool'
        if (requestId !== '') this.openPermissions.set(requestId, toolName)
        return
      }
      case 'permission.response': {
        const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : ''
        const toolName = this.openPermissions.get(requestId) ?? 'tool'
        this.openPermissions.delete(requestId)
        // Decisions are records — they always print, even mid-group.
        if (data['granted'] === true) {
          this.line(s.green('✓') + ` allowed ${s.bold(toolName)}`)
        } else {
          this.line(s.dim(s.strike(`● ${toolName}`) + ' denied'))
        }
        return
      }

      case 'security.block': {
        const command = typeof data['command'] === 'string' ? data['command'] : ''
        const reason = typeof data['reason'] === 'string' ? data['reason'] : 'blocked by security policy'
        const detail = command === '' ? reason : `${reason} — ${command.slice(0, 80)}`
        this.line(s.red(`⛔ ${detail}`))
        return
      }

      case 'error': {
        this.closeThinking('end')
        this.settle()
        const message = typeof data['message'] === 'string' ? data['message'] : 'agent error'
        this.line(s.red(`✖ ${message}`))
        return
      }
      case 'turn.interrupted': {
        this.closeThinking('end')
        this.settle()
        const reason = typeof data['reason'] === 'string' ? data['reason'] : 'interrupted'
        this.line(s.dim(`⎋ run ${reason}`))
        return
      }
      case 'turn.end': {
        // The final settle — a run that ends in tools (stopReason
        // tool_use continues the loop; end_turn settles for real).
        const usage = data['usage']
        if (usage !== null && typeof usage === 'object') {
          const cost = (usage as Record<string, unknown>)['costUsd']
          if (typeof cost === 'number' && cost > 0) this.onCost?.(cost)
        }
        const stopReason = typeof data['stopReason'] === 'string' ? data['stopReason'] : 'end_turn'
        if (stopReason !== 'tool_use' && stopReason !== 'pause_turn') {
          this.closeThinking('end')
          this.settle()
        }
        return
      }

      case 'context.pressure': {
        // Feeds the status-line meter; the dim line itself is -v only
        // (render spec §8: pressure/cache appear at -v).
        const level = typeof data['level'] === 'number' ? data['level'] : null
        if (level !== null) this.onPressure?.(level)
        if (this.debugEvents) this.line(s.dim('· context pressure high'))
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

/** First `**Title**` in the thinking text, if any. */
export function parseThinkingTitle(text: string): string | null {
  const match = /\*\*(.+?)\*\*/.exec(text)
  const title = match?.[1]?.trim() ?? ''
  return title === '' ? null : title
}
