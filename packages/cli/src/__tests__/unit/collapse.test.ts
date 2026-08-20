import { describe, expect, it } from 'vitest'
import {
  CollapsingRenderer,
  SubagentActivity,
  describeTool,
  parseThinkingTitle,
  type LiveGroup,
} from '../../tui/collapse.js'
import { PLAIN_STYLE } from '../../style.js'

const READ_DESCRIPTOR = {
  kind: 'file-read',
  summary: { verb: 'Read', primaryField: 'file_path' },
} as const
const WRITE_DESCRIPTOR = {
  kind: 'file-write',
  summary: { verb: 'Wrote', primaryField: 'file_path' },
} as const
const EDIT_DESCRIPTOR = {
  kind: 'file-edit',
  summary: { verb: 'Edited', primaryField: 'file_path' },
} as const
const LIST_DESCRIPTOR = {
  kind: 'file-read',
  summary: { verb: 'Listed', primaryField: 'path' },
} as const
const SHELL_DESCRIPTOR = {
  kind: 'shell',
  summary: { verb: 'Ran', primaryField: 'command' },
} as const

function harness(startMs = 1000) {
  let buf = ''
  let clock = startMs
  const liveLog: Array<LiveGroup | null> = []
  const r = new CollapsingRenderer({
    style: PLAIN_STYLE,
    out: (chunk) => {
      buf += chunk
    },
    onLive: (live) => {
      liveLog.push(live)
    },
    now: () => clock,
  })
  return {
    r,
    text: () => buf,
    live: liveLog,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('CollapsingRenderer — the collapse law', () => {
  it('a multi-tool group prints NO rows, then exactly one settle line', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', uiDescriptor: READ_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't1', durationMs: 100, isError: false })
    h.r.handle('tool.call.start', { toolCallId: 't2', toolName: 'ripgrep' })
    h.r.handle('tool.call.end', { toolCallId: 't2', durationMs: 200, isError: false })
    h.r.handle('tool.call.start', { toolCallId: 't3', toolName: 'editFile', uiDescriptor: EDIT_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't3', durationMs: 300, isError: false })
    expect(h.text()).toBe('') // NOTHING while live
    h.tick(26_000)
    h.r.handle('text.delta', { text: 'Done — three files touched.' })
    h.r.flushLine()
    expect(h.text()).toBe('✓ Worked through 3 steps · Read, ripgrep, Edited · 26.0s ›\n\nDone — three files touched.\n')
  })

  it('the lone-tool exception keeps its single row', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', uiDescriptor: READ_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't1', durationMs: 843, isError: false })
    h.r.handle('text.delta', { text: 'That file is fine.' })
    h.r.flushLine()
    expect(h.text()).toBe('● Read  843ms ›\n\nThat file is fine.\n')
  })

  it('turn.end with end_turn settles; tool_use does not', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't1', durationMs: 10, isError: false })
    h.r.handle('turn.end', { stopReason: 'tool_use' })
    expect(h.text()).toBe('') // loop continues — group stays open
    h.r.handle('tool.call.start', { toolCallId: 't2', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't2', durationMs: 10, isError: false })
    h.r.handle('turn.end', { stopReason: 'end_turn' })
    expect(h.text()).toMatch(/^✓ Worked through 2 steps · Ran ×2 · /)
  })

  it('live updates carry steps, current action, and elapsed', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile' })
    h.tick(5_000)
    h.r.handle('tool.call.start', { toolCallId: 't2', toolName: 'ripgrep' })
    const last = h.live[h.live.length - 1]
    expect(last).toMatchObject({ steps: 2, elapsedMs: 5_000 })
    h.r.handle('text.delta', { text: 'ok' })
    expect(h.live[h.live.length - 1]).toBeNull() // settled → live cleared
  })

  it('tool progress becomes the live action line', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'channel_connect' })
    h.r.handle('tool.call.progress', { toolCallId: 't1', progress: 'Checked the number' })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '· Checked the number' })
  })

  it('failed tools never collapse — the red row prints mid-group', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('tool.call.end', {
      toolCallId: 't1',
      durationMs: 12,
      isError: true,
      result: 'exit 1: no such file',
    })
    expect(h.text()).toContain('✗ Ran · 12ms')
    expect(h.text()).toContain('  exit 1: no such file')
  })

  it('thinking is exactly one line, titled from **Title** at complete', () => {
    const h = harness()
    h.r.handle('thinking.delta', { text: 'Let me think. **Weighing the options** more text' })
    h.r.handle('thinking.delta', { text: ' and more.' })
    expect(h.text()).toBe('') // nothing while streaming
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '✳ Thinking…' })
    h.r.handle('thinking.complete', {})
    expect(h.text()).toBe('✳ Thought: Weighing the options · 0ms\n')
  })

  it('untitled thinking folds to one timed line (render spec §3)', () => {
    const h = harness()
    h.r.handle('thinking.delta', { text: 'no title here' })
    h.tick(4_100)
    h.r.handle('thinking.complete', {})
    expect(h.text()).toBe('✳ Thought for 4.1s\n')
  })

  it('permission decisions always print, even mid-group', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'send_email' })
    h.r.handle('permission.request', { requestId: 'p1', toolName: 'send_email' })
    h.r.handle('permission.response', { requestId: 'p1', granted: false })
    expect(h.text()).toBe('● send_email denied\n')
  })

  it('subagents count as steps with a ◇ action line', () => {
    const h = harness()
    h.r.handle('agent.spawn', { agentId: 'explore-1' })
    expect(h.live[h.live.length - 1]).toMatchObject({ steps: 1, action: '◇ explore-1 starting…' })
    h.r.handle('agent.complete', { agentId: 'explore-1' })
    h.r.handle('turn.end', { stopReason: 'end_turn' })
    expect(h.text()).toMatch(/1 step · Delegated/)
  })

  it('turn.interrupted settles the group before the interrupt line', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 't1', durationMs: 5, isError: false })
    h.r.handle('tool.call.start', { toolCallId: 't2', toolName: 'shell_execute', uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('turn.interrupted', { reason: 'user' })
    expect(h.text()).toMatch(/^✓ Worked through 2 steps · Ran ×2 · .*›\n⎋ run user\n$/)
  })
})

