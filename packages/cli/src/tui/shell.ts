/**
 * S2 — the OpenTUI split-footer shell.
 *
 * The inline law is structural, not stylistic: the renderer runs in
 * `split-footer` mode with `capture-stdout`, so the transcript is ordinary
 * stdout rasterized into real terminal scrollback by OpenTUI, while only
 * the composed bottom repaints.
 *
 * The composed bottom, top to bottom (each block collapses when idle):
 *
 *   live group      ◐ Working… · 3 steps · 12s       (collapse law: the
 *                   ● readFile                        transcript gets ONE
 *                                                     settle line instead)
 *   approval card   Approval needed                  (pinned — can never
 *                     shell_execute — needs approval  scroll away; y/n)
 *   prompt          ❯ …
 *   status          profile · state · hint
 *
 * Transcript rendering is `CollapsingRenderer` (collapse law, provable
 * in unit tests); run mechanics are S1's `streamRun` unchanged — the
 * shell provides `presentApproval` (the pinned card) and a `KeyChannel`
 * bridged from OpenTUI key events.
 *
 * Bun-only (OpenTUI is a Zig core over Bun FFI). `index.ts` gates entry
 * and falls back to the plain REPL under Node, `--simple`, or no TTY.
 * The gateway runs as a node child process (see `gateway-child.ts`).
 */

import {
  BoxRenderable,
  InputRenderable,
  StyledText,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  t,
  type KeyEvent,
} from '@opentui/core'
import { TOKENS } from '../theme.js'
import {
  streamRun,
  KEY_ESC,
  KEY_CTRL_C,
  type ApprovalDecision,
  type ApprovalInfo,
  type KeyChannel,
} from '../stream-run.js'
import { formatDuration } from '../render.js'
import { ansiLineToStyledText } from './ansi-styled.js'
import { buildWordmarkSplash } from './wordmark.js'
import { Picker, type PickerItem } from './picker.js'
import { CollapsingRenderer, SubagentActivity, type LiveGroup } from './collapse.js'
import type { ReplOptions } from '../repl.js'

const BASE_HEIGHT = 4 // bordered prompt box (3) + status (1)
const LIVE_HEIGHT = 2
const CARD_HEIGHT = 4 // bordered approval card: 2 content lines

type ShellState = 'idle' | 'running' | 'approval'

