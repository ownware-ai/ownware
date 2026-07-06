/**
 * Tool-usage fragment unit tests — Phase 5-D (2026-05-06).
 *
 * Verifies the conditional blocks in `createToolUsageFragment` —
 * each block only renders when the relevant tool is present.
 * Specifically targets the `connectors()` rule introduced in
 * Phase 5-D so the agent learns the explicit-intent contract.
 */

import { describe, it, expect } from 'vitest'
import { createToolUsageFragment } from '../tools.js'
import type { Tool } from '../../../tools/types.js'

function makeTool(name: string, category?: Tool['category']): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: false,
    requiresPermission: false,
    timeoutMs: null,
    maxResultSize: null,
    ...(category != null ? { category } : {}),
    execute: async () => ({ content: '', isError: false }),
  }
}

describe('createToolUsageFragment — connectors() block', () => {
  it('omits the connectors block when the tool is absent', () => {
    const f = createToolUsageFragment([makeTool('readFile', 'filesystem')])
    expect(f.content).not.toMatch(/Third-party services/)
    expect(f.content).not.toMatch(/connectors/)
  })

  it('includes the connectors block when the tool is present', () => {
    const f = createToolUsageFragment([
      makeTool('readFile', 'filesystem'),
      makeTool('connectors'),
    ])
    expect(f.content).toMatch(/Third-party services \(`connectors`\)/)
  })

  it('lists every action in the rule body', () => {
    const f = createToolUsageFragment([makeTool('connectors')])
    // The block must teach the agent which action to use when.
    expect(f.content).toMatch(/action: "search"/)
    expect(f.content).toMatch(/"list_attached"/)
    expect(f.content).toMatch(/"status"/)
  })

  it('sets the explicit-intent rule (do NOT call during chat / unrelated tasks)', () => {
    const f = createToolUsageFragment([makeTool('connectors')])
    expect(f.content).toMatch(/explicitly asks/)
    expect(f.content).toMatch(/Do NOT call/)
  })

  it('tells the agent NOT to summarize cards / steps in prose', () => {
    const f = createToolUsageFragment([makeTool('connectors')])
    expect(f.content).toMatch(/Say almost nothing in your text/)
    expect(f.content).toMatch(/Do NOT list connector names, descriptions/)
  })

  it('forbids repeating the suggestions banner in text when items exist', () => {
    const f = createToolUsageFragment([makeTool('connectors')])
    expect(f.content).toMatch(/Never repeat the suggestions banner in your text/)
    expect(f.content).toMatch(/zero matches AND suggestions are present/)
  })
})

describe('createToolUsageFragment — block independence', () => {
  it('renders only filesystem-shell rules when the connectors tool is absent', () => {
    const f = createToolUsageFragment([
      makeTool('readFile', 'filesystem'),
      makeTool('shell_execute', 'shell'),
    ])
    expect(f.content).toMatch(/Prefer dedicated tools over shell commands/)
    expect(f.content).not.toMatch(/Third-party services/)
  })

  it('renders multiple blocks together when their tools all present', () => {
    const f = createToolUsageFragment([
      makeTool('readFile', 'filesystem'),
      makeTool('shell_execute', 'shell'),
      makeTool('agent_spawn'),
      makeTool('todo_write'),
      makeTool('connectors'),
    ])
    expect(f.content).toMatch(/Editing files safely/)
    expect(f.content).toMatch(/Spawning subagents/)
    expect(f.content).toMatch(/Task tracking/)
    expect(f.content).toMatch(/Third-party services/)
  })
})