describe('CollapsingRenderer — clear tool stories (owner round 3)', () => {
  it('shell commands show WHAT ran, live and settled, with a result preview', () => {
    const h = harness()
    h.r.handle('tool.call.start', {
      toolCallId: 't1',
      toolName: 'shell_execute',
      input: { command: 'bun run build' },
      uiDescriptor: SHELL_DESCRIPTOR,
    })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◐ Running $ bun run build…' })
    h.r.handle('tool.call.end', {
      toolCallId: 't1',
      durationMs: 4200,
      isError: false,
      result: 'line one\nline two\nline three\nline four\nline five\nline six',
    })
    h.r.handle('text.delta', { text: 'Built.' })
    h.r.flushLine()
    const text = h.text()
    expect(text).toContain('● Ran $ bun run build  4.2s ›')
    expect(text).toContain('  line one')
    expect(text).toContain('  line four')
    expect(text).toContain('  … +2 lines')
    expect(text).not.toContain('line six')
  })

  it('a group of only shell commands settles as "Ran N shell commands"', () => {
    const h = harness()
    for (const id of ['a', 'b', 'c']) {
      h.r.handle('tool.call.start', {
        toolCallId: id,
        toolName: 'shell_execute',
        input: { command: 'x' },
        uiDescriptor: SHELL_DESCRIPTOR,
      })
      h.r.handle('tool.call.end', { toolCallId: id, durationMs: 5, isError: false })
    }
    h.tick(3000)
    h.r.handle('text.delta', { text: 'done' })
    expect(h.text()).toContain('✓ Worked through 3 steps · Ran ×3 · 3.0s ›')
  })

  it('file tools show their target path', () => {
    const h = harness()
    h.r.handle('tool.call.start', {
      toolCallId: 't1',
      toolName: 'writeFile',
      input: { file_path: 'src/index.ts' },
      uiDescriptor: WRITE_DESCRIPTOR,
    })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◐ Writing src/index.ts…' })
  })

  it('thinking closes BEFORE the prose, never after (owner screenshot bug)', () => {
    const h = harness()
    h.r.handle('thinking.delta', { text: 'pondering **The Plan**' })
    h.r.handle('text.delta', { text: 'Here it is.' })
    h.r.handle('turn.end', { stopReason: 'end_turn' })
    h.r.flushLine()
    expect(h.text()).toBe('✳ Thought: The Plan · 0ms\n\nHere it is.\n')
  })

  it('thinking closes before a tool call too (titled prints, in order)', () => {
    const h = harness()
    h.r.handle('thinking.delta', { text: '**Reading first**' })
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', input: {}, uiDescriptor: READ_DESCRIPTOR })
    expect(h.text()).toBe('✳ Thought: Reading first · 0ms\n')
  })
})

