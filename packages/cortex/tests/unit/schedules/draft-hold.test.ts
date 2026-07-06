/**
 * Pure unit tests for the draft-hold core (`applyRunSafety` / `holdTool`).
 * Fake tools + a fake sink — no DB, no model — so this runs under plain node
 * (ENV-2 unaffected).
 *
 * The invariant: a draft-approval run can do its full read/compose job but
 * physically cannot send/write — every write tool is intercepted into an
 * approval, the real execute never runs, and missing wiring fails closed.
 */
import { describe, it, expect } from 'vitest'
import type { Tool, ToolResult } from '@ownware/loom'
import { applyRunSafety, envelopeSpawnerPool, holdTool, summarizeHeldCall, HELD_RESULT_MESSAGE, type HeldCall } from '../../../src/schedules/draft-hold.js'

let realRan = 0
function tool(name: string, isReadOnly: boolean | undefined): Tool {
  return {
    name,
    isReadOnly,
    execute: async (): Promise<ToolResult> => {
      realRan++
      return { content: 'REAL SIDE EFFECT', isError: false }
    },
  } as unknown as Tool
}

function fakeSink() {
  const held: HeldCall[] = []
  return { held, hold: (c: HeldCall) => held.push(c) }
}

const TOOLS: Tool[] = [tool('readFile', true), tool('web_search', true), tool('gmail_send', false), tool('writeFile', false)]
const names = (ts: Tool[]) => ts.map((t) => t.name)

describe('holdTool', () => {
  it('parks the call + returns a non-error held result, and never runs the real execute', async () => {
    realRan = 0
    const sink = fakeSink()
    const wrapped = holdTool(tool('gmail_send', false), sink)
    const res = await (wrapped.execute({ to: 'dana@acme.com', subject: 'Hi' }, {} as never) as Promise<ToolResult>)
    expect(res.isError).toBe(false)
    expect(res.content).toBe(HELD_RESULT_MESSAGE)
    expect(res.content).not.toContain('REAL SIDE EFFECT')
    expect(res.metadata).toMatchObject({ held: true, toolName: 'gmail_send' })
    expect(realRan).toBe(0) // the real side effect MUST NOT have run
    expect(sink.held).toEqual([{ toolName: 'gmail_send', toolInput: { to: 'dana@acme.com', subject: 'Hi' } }])
  })

  it('a sink that throws never breaks the tool (still held, still no side effect)', async () => {
    realRan = 0
    const wrapped = holdTool(tool('writeFile', false), { hold: () => { throw new Error('db down') } })
    const res = await (wrapped.execute({ path: '/x' }, {} as never) as Promise<ToolResult>)
    expect(res.isError).toBe(false)
    expect(realRan).toBe(0)
  })
})

describe('applyRunSafety', () => {
  it('full-access keeps every tool unchanged', () => {
    expect(names(applyRunSafety(TOOLS, 'full-access', fakeSink()))).toEqual(['readFile', 'web_search', 'gmail_send', 'writeFile'])
  })

  it('read-only keeps only read tools', () => {
    expect(names(applyRunSafety(TOOLS, 'read-only'))).toEqual(['readFile', 'web_search'])
  })

  it('draft-approval keeps reads as-is and wraps every write to hold', async () => {
    realRan = 0
    const sink = fakeSink()
    const out = applyRunSafety(TOOLS, 'draft-approval', sink)
    expect(names(out)).toEqual(['readFile', 'web_search', 'gmail_send', 'writeFile']) // all present
    // read tools are the SAME object (untouched)
    expect(out[0]).toBe(TOOLS[0])
    // invoking a write tool parks an approval, runs no side effect
    await (out[2]!.execute({ to: 'x' }, {} as never) as Promise<ToolResult>)
    await (out[3]!.execute({ path: '/y' }, {} as never) as Promise<ToolResult>)
    expect(realRan).toBe(0)
    expect(sink.held.map((h) => h.toolName)).toEqual(['gmail_send', 'writeFile'])
  })

  it('draft-approval with NO sink FAILS CLOSED to read-only (never executes a write)', () => {
    expect(names(applyRunSafety(TOOLS, 'draft-approval'))).toEqual(['readFile', 'web_search'])
  })

  it('an unknown isReadOnly flag is treated as a write (held / withheld)', () => {
    const t = [tool('mystery', undefined)]
    expect(names(applyRunSafety(t, 'read-only'))).toEqual([])
    const sink = fakeSink()
    const out = applyRunSafety(t, 'draft-approval', sink)
    expect(out.length).toBe(1) // wrapped, not dropped
    expect(out[0]).not.toBe(t[0]) // it was wrapped
  })
})

