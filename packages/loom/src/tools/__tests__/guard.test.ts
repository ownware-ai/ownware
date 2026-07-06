/**
 * Tool-guard primitive tests.
 *
 * Covers:
 *   - name matcher compilation
 *   - shell-kind spec compilation + error paths
 *   - shell semantics: deny patterns, required allowlist, L1/L4/L5 floor,
 *     L2/L3 toggles, empty-command passthrough
 *   - wrapToolsWithGuards: unguarded tools unchanged (ref-equal),
 *     deny produces structured error result, allow delegates, guard
 *     throw → deny, first-deny-wins, Promise vs AsyncGenerator tools
 */

import { describe, it, expect } from 'vitest'
import {
  compileNameMatcher,
  compileToolPolicies,
  wrapToolsWithGuards,
  type ToolGuard,
  type ToolPolicySpec,
} from '../guard.js'
import { defineTool } from '../types.js'
import type { Tool, ToolContext, ToolProgress, ToolResult } from '../types.js'
import { createDefaultConfig } from '../../core/config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test-session',
    agentId: null,
    workspacePath: '/tmp',
    config: createDefaultConfig('anthropic:claude-sonnet-4-20250514'),
    requestPermission: async () => true,
  }
}

async function runTool(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const out = tool.execute(input, fakeContext())
  if (out && typeof (out as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const gen = out as AsyncGenerator<ToolProgress, ToolResult>
    let next = await gen.next()
    while (!next.done) next = await gen.next()
    return next.value
  }
  return await (out as Promise<ToolResult>)
}

const promiseTool: Tool = defineTool({
  name: 'shell_execute',
  description: 'test shell tool',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  async execute(input) {
    return {
      content: `ran: ${String(input['command'])}`,
      isError: false,
    }
  },
})

const generatorTool: Tool = defineTool({
  name: 'stream_tool',
  description: 'test streaming tool',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  async *execute(input): AsyncGenerator<ToolProgress, ToolResult> {
    yield { message: 'step 1' }
    yield { message: 'step 2' }
    return { content: `streamed: ${String(input['command'])}`, isError: false }
  },
})

// ---------------------------------------------------------------------------
// compileNameMatcher
// ---------------------------------------------------------------------------

describe('compileNameMatcher', () => {
  it('matches everything for "*"', () => {
    const m = compileNameMatcher('*')
    expect(m('foo')).toBe(true)
    expect(m('mcp__github__create_issue')).toBe(true)
  })

  it('matches exact names', () => {
    const m = compileNameMatcher('shell_execute')
    expect(m('shell_execute')).toBe(true)
    expect(m('shell_execute_extra')).toBe(false)
    expect(m('shell')).toBe(false)
  })

  it('matches glob prefixes', () => {
    const m = compileNameMatcher('mcp__*')
    expect(m('mcp__github__foo')).toBe(true)
    expect(m('shell_execute')).toBe(false)
  })

  it('escapes regex special chars in literal segments', () => {
    const m = compileNameMatcher('a.b*')
    expect(m('a.b_foo')).toBe(true)
    // Must not treat the dot as "any char".
    expect(m('axb_foo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// compileToolPolicies — validation
// ---------------------------------------------------------------------------

describe('compileToolPolicies (validation)', () => {
  it('throws on empty tool pattern', () => {
    expect(() =>
      compileToolPolicies([{ tool: '', kind: 'shell' } as ToolPolicySpec]),
    ).toThrow(/must be a non-empty pattern/)
  })

  it('throws on invalid regex source in denyPatterns', () => {
    expect(() =>
      compileToolPolicies([
        { tool: 'shell_execute', kind: 'shell', denyPatterns: ['[unterminated'] },
      ]),
    ).toThrow(/denyPatterns\[0\].*invalid regex/)
  })

  it('returns one guard per spec', () => {
    const guards = compileToolPolicies([
      { tool: 'shell_execute', kind: 'shell' },
      { tool: 'stream_tool', kind: 'shell' },
    ])
    expect(guards).toHaveLength(2)
    expect(guards[0]!.id).toBe('shell:shell_execute')
    expect(guards[1]!.id).toBe('shell:stream_tool')
  })
})

// ---------------------------------------------------------------------------
// Shell spec semantics
// ---------------------------------------------------------------------------

describe('shell policy semantics', () => {
  function evalShell(spec: ToolPolicySpec, command: string) {
    const guard = compileToolPolicies([spec])[0]!
    return guard.evaluate({ command }, fakeContext())
  }

  it('allows when no constraints and command is safe', () => {
    const d = evalShell({ tool: 'shell_execute', kind: 'shell' }, 'ls -la')
    expect(d.type).toBe('allow')
  })

  it('denies when allowPrefixes is set and command does not match', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell', allowPrefixes: ['git log', 'ls'] },
      'rm foo',
    )
    expect(d.type).toBe('deny')
    if (d.type === 'deny') {
      expect(d.reason).toMatch(/allowlist/)
      expect(d.ruleId).toBe('shell:shell_execute:allowlist')
    }
  })

  it('allows when allowPrefixes is set and command matches (and is safe)', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell', allowPrefixes: ['ls', 'git log'] },
      'ls -la',
    )
    expect(d.type).toBe('allow')
  })

  it('denyPatterns take precedence over allowPrefixes', () => {
    const d = evalShell(
      {
        tool: 'shell_execute',
        kind: 'shell',
        allowPrefixes: ['git'],
        denyPatterns: ['^git push'],
      },
      'git push origin main',
    )
    expect(d.type).toBe('deny')
    if (d.type === 'deny') {
      expect(d.ruleId).toBe('shell:shell_execute:deny-pattern')
    }
  })

  it('Level 1 (mkfs) is always denied even with allowDangerous', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell', allowDangerous: true },
      'mkfs.ext4 /dev/sda1',
    )
    expect(d.type).toBe('deny')
    if (d.type === 'deny') {
      expect(d.ruleId).toBe('shell:shell_execute:blocked')
    }
  })

  it('Level 2 (rm -rf) denied by default', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell' },
      'rm -rf /tmp/some-path',
    )
    expect(d.type).toBe('deny')
    if (d.type === 'deny') {
      expect(d.ruleId).toBe('shell:shell_execute:dangerous')
    }
  })

  it('Level 2 (rm -rf) allowed when allowDangerous is true', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell', allowDangerous: true },
      'rm -rf /tmp/some-path',
    )
    expect(d.type).toBe('allow')
  })

  it('Level 3 (command substitution) denied by default', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell' },
      'echo $(whoami)',
    )
    expect(d.type).toBe('deny')
    if (d.type === 'deny') {
      expect(d.ruleId).toBe('shell:shell_execute:injection')
    }
  })

  it('Level 3 allowed when allowInjection is true', () => {
    const d = evalShell(
      { tool: 'shell_execute', kind: 'shell', allowInjection: true },
      'echo $(whoami)',
    )
    expect(d.type).toBe('allow')
  })

  it('empty command is passed through (tool handles it)', () => {
    const d = evalShell({ tool: 'shell_execute', kind: 'shell' }, '   ')
    expect(d.type).toBe('allow')
  })

  it('missing command field is treated as empty', () => {
    const guard = compileToolPolicies([
      { tool: 'shell_execute', kind: 'shell' },
    ])[0]!
    const d = guard.evaluate({} as Record<string, unknown>, fakeContext())
    expect(d.type).toBe('allow')
  })
})

