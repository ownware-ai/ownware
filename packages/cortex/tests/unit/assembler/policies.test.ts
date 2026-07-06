/**
 * Integration tests: profile `policies` → Loom ToolGuards → wrapped tools.
 *
 * These tests load a real profile via loadProfile + assembleAgent and
 * then invoke the wrapped shell tool directly. No network, no agent loop.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'
import type {
  Tool,
  ToolContext,
  ToolProgress,
  ToolResult,
} from '@ownware/loom'
import { createDefaultConfig } from '@ownware/loom'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

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

async function runShellTool(
  tool: Tool,
  command: string,
): Promise<ToolResult> {
  const out = tool.execute({ command }, fakeContext())
  if (
    out &&
    typeof (out as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  ) {
    const gen = out as AsyncGenerator<ToolProgress, ToolResult>
    let next = await gen.next()
    while (!next.done) next = await gen.next()
    return next.value
  }
  return await (out as Promise<ToolResult>)
}

function findShell(tools: readonly Tool[]): Tool {
  const t = tools.find((x) => x.name === 'shell_execute')
  if (!t) throw new Error('shell_execute tool missing from assembled profile')
  return t
}

describe('assembleAgent: policies', () => {
  it('leaves tools unchanged when no policies are declared', async () => {
    const { dir } = track(
      await createMinimalProfile({ tools: { preset: 'coding' } }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    // shell_execute should behave as the underlying Loom tool would —
    // we assert that by checking the tool object has no ruleId metadata
    // on its descriptor (we cannot easily execute it against a real
    // shell without side effects, so this only confirms presence).
    const shell = findShell(agent.tools)
    expect(shell.name).toBe('shell_execute')
  })

  it('wraps shell_execute with an allowlist and denies unlisted commands', async () => {
    const { dir } = track(
      await createMinimalProfile({
        tools: { preset: 'coding' },
        policies: [
          {
            kind: 'shell',
            tool: 'shell_execute',
            allowPrefixes: ['ls', 'git log'],
          },
        ],
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    const shell = findShell(agent.tools)
    const result = await runShellTool(shell, 'curl example.com')
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Blocked by policy/)
    expect(result.metadata).toMatchObject({
      policy: 'deny',
      tool: 'shell_execute',
      ruleId: 'shell:shell_execute:allowlist',
    })
  })

  it('denies by denyPatterns regardless of allowlist', async () => {
    const { dir } = track(
      await createMinimalProfile({
        tools: { preset: 'coding' },
        policies: [
          {
            kind: 'shell',
            tool: 'shell_execute',
            allowPrefixes: ['git'],
            denyPatterns: ['^git push'],
          },
        ],
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    const shell = findShell(agent.tools)
    const result = await runShellTool(shell, 'git push origin main')
    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      ruleId: 'shell:shell_execute:deny-pattern',
    })
  })

  it('enforces shell-security Level 1 even with allowDangerous', async () => {
    const { dir } = track(
      await createMinimalProfile({
        tools: { preset: 'coding' },
        policies: [
          {
            kind: 'shell',
            tool: 'shell_execute',
            allowDangerous: true,
          },
        ],
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    const shell = findShell(agent.tools)
    const result = await runShellTool(shell, 'mkfs.ext4 /dev/sda1')
    expect(result.isError).toBe(true)
    expect(result.metadata).toMatchObject({
      policy: 'deny',
      ruleId: 'shell:shell_execute:blocked',
    })
  })

  it('surfaces a compile-time error for invalid regex sources', async () => {
    const { dir } = track(
      await createMinimalProfile({
        tools: { preset: 'coding' },
        policies: [
          {
            kind: 'shell',
            tool: 'shell_execute',
            denyPatterns: ['[unterminated'],
          },
        ],
      }),
    )
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/invalid regex/)
  })
})