export async function runTuiShell(opts: ReplOptions): Promise<void> {
  const renderer = await createCliRenderer({
    screenMode: 'split-footer',
    footerHeight: BASE_HEIGHT,
    externalOutputMode: 'capture-stdout',
    exitOnCtrlC: false,
    clearOnShutdown: false,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    targetFps: 30,
  })
  const s = opts.style
  const dimT = fg(TOKENS.carbonDim)
  const accentT = fg(TOKENS.cobalt)
  const dangerT = fg(TOKENS.danger)
  const warnT = fg(TOKENS.warning)
  const okT = fg(TOKENS.success)

  // Transcript sink: every completed line becomes a StyledText committed
  // through `writeToScrollback` — the SAME engine that paints the footer.
  // (The captured-stdout ANSI parser ate leading bytes of styled lines on
  // real terminals and cut into multi-byte glyphs; see ansi-styled.ts.)
  let pendingLine = ''
  const commitLine = (line: string) => {
    const styled = ansiLineToStyledText(line)
    renderer.writeToScrollback((ctx) => {
      const width = Math.max(1, Math.trunc(ctx.width))
      const root = new TextRenderable(ctx.renderContext, {
        width,
        content: styled,
        wrapMode: 'word',
      })
      return { root, width, startOnNewLine: true, trailingNewline: true }
    })
    renderer.requestRender()
  }
  const out = (chunk: string) => {
    pendingLine += chunk
    for (;;) {
      const newline = pendingLine.indexOf('\n')
      if (newline === -1) break
      commitLine(pendingLine.slice(0, newline))
      pendingLine = pendingLine.slice(newline + 1)
    }
  }
  const flushPending = () => {
    if (pendingLine !== '') {
      commitLine(pendingLine)
      pendingLine = ''
    }
  }

  // ── the composed bottom ────────────────────────────────────────────
  const footer = new BoxRenderable(renderer, {
    width: '100%',
    height: BASE_HEIGHT,
    flexDirection: 'column',
  })

  const liveBox = new BoxRenderable(renderer, {
    width: '100%',
    height: LIVE_HEIGHT,
    flexDirection: 'column',
    visible: false,
  })
  const liveHeader = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
  const liveAction = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
  liveBox.add(liveHeader)
  liveBox.add(liveAction)

  const cardBox = new BoxRenderable(renderer, {
    width: '100%',
    height: CARD_HEIGHT,
    flexDirection: 'column',
    visible: false,
    border: true,
    borderStyle: 'rounded',
    borderColor: '#383836',
    title: ' approval ',
    titleColor: TOKENS.carbonDim,
  })
  const cardLines = Array.from({ length: 2 }, () => {
    const line = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
    cardBox.add(line)
    return line
  })

  const promptBox = new BoxRenderable(renderer, {
    width: '100%',
    height: 3,
    border: true,
    borderStyle: 'rounded',
    borderColor: '#383836',
    focusedBorderColor: TOKENS.cobalt,
  })
  const inputRow = new BoxRenderable(renderer, {
    width: '100%',
    height: 1,
    flexDirection: 'row',
  })
  const promptMark = new TextRenderable(renderer, {
    content: t`${accentT('❯')} `,
    width: 2,
    height: 1,
  })
  // The Input's own enter→submit action does not fire in OpenTUI 0.4.5
  // (its single-line newline suppression swallows `return` before action
  // routing — proven by spike); submit is driven from the global
  // keypress listener below instead.
  const input = new InputRenderable(renderer, {
    width: '100%',
    placeholder: `Ask ${opts.profileId}…`,
  })
  inputRow.add(promptMark)
  inputRow.add(input)
  promptBox.add(inputRow)

  const statusLine = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })

  const paletteBox = new BoxRenderable(renderer, {
    width: '100%',
    height: 0,
    flexDirection: 'column',
    visible: false,
  })
  const paletteRows = Array.from({ length: 4 }, () => {
    const row = new TextRenderable(renderer, { content: '', width: '100%', height: 1 })
    paletteBox.add(row)
    return row
  })

  const picker = new Picker(renderer)

  footer.add(liveBox)
  footer.add(cardBox)
  footer.add(picker.box)
  footer.add(paletteBox)
  footer.add(promptBox)
  footer.add(statusLine)
  renderer.root.add(footer)

  // ── footer state ───────────────────────────────────────────────────
  let state: ShellState = 'idle'
  let threadId: string | null = null
  let currentProfile = opts.profileId
  let currentModel: string | undefined = opts.model
  let sessionCostUsd = 0
  let ctxLevel: number | null = null
  let retryAttempt = 0
  const queue: string[] = []
  /** Sub-agents seen this session (newest last) with their thread. */
  const subagentsSeen: Array<{ agentId: string; threadId: string }> = []
  const childWatchers = new Map<string, AbortController>()

  const startChildWatch = (agentId: string, forThread: string) => {
    if (childWatchers.has(agentId)) return
    const abort = new AbortController()
    childWatchers.set(agentId, abort)
    void (async () => {
      const tracker = new SubagentActivity()
      try {
        for await (const ev of opts.client.agentEvents(forThread, agentId, {
          signal: abort.signal,
        })) {
          tracker.handle(ev.type, ev.data)
          transcript.updateSubagentLive(agentId, tracker.action, tracker.steps)
        }
      } catch {
        // Aborted or dropped — the parent's agent.complete is the truth.
      }
    })()
  }
  const stopChildWatch = (agentId: string) => {
    childWatchers.get(agentId)?.abort()
    childWatchers.delete(agentId)
  }
  const stopAllChildWatches = () => {
    for (const [, abort] of childWatchers) abort.abort()
    childWatchers.clear()
  }
  let liveSnapshot: { group: LiveGroup; at: number } | null = null

  const relayout = () => {
    const height =
      BASE_HEIGHT +
      (liveBox.visible ? LIVE_HEIGHT : 0) +
      (cardBox.visible ? CARD_HEIGHT : 0) +
      picker.height +
      (paletteBox.visible ? paletteBox.height : 0)
    footer.height = height
    renderer.footerHeight = height
    renderer.requestRender()
  }

  // The as-you-type command palette (render spec §9) — INTERACTIVE:
  // type `/` and the list pops; ↑↓ selects, enter runs the selection
  // (with any typed args), tab completes, esc dismisses.
  let lastPaletteKey = ''
  let paletteMatches: PickerItem[] = []
  let paletteCursor = 0
  let paletteDismissedFor = ''
  const paintPalette = (force = false) => {
    const value = state === 'idle' && !picker.visible ? input.value : ''
    const active = value.startsWith('/') && value !== paletteDismissedFor
    const cacheKey = active ? `${value}#${paletteCursor}` : ''
    if (!force && cacheKey === lastPaletteKey) return
    lastPaletteKey = cacheKey
    if (!active) {
      paletteMatches = []
      if (paletteBox.visible) {
        paletteBox.visible = false
        relayout()
      }
      return
    }
    const query = value.slice(1).split(/\s+/)[0] ?? ''
    const fresh = COMMANDS.filter((c) => c.label.slice(1).startsWith(query)).slice(0, 4)
    if (fresh.map((m) => m.id).join(',') !== paletteMatches.map((m) => m.id).join(',')) {
      paletteCursor = 0
    }
    paletteMatches = fresh
    if (paletteCursor >= paletteMatches.length) paletteCursor = Math.max(0, paletteMatches.length - 1)
    for (let i = 0; i < paletteRows.length; i++) {
      const row = paletteRows[i]!
      const item = paletteMatches[i]
      row.visible = i < paletteMatches.length
      row.content =
        item === undefined
          ? ''
          : new StyledText([
              i === paletteCursor ? accentT('❯ ') : dimT('  '),
              i === paletteCursor ? bold(item.label) : accentT(item.label),
              dimT(`  ${item.hint ?? ''}`),
            ])
    }
    paletteBox.height = paletteMatches.length
    paletteBox.visible = paletteMatches.length > 0
    relayout()
  }

  const setState = (next: ShellState) => {
    state = next
    const model = currentModel !== undefined ? ` · ${currentModel}` : ''
    const label =
      next === 'idle'
        ? dimT('idle')
        : next === 'running'
          ? retryAttempt > 0
            ? warnT(`⟳ retry ${retryAttempt}`)
            : accentT('busy')
          : warnT('⏸ waiting on you')
    const cost = sessionCostUsd > 0 ? ` · $${sessionCostUsd.toFixed(2)}` : ''
    const meter =
      ctxLevel === null
        ? ''
        : ` · ${'▮'.repeat(Math.min(4, Math.round(ctxLevel * 4)))}${'▯'.repeat(Math.max(0, 4 - Math.round(ctxLevel * 4)))} ${Math.round(ctxLevel * 100)}% ctx`
    const queued = queue.length > 0 ? ` · ${queue.length} queued` : ''
    const hint =
      next === 'idle' ? '/ commands · ctrl+o expand' : next === 'running' ? 'esc cancel' : 'y allow · a always · n deny'
    statusLine.content = new StyledText([
      dimT('  '),
      dimT(`${currentProfile}${model} · `),
      okT('loom ✓'),
      dimT(' · '),
      ...(typeof label === 'string' ? [dimT(label)] : [label]),
      dimT(`${meter}${cost}${queued} · ${hint}`),
    ])
    renderer.requestRender()
  }
  setState('idle')
  input.focus()

  // The launch splash — pixel wordmark + run context, committed into
  // scrollback so it scrolls up as the conversation takes over. Wait for
  // the renderer's first frame first: commits queued before it are
  // dropped, so wait for the renderer to become idle first.
  if (opts.banner !== undefined) {
    await renderer.idle().catch(() => {})
    const columns = renderer.width > 0 ? renderer.width : (process.stdout.columns ?? 80)
    for (const line of buildWordmarkSplash(opts.banner, s, columns)) out(line + '\n')
  }

  // The shimmer: a bright window sweeping left→right across the live
  // verb while the agent works (the effect the owner asked for). Chunked
  // per character — the lines are short, 10fps is nothing.
  let shimmerPhase = 0
  const shimmer = (text: string) => {
    const window = 4
    const span = text.length + window * 2
    const pos = (shimmerPhase % span) - window
    const chunks = []
    for (let i = 0; i < text.length; i++) {
      const lit = i >= pos - window && i <= pos + window
      chunks.push((lit ? fg(TOKENS.bone) : dimT)(text[i]!))
    }
    return chunks
  }

  const paintLive = () => {
    if (liveSnapshot === null) {
      if (liveBox.visible) {
        liveBox.visible = false
        relayout()
      }
      return
    }
    const { group, at } = liveSnapshot
    const elapsed = formatDuration(group.elapsedMs + (Date.now() - at))
    const thinking = group.action.startsWith('✻')
    const verb = thinking ? 'Thinking...' : 'Working...'
    const detail =
      group.steps > 0 ? ` · ${group.steps} step${group.steps === 1 ? '' : 's'} · ${elapsed}` : ` · ${elapsed}`
    liveHeader.content = new StyledText([
      accentT('◐ '),
      ...shimmer(verb),
      dimT(detail),
    ])
    liveAction.content =
      group.action === '' || thinking ? '' : t`  ${dimT(group.action)}`
    if (!liveBox.visible) {
      liveBox.visible = true
      relayout()
    } else {
      renderer.requestRender()
    }
  }

  const liveTicker = setInterval(() => {
    if (liveSnapshot !== null) {
      shimmerPhase++
      paintLive()
    }
    paintPalette()
  }, 100)

  const transcript = new CollapsingRenderer({
    style: s,
    out,
    debugEvents: opts.debugEvents === true,
    onLive: (live) => {
      liveSnapshot = live === null ? null : { group: live, at: Date.now() }
      paintLive()
    },
    onCost: (costUsd) => {
      sessionCostUsd += costUsd
      setState(state)
    },
    onPressure: (level) => {
      ctxLevel = level
      setState(state)
    },
  })

  // ── keys ───────────────────────────────────────────────────────────
  // Priority: pinned approval card → run channel (streamRun's esc) →
  // idle handling (enter submits, ctrl-c exits).
  let approvalKeys: ((key: string) => void) | null = null

  const toKeyString = (ev: KeyEvent): string => {
    if (ev.name === 'escape') return KEY_ESC
    if (ev.ctrl === true && ev.name === 'c') return KEY_CTRL_C
    return typeof ev.name === 'string' && ev.name.length === 1 ? ev.name : ''
  }
  const keys: KeyChannel = {
    capture: (handler) => {
      const listener = (ev: KeyEvent) => {
        const key = toKeyString(ev)
        if (key === '') return
        if (approvalKeys !== null) {
          approvalKeys(key)
          return
        }
        handler(key)
      }
      renderer.keyInput.on('keypress', listener)
      return () => {
        renderer.keyInput.off('keypress', listener)
      }
    },
  }

  const idleKeys = (ev: KeyEvent) => {
    if (picker.visible) {
      picker.handleKey(typeof ev.name === 'string' ? ev.name : '', ev.ctrl === true)
      relayout()
      return
    }
    // ctrl+o expands the last settled group (render spec §10).
    if (ev.ctrl === true && ev.name === 'o') {
      if (!transcript.expandLast()) confirm('nothing to expand yet')
      return
    }
    if (state === 'running') {
      // Typing while the agent works queues the message — and the queue
      // IS the transcript (render spec §9): the ❯ line prints now with a
      // queued chip; the chipless echo happens when the run picks it up.
      if (ev.name === 'return' || ev.name === 'kpenter' || ev.name === 'linefeed') {
        const draft = input.value.trim()
        if (draft === '' || draft.startsWith('/')) return
        input.value = ''
        queue.push(draft)
        out('\n' + s.cyan('❯ ') + draft + '  ' + s.dim2('· queued') + '\n')
        setState(state)
      }
      return
    }
    if (state !== 'idle') return
    if (paletteBox.visible && paletteMatches.length > 0) {
      const selected = paletteMatches[paletteCursor]
      if (ev.name === 'up') {
        paletteCursor = Math.max(0, paletteCursor - 1)
        paintPalette(true)
        return
      }
      if (ev.name === 'down') {
        paletteCursor = Math.min(paletteMatches.length - 1, paletteCursor + 1)
        paintPalette(true)
        return
      }
      if (ev.name === 'tab' && selected !== undefined) {
        input.value = `/${selected.id} `
        paintPalette(true)
        return
      }
      if (ev.name === 'escape') {
        paletteDismissedFor = input.value
        paintPalette(true)
        return
      }
      if ((ev.name === 'return' || ev.name === 'kpenter' || ev.name === 'linefeed') && selected !== undefined) {
        const rest = input.value.slice(1).split(/\s+/).slice(1).join(' ')
        input.value = ''
        paintPalette(true)
        runCommand(selected.id, rest)
        return
      }
    }
    if (ev.name === 'return' || ev.name === 'kpenter' || ev.name === 'linefeed') {
      submit()
      return
    }
    if (ev.ctrl === true && ev.name === 'c') {
      void shutdown()
    }
  }
  renderer.keyInput.on('keypress', idleKeys)

  // ── slash commands + the one picker ────────────────────────────────
  const openPicker = (
    title: string,
    items: readonly PickerItem[],
    initialQuery: string,
    apply: (id: string) => void,
  ) => {
    input.blur()
    picker.open(
      title,
      items,
      (id) => {
        relayout()
        input.focus()
        renderer.requestRender()
        if (id !== null) apply(id)
      },
      initialQuery,
    )
    relayout()
  }

  const confirm = (text: string) => {
    out(s.dim(`· ${text}`) + '\n')
  }

  const pickModel = async (query: string) => {
    let models
    try {
      models = await opts.client.models()
    } catch (err) {
      out(s.red(`✖ could not list models: ${err instanceof Error ? err.message : String(err)}\n`))
      return
    }
    const items: PickerItem[] = models.map((m) => ({
      id: m.id,
      label: m.id,
      hint: m.hasCredentials === true ? (m.default === true ? 'ready · default' : 'ready') : 'no key',
      muted: m.hasCredentials !== true,
    }))
    openPicker('/model', items, query, (id) => {
      currentModel = id
      setState('idle')
      confirm(`model → ${id}`)
    })
  }

  const pickProfile = async (query: string) => {
    let profiles
    try {
      profiles = await opts.client.profiles()
    } catch (err) {
      out(s.red(`✖ could not list profiles: ${err instanceof Error ? err.message : String(err)}\n`))
      return
    }
    const items: PickerItem[] = profiles.map((p) => ({
      id: p.id ?? p.name ?? '',
      label: p.id ?? p.name ?? '',
      ...(typeof p.description === 'string' ? { hint: p.description.slice(0, 60) } : {}),
    }))
    openPicker('/profile', items, query, (id) => {
      if (id === currentProfile) return
      currentProfile = id
      // A profile change starts a new thread so execution context cannot
      // cross profile boundaries.
      threadId = null
      input.placeholder = `Ask ${id}…`
      setState('idle')
      confirm(`profile → ${id} (new thread)`)
    })
  }

  const replayAgentTranscript = async (agentId: string, forThread: string) => {
    let history
    try {
      history = await opts.client.agentEventHistory(forThread, agentId)
    } catch (err) {
      out(s.red(`✖ could not load ${agentId}: ${err instanceof Error ? err.message : String(err)}\n`))
      return
    }
    if (history.length === 0) {
      confirm(`${agentId}: no recorded events`)
      return
    }
    // Same grammar, replayed append-only (render spec §5) — a fresh
    // renderer folds the child's history; no live region involved.
    out('\n' + s.dim2('⎿ ') + s.bold(agentId) + s.dim(' — transcript') + '\n')
    const replay = new CollapsingRenderer({
      style: s,
      out,
      onLive: () => {},
    })
    for (const entry of history) {
      replay.handle(entry.type, entry.payload)
    }
    replay.flushLine()
    out(s.dim2(`⎿ end of ${agentId}`) + '\n\n')
  }

  const HELP_LINES = [
    '/model [query]     switch model (fuzzy picker)',
    '/profile [query]   switch profile — starts a new thread',
    '/expand            show the steps behind the last ✓ summary',
    '/agents            replay a sub-agent transcript',
    '/help              this help',
    '/exit              quit',
    'keys: esc cancels a run · y/n answer approval cards',
  ]

  const COMMANDS: PickerItem[] = [
    { id: 'model', label: '/model', hint: 'switch model' },
    { id: 'profile', label: '/profile', hint: 'switch profile (new thread)' },
    { id: 'expand', label: '/expand', hint: 'show the last group\'s steps' },
    { id: 'agents', label: '/agents', hint: 'replay a sub-agent transcript' },
    { id: 'help', label: '/help', hint: 'show help' },
    { id: 'exit', label: '/exit', hint: 'quit' },
  ]

  const runCommand = (name: string, arg: string): void => {
    switch (name) {
      case 'exit':
      case 'quit':
      case 'q':
        void shutdown()
        return
      case 'help':
        out('\n')
        for (const line of HELP_LINES) out(s.dim(line) + '\n')
        return
      case 'expand':
        if (!transcript.expandLast()) confirm('nothing to expand yet')
        return
      case 'agents': {
        if (subagentsSeen.length === 0) {
          confirm('no sub-agents this session')
          return
        }
        const seen = new Map<string, string>()
        for (const entry of subagentsSeen) seen.set(entry.agentId, entry.threadId)
        const items = [...seen.entries()].reverse().map(([agentId]) => ({
          id: agentId,
          label: `◇ ${agentId}`,
        }))
        openPicker('/agents', items, arg, (id) => {
          const forThread = seen.get(id)
          if (forThread !== undefined) void replayAgentTranscript(id, forThread)
        })
        return
      }
      case 'model':
        void pickModel(arg)
        return
      case 'profile':
        void pickProfile(arg)
        return
      case '':
        openPicker('/', COMMANDS, '', (id) => runCommand(id, ''))
        return
      default:
        out(s.dim(`unknown command /${name} — try /help`) + '\n')
    }
  }

  // ── the pinned approval card ───────────────────────────────────────
  const presentApproval = (info: ApprovalInfo): Promise<ApprovalDecision> => {
    setState('approval')
    input.blur()
    const danger = info.severityTag === 'critical'
    // Render spec §6: amber frame (red when critical), zone in the
    // title, "wants to run" body, withheld-arguments honesty, inverse
    // key chips.
    cardBox.borderColor = danger ? TOKENS.danger : TOKENS.warning
    cardBox.title = info.zoneName !== null ? ` approval · zone ${info.zoneName} ` : ' approval '
    cardBox.titleColor = danger ? TOKENS.danger : TOKENS.warning
    const summary = info.inputSummary !== null ? `${info.inputSummary} — ` : ''
    cardLines[0]!.content = t` ${danger ? dangerT('⚠ ') : ''}${bold(info.toolName)} ${dimT(`wants to run · ${summary}arguments withheld by the gateway`)}`
    const chip = (key: string) => bg(TOKENS.cobalt)(fg('#0F0F0E')(` ${key} `))
    const keysLine = (parts: Array<[string, string]>) =>
      new StyledText(parts.flatMap(([key, label]) => [dimT(' '), chip(key), dimT(` ${label}  `)]))
    // severityTag: critical disables "always" — one-time approval only
    // (render spec §6).
    const baseKeys: Array<[string, string]> = danger
      ? [
          ['y', 'allow once'],
          ['n', 'deny'],
          ['esc', 'deny'],
        ]
      : [
          ['y', 'allow once'],
          ['a', `always for ${info.toolName}`],
          ['p', 'whole profile'],
          ['n', 'deny'],
        ]
    cardLines[1]!.content = keysLine(baseKeys)
    cardBox.visible = true
    relayout()

    return new Promise<ApprovalDecision>((resolveDecision) => {
      const finish = (decision: ApprovalDecision) => {
        approvalKeys = null
        cardBox.visible = false
        for (const line of cardLines) line.content = ''
        setState('running')
        input.focus()
        relayout()
        resolveDecision(decision)
      }
      let confirming: 'always-tool' | 'always-profile' | null = null
      approvalKeys = (key) => {
        if (confirming !== null) {
          // The two-step confirm shows the exact rule being saved —
          // never grant a wildcard you didn't read (render spec §6).
          if (key === 'y' || key === 'Y') {
            finish(confirming)
          } else {
            confirming = null
            cardLines[1]!.content = keysLine(baseKeys)
            renderer.requestRender()
          }
          return
        }
        if (key === 'y' || key === 'Y') {
          finish('approve')
          return
        }
        if (key === 'n' || key === 'N' || key === KEY_ESC || key === KEY_CTRL_C) {
          finish('deny')
          return
        }
        if (!danger && (key === 'a' || key === 'A' || key === 'p' || key === 'P')) {
          confirming = key === 'a' || key === 'A' ? 'always-tool' : 'always-profile'
          const pattern = confirming === 'always-profile' ? '*' : info.toolName
          const zone = info.zoneName !== null ? ` · max zone: ${info.zoneName}` : ''
          cardLines[1]!.content = new StyledText([
            warnT(` save rule: ${pattern}${zone} → ${currentProfile}.json`),
            dimT('   '),
            chip('y'),
            dimT(' confirm  '),
            chip('esc'),
            dimT(' back'),
          ])
          renderer.requestRender()
        }
      }
    })
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  let closed = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolveDonePromise) => {
    resolveDone = resolveDonePromise
  })

  async function shutdown(): Promise<void> {
    if (closed) return
    closed = true
    clearInterval(liveTicker)
    // Restore terminal ownership before destroying the renderer so pending
    // output cannot enter a closed capture pipeline and scrollback survives.
    if (renderer.externalOutputMode !== 'passthrough') {
      renderer.externalOutputMode = 'passthrough'
    }
    if (renderer.screenMode !== 'main-screen') {
      renderer.screenMode = 'main-screen'
    }
    renderer.destroy()
    resolveDone()
  }

  function submit(): void {
    if (closed || state !== 'idle' || picker.visible) return
    const prompt = input.value.trim()
    if (prompt === '') return
    input.value = ''
    if (prompt.startsWith('/')) {
      const [name = '', ...rest] = prompt.slice(1).split(/\s+/)
      runCommand(name, rest.join(' '))
      return
    }
    void runOnce(prompt)
  }

  async function runOnce(prompt: string): Promise<void> {
    setState('running')
    // Vertical rhythm: a blank line before each exchange, so turns
    // read as blocks instead of a wall (owner feedback).
    out('\n' + s.cyan('❯ ') + prompt + '\n\n')
    try {
      const started = await opts.client.run({
        profileId: currentProfile,
        prompt,
        ...(threadId !== null ? { threadId } : {}),
        ...(currentModel !== undefined ? { model: currentModel } : {}),
        ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
      })
      threadId = started.threadId
      const runId = started.runId ?? null
      opts.sessionStore.saveThread(opts.cwd, currentProfile, started.threadId)
      await streamRun(
        {
          client: opts.client,
          renderer: transcript,
          style: s,
          out,
          keys,
          askLine: async () => 'n',
          presentApproval,
          onRetry: (attempt) => {
            retryAttempt = attempt
            setState(state)
          },
          onEvent: (ev) => {
            if (ev.type === 'agent.spawn') {
              const agentId = typeof ev.data['agentId'] === 'string' ? ev.data['agentId'] : null
              if (agentId !== null) {
                subagentsSeen.push({ agentId, threadId: started.threadId })
                startChildWatch(agentId, started.threadId)
              }
            } else if (ev.type === 'agent.complete') {
              const agentId = typeof ev.data['agentId'] === 'string' ? ev.data['agentId'] : null
              if (agentId !== null) stopChildWatch(agentId)
            }
          },
        },
        { streamId: runId ?? started.threadId, runId, threadId: started.threadId },
      )
    } catch (err) {
      transcript.flushLine()
      out(s.red(`✖ ${err instanceof Error ? err.message : String(err)}\n`))
    } finally {
      stopAllChildWatches()
      flushPending()
      out('\n')
      liveSnapshot = null
      paintLive()
      if (!closed) {
        setState('idle')
        input.focus()
        renderer.requestRender()
        const next = queue.shift()
        if (next !== undefined) {
          setState(state)
          void runOnce(next)
        }
      }
    }
  }

  await done
}