// ---------------------------------------------------------------------------
// wrapToolsWithGuards
// ---------------------------------------------------------------------------

describe('wrapToolsWithGuards', () => {
  it('returns ref-equal tool when no guards apply', () => {
    const wrapped = wrapToolsWithGuards([promiseTool], [])
    expect(wrapped[0]).toBe(promiseTool)
  })

  it('leaves tools with no matching guard unchanged', () => {
    const guards = compileToolPolicies([
      { tool: 'other_tool', kind: 'shell' },
    ])
    const wrapped = wrapToolsWithGuards([promiseTool], guards)
    expect(wrapped[0]).toBe(promiseTool)
  })

  it('wraps tools that match a guard', async () => {
    const guards = compileToolPolicies([
      { tool: 'shell_execute', kind: 'shell' },
    ])
    const wrapped = wrapToolsWithGuards([promiseTool], guards)
    expect(wrapped[0]).not.toBe(promiseTool)
    const result = await runTool(wrapped[0]!, { command: 'ls' })
    expect(result.isError).toBe(false)
    expect(result.content).toBe('ran: ls')
  })

  it('produces structured deny result when guard denies', async () => {
    const guards = compileToolPolicies([
      {
        tool: 'shell_execute',
        kind: 'shell',
        allowPrefixes: ['ls'],
      },
    ])
    const [wrapped] = wrapToolsWithGuards([promiseTool], guards)
    const result = await runTool(wrapped!, { command: 'rm -rf /tmp/x' })
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Blocked by policy/)
    expect(result.metadata).toMatchObject({
      policy: 'deny',
      tool: 'shell_execute',
      ruleId: 'shell:shell_execute:allowlist',
    })
  })

  it('wraps AsyncGenerator tools and preserves progress events', async () => {
    const guards = compileToolPolicies([
      { tool: 'stream_tool', kind: 'shell' },
    ])
    const [wrapped] = wrapToolsWithGuards([generatorTool], guards)
    const gen = wrapped!.execute({ command: 'ls' }, fakeContext()) as AsyncGenerator<
      ToolProgress,
      ToolResult
    >
    const progress: string[] = []
    let next = await gen.next()
    while (!next.done) {
      progress.push(next.value.message)
      next = await gen.next()
    }
    expect(progress).toEqual(['step 1', 'step 2'])
    expect(next.value.isError).toBe(false)
    expect(next.value.content).toBe('streamed: ls')
  })

  it('first deny wins when multiple guards target the same tool', async () => {
    const g1: ToolGuard = {
      id: 'custom-allow',
      appliesTo: (n) => n === 'shell_execute',
      evaluate: () => ({ type: 'allow' }),
    }
    const g2: ToolGuard = {
      id: 'custom-deny',
      appliesTo: (n) => n === 'shell_execute',
      evaluate: () => ({
        type: 'deny',
        reason: 'second guard said no',
        ruleId: 'g2',
      }),
    }
    // g1 runs first and allows; g2 runs second and denies.
    const [wrapped] = wrapToolsWithGuards([promiseTool], [g1, g2])
    const result = await runTool(wrapped!, { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({ ruleId: 'g2' })
  })

  it('treats a throwing guard as deny', async () => {
    const bad: ToolGuard = {
      id: 'oops',
      appliesTo: () => true,
      evaluate: () => {
        throw new Error('boom')
      },
    }
    const [wrapped] = wrapToolsWithGuards([promiseTool], [bad])
    const result = await runTool(wrapped!, { command: 'ls' })
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Blocked by policy/)
    expect(result.content).toMatch(/guard 'oops' threw: boom/)
    expect(result.metadata).toMatchObject({ ruleId: 'oops' })
  })
})