describe('envelopeSpawnerPool (safe-by-default is transitive to sub-agents)', () => {
  // A scheduled run is handed `agent_spawn` (isReadOnly), so it survives the
  // filter — but the spawner's POOL must be enveloped or a child executes the
  // full tool set. These lock that the pool the spawner holds is enveloped.
  const pool = () => [tool('readFile', true), tool('agent_spawn', true), tool('gmail_send', false), tool('writeFile', false)]

  it('read-only: strips every write from the pool but keeps agent_spawn + reads', () => {
    const p = pool()
    envelopeSpawnerPool(p, 'read-only')
    expect(names(p)).toEqual(['readFile', 'agent_spawn'])
  })

  it('draft-approval: a child WRITE parks an approval, never runs the real execute', async () => {
    realRan = 0
    const sink = fakeSink()
    const p = pool()
    envelopeSpawnerPool(p, 'draft-approval', sink)
    expect(names(p)).toEqual(['readFile', 'agent_spawn', 'gmail_send', 'writeFile']) // present but wrapped
    await (p[2]!.execute({ to: 'x' }, {} as never) as Promise<ToolResult>)
    await (p[3]!.execute({ file_path: '/y' }, {} as never) as Promise<ToolResult>)
    expect(realRan).toBe(0) // child writes never executed
    expect(sink.held.map((h) => h.toolName)).toEqual(['gmail_send', 'writeFile'])
  })

  it('draft-approval with NO sink fails closed to read-only (child gets no writes)', () => {
    const p = pool()
    envelopeSpawnerPool(p, 'draft-approval')
    expect(names(p)).toEqual(['readFile', 'agent_spawn'])
  })

  it('full-access leaves the pool untouched (the user opted in)', () => {
    const p = pool()
    envelopeSpawnerPool(p, 'full-access', fakeSink())
    expect(names(p)).toEqual(['readFile', 'agent_spawn', 'gmail_send', 'writeFile'])
  })

  it('undefined level (interactive run) is a no-op — writes stay live', () => {
    const p = pool()
    envelopeSpawnerPool(p, undefined)
    expect(names(p)).toEqual(['readFile', 'agent_spawn', 'gmail_send', 'writeFile'])
  })

  it('mutates IN PLACE — the spawner holds the pool by reference', () => {
    const p = pool()
    const ref = p // same array the spawner stored
    envelopeSpawnerPool(p, 'read-only')
    expect(ref).toBe(p)
    expect(names(ref)).toEqual(['readFile', 'agent_spawn']) // the spawner now sees the enveloped set
  })
})

describe('summarizeHeldCall', () => {
  it('email → recipient + subject', () => {
    expect(summarizeHeldCall('gmail_send', { to: 'dana@acme.com', subject: 'Re: renewal' })).toBe(
      'gmail_send → dana@acme.com — Re: renewal',
    )
  })
  it('file write → path', () => {
    expect(summarizeHeldCall('writeFile', { file_path: '/notes.md', content: '…' })).toBe('writeFile → /notes.md')
  })
  it('falls back to the tool name when nothing recognizable', () => {
    expect(summarizeHeldCall('mystery', { foo: 1 })).toBe('mystery')
    expect(summarizeHeldCall('mystery', null)).toBe('mystery')
  })
})