describe('CollapsingRenderer — /expand (owner round 5)', () => {
  it('expandLast reprints the settled rows, append-only', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 'a', toolName: 'listFiles', input: { path: '.' }, uiDescriptor: LIST_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'a', durationMs: 4, isError: false })
    h.r.handle('tool.call.start', { toolCallId: 'b', toolName: 'readFile', input: { file_path: 'x.ts' }, uiDescriptor: READ_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'b', durationMs: 9, isError: false })
    h.r.handle('text.delta', { text: 'done\n' })
    expect(h.text()).toContain('✓ Worked through 2 steps · Listed, Read ·')
    expect(h.r.expandLast()).toBe(true)
    expect(h.text()).toContain('⎿ 2 steps')
    expect(h.text()).toContain('   ● Listed . · 4ms')
    expect(h.text()).toContain('   ● Read x.ts · 9ms')
  })

  it('expandLast is honest when nothing settled', () => {
    const h = harness()
    expect(h.r.expandLast()).toBe(false)
  })

  it('whitespace-only deltas do not split a live group', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 'a', toolName: 'listFiles', input: {}, uiDescriptor: LIST_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'a', durationMs: 1, isError: false })
    h.r.handle('text.delta', { text: '\n\n' })
    h.r.handle('tool.call.start', { toolCallId: 'b', toolName: 'readFile', input: {}, uiDescriptor: READ_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'b', durationMs: 1, isError: false })
    h.r.handle('text.delta', { text: 'real text' })
    const settles = h.text().match(/✓ /g) ?? []
    expect(settles).toHaveLength(1)
    expect(h.text()).toContain('✓ Worked through 2 steps')
  })
})

