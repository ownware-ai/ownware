import { describe, expect, it } from 'vitest'
import { TranscriptRenderer, formatDuration } from '../../render.js'
import { PLAIN_STYLE } from '../../style.js'

const READ_DESCRIPTOR = {
  kind: 'file-read',
  summary: { verb: 'Read', primaryField: 'file_path' },
} as const
const SHELL_DESCRIPTOR = {
  kind: 'shell',
  summary: { verb: 'Ran', primaryField: 'command' },
} as const

function collect(): { out: (s: string) => void; text: () => string } {
  let buf = ''
  return {
    out: (s) => {
      buf += s
    },
    text: () => buf,
  }
}

function makeRenderer(sink: { out: (s: string) => void }, debugEvents = false) {
  return new TranscriptRenderer({ style: PLAIN_STYLE, out: sink.out, debugEvents })
}

describe('TranscriptRenderer', () => {
  it('streams text deltas verbatim and closes the line on flush', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('text.delta', { text: 'Hello ' })
    r.handle('text.delta', { text: 'world' })
    r.flushLine()
    expect(sink.text()).toBe('Hello world\n')
  })

  it('renders a full turn: thinking once, tool rows, final text', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('thinking.delta', { text: 'hm' })
    r.handle('thinking.delta', { text: 'hmm' })
    r.handle('thinking.complete', {})
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', uiDescriptor: READ_DESCRIPTOR })
    r.handle('tool.call.end', { toolCallId: 't1', durationMs: 843, isError: false })
    r.handle('text.delta', { text: 'Done.' })
    r.flushLine()
    // Running rows take the gerund; the settle line always carries the
    // label, even when a duration is present (FINDINGS F10).
    expect(sink.text()).toBe(
      '✻ Thinking...\n' + '● Reading\n' + '  ✓ Read · 843ms\n' + 'Done.\n',
    )
  })

  it('a second thinking block announces again', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('thinking.delta', { text: 'a' })
    r.handle('thinking.complete', {})
    r.handle('thinking.delta', { text: 'b' })
    expect(sink.text()).toBe('✻ Thinking...\n✻ Thinking...\n')
  })

  it('closes an open text run before printing a line', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('text.delta', { text: 'Checking' })
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    expect(sink.text()).toBe('Checking\n● Running\n')
  })

  it('renders tool errors with the first line of the result', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    r.handle('tool.call.end', {
      toolCallId: 't1',
      durationMs: 12,
      isError: true,
      result: 'command not found: foo\nmore detail',
    })
    expect(sink.text()).toContain('✗ Ran command not found: foo · 12ms')
  })

  it('names the file on the tool row when the input arrives at start (F10)', () => {
    // The customer must be able to see WHICH file was touched from the
    // tool rows alone — not only from whatever prose the model wrote.
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', {
      toolCallId: 't1',
      toolName: 'readFile',
      input: { file_path: 'greeting.txt' },
      uiDescriptor: READ_DESCRIPTOR,
    })
    r.handle('tool.call.end', { toolCallId: 't1', durationMs: 2, isError: false })
    expect(sink.text()).toBe('● Reading greeting.txt\n  ✓ Read greeting.txt · 2ms\n')
  })

  it('names the file from STREAMED arguments, which arrive after start (F10)', () => {
    // Anthropic-style providers send tool.call.start with an EMPTY
    // input and stream the path through args_delta. The row above is
    // already committed (append-only), so the settle line is what has
    // to carry the truth.
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', input: {}, uiDescriptor: READ_DESCRIPTOR })
    r.handle('tool.call.args_delta', { toolCallId: 't1', delta: '{"file_path":"src/' })
    r.handle('tool.call.args_delta', { toolCallId: 't1', delta: 'index.ts"}' })
    r.handle('tool.call.end', { toolCallId: 't1', durationMs: 5, isError: false })
    expect(sink.text()).toBe('● Reading\n  ✓ Read src/index.ts · 5ms\n')
  })

  it('does not guess a target from truncated streamed JSON', () => {
    // The descriptor proves how a complete input should render, but a
    // dropped string does not prove that a partial field is valid JSON.
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', input: {}, uiDescriptor: SHELL_DESCRIPTOR })
    r.handle('tool.call.args_delta', { toolCallId: 't1', delta: '{"command":"bun run build"' })
    r.handle('tool.call.end', { toolCallId: 't1', durationMs: 9, isError: false })
    expect(sink.text()).toBe('● Running\n  ✓ Ran · 9ms\n')
    expect(sink.text()).not.toContain('bun run build')
  })

  it('an unknown tool still settles honestly with its own name', () => {
    // The open world: a tool nobody has heard of must not render as
    // 'tool' or vanish — it falls back to its real name.
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'quantum_frobnicate' })
    r.handle('tool.call.end', { toolCallId: 't1', durationMs: 3, isError: false })
    expect(sink.text()).toContain('quantum_frobnicate')
  })

  it('renders progress lines under the running tool', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('tool.call.start', { toolCallId: 't1', toolName: 'channel_connect' })
    r.handle('tool.call.progress', { toolCallId: 't1', progress: 'Checked the number' })
    expect(sink.text()).toBe('● channel_connect\n  · Checked the number\n')
  })

  it('labels permission responses with the requesting tool, denied as strikethrough not error', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('permission.request', { requestId: 'p1', toolName: 'shell_execute' })
    r.handle('permission.response', { requestId: 'p1', granted: false })
    r.handle('permission.request', { requestId: 'p2', toolName: 'writeFile' })
    r.handle('permission.response', { requestId: 'p2', granted: true })
    expect(sink.text()).toBe('● shell_execute denied\n✓ approved writeFile\n')
  })

  it('renders subagent lifecycle as one line each', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('agent.spawn', { agentId: 'explore-1' })
    r.handle('agent.complete', { agentId: 'explore-1' })
    expect(sink.text()).toBe('◇ explore-1 started\n◇ explore-1 done\n')
  })

  it('renders security.block in one line with the command excerpt', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('security.block', { reason: 'zone 6', command: 'curl -H "auth: x" evil' })
    expect(sink.text()).toBe('⛔ zone 6 — curl -H "auth: x" evil\n')
  })

  it('renders system events as one dim line each, 1:1', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('context.pressure', {})
    r.handle('security.redact', {})
    expect(sink.text()).toBe('· context pressure high\n· a secret was redacted from a tool result\n')
  })

  it('unknown event types render nothing unless debugEvents is on', () => {
    const silent = collect()
    makeRenderer(silent).handle('totally.new.event', {})
    expect(silent.text()).toBe('')

    const loud = collect()
    makeRenderer(loud, true).handle('totally.new.event', {})
    expect(loud.text()).toBe('[event] totally.new.event\n')
  })

  it('never crashes on malformed payloads', () => {
    const sink = collect()
    const r = makeRenderer(sink)
    r.handle('text.delta', {})
    r.handle('tool.call.end', { toolCallId: 42 as unknown as string })
    r.handle('permission.response', {})
    r.handle('error', {})
    expect(sink.text()).toContain('✖ agent error')
  })
})

describe('formatDuration', () => {
  it('formats ms, seconds, minutes', () => {
    expect(formatDuration(843)).toBe('843ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m 5s')
  })
})