describe('CollapsingRenderer — sonnet-shaped runs (owner round 7)', () => {
  it('untitled thinking BETWEEN tools is absorbed — no stacked Thought lines', () => {
    const h = harness()
    h.r.handle('thinking.delta', { text: 'hmm' })
    h.tick(1300)
    h.r.handle('tool.call.start', { toolCallId: 'a', toolName: 'listFiles', input: { path: '.' }, uiDescriptor: LIST_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'a', durationMs: 4, isError: false })
    h.r.handle('thinking.delta', { text: 'more' })
    h.tick(2300)
    h.r.handle('tool.call.start', { toolCallId: 'b', toolName: 'readFile', input: { file_path: 'x.ts' }, uiDescriptor: READ_DESCRIPTOR })
    h.r.handle('tool.call.end', { toolCallId: 'b', durationMs: 9, isError: false })
    h.r.handle('text.delta', { text: 'Here is the answer.' })
    h.r.flushLine()
    expect(h.text()).not.toContain('Thought for')
    expect(h.text()).toContain('· thought 3.6s')
    expect(h.text()).toMatch(/^✓ Worked through/)
  })

  it('streamed args fill the object slot: live action and settled row get the real path', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'readFile', input: {}, uiDescriptor: READ_DESCRIPTOR })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◐ Reading…' })
    h.r.handle('tool.call.args_delta', { toolCallId: 't1', delta: '{"file_pa' })
    h.r.handle('tool.call.args_delta', { toolCallId: 't1', delta: 'th":"packages/loom/src/index.ts"' })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◐ Reading…' })
    h.r.handle('tool.call.args_delta', { toolCallId: 't1', delta: '}' })
    expect(h.live[h.live.length - 1]).toMatchObject({
      action: '◐ Reading packages/loom/src/index.ts…',
    })
    h.r.handle('tool.call.end', { toolCallId: 't1', durationMs: 12, isError: false })
    // Done form stays visible until the next step (no blank pulse).
    expect(h.live[h.live.length - 1]).toMatchObject({
      action: '● Read packages/loom/src/index.ts',
    })
    h.r.handle('text.delta', { text: 'ok' })
    h.r.flushLine()
    expect(h.text()).toContain('● Read packages/loom/src/index.ts  12ms ›')
  })

  it('streamed shell command shows as $ command', () => {
    const h = harness()
    h.r.handle('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', input: {}, uiDescriptor: SHELL_DESCRIPTOR })
    h.r.handle('tool.call.args_delta', { toolCallId: 't1', delta: '{"command":"bun run build"}' })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◐ Running $ bun run build…' })
  })
})

describe('SubagentActivity — the child-stream fold (S3)', () => {
  it('derives the live action from the child stream, streamed args included', () => {
    const a = new SubagentActivity()
    a.handle('tool.call.start', { toolCallId: 'c1', toolName: 'readFile', input: {}, uiDescriptor: READ_DESCRIPTOR })
    expect(a.action).toBe('◐ Reading…')
    a.handle('tool.call.args_delta', { toolCallId: 'c1', delta: '{"file_path":"pkg/a.ts"}' })
    expect(a.action).toBe('◐ Reading pkg/a.ts…')
    a.handle('tool.call.end', { toolCallId: 'c1' })
    expect(a.action).toBe('● Read pkg/a.ts')
    expect(a.steps).toBe(1)
    a.handle('thinking.delta', { text: 'x' })
    expect(a.action).toBe('✳ Thinking…')
  })

  it('updateSubagentLive paints the ◇ line with child detail', () => {
    const h = harness()
    h.r.handle('agent.spawn', { agentId: 'scout' })
    expect(h.live[h.live.length - 1]).toMatchObject({ action: '◇ scout starting…' })
    h.r.updateSubagentLive('scout', '◐ Reading pkg/a.ts…', 3)
    expect(h.live[h.live.length - 1]).toMatchObject({
      action: '◇ scout ◐ Reading pkg/a.ts… · step 3',
    })
  })
})

describe('tool descriptor authority', () => {
  it('does not infer semantics from a misleading name or familiar input keys', () => {
    const facts = describeTool('read_file_then_charge_card', {
      command: 'bun run build',
      file_path: 'src/index.ts',
    })

    expect(facts).toMatchObject({
      verb: 'read_file_then_charge_card',
      target: 'bun run build',
      isShell: false,
    })
  })

  it('fails a malformed descriptor back to the generic view', () => {
    const facts = describeTool(
      'external_operation',
      { command: 'bun run build' },
      { kind: 'shell', summary: { verb: 'Ran\nsecret', primaryField: 'command' } },
    )

    expect(facts).toMatchObject({
      verb: 'external_operation',
      target: 'bun run build',
      isShell: false,
    })
  })
})

describe('parseThinkingTitle', () => {
  it('extracts the first bold title', () => {
    expect(parseThinkingTitle('abc **The Plan** def **Other**')).toBe('The Plan')
    expect(parseThinkingTitle('no title')).toBeNull()
    expect(parseThinkingTitle('empty ****')).toBeNull()
  })
})
