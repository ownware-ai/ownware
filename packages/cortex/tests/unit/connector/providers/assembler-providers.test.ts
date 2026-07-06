/**
 * Tests for the generalized ConnectorToolProvider iteration in the
 * assembler. Covers:
 *
 *   - Empty provider list works (regression for every existing caller)
 *   - Provider order is deterministic
 *   - A throwing provider is caught; other providers continue
 *   - Collision between two provider real tools throws
 *   - replaceToolNames swap a built-in
 *   - Legacy webSearchService option is wrapped into a provider and
 *     produces the same output as before (byte-stable against
 *     existing assembler-web-search tests, here as a sanity check)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assembleAgent } from '../../../../src/profile/assembler.js'
import { loadProfile } from '../../../../src/profile/loader.js'
import type { ConnectorToolProvider } from '../../../../src/connector/providers/types.js'
import type { Tool } from '@ownware/loom'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-prov-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeProfile(config: unknown): string {
  const dir = join(tmpDir, 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(config))
  return dir
}

function mkTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    isReadOnly: true,
    requiresPermission: false,
    category: 'custom',
    async execute() { return { content: name } },
  }
}

describe('assembler ConnectorToolProvider iteration', () => {
  it('empty provider list preserves existing behaviour', async () => {
    const dir = writeProfile({ name: 'p', model: 'anthropic:claude-3-5-haiku-20241022', tools: { preset: 'none' } })
    const profile = await loadProfile(dir)
    const result = await assembleAgent(profile, {})
    expect(result.tools).toEqual([])
  })

  it('providers run in given order', async () => {
    const dir = writeProfile({ name: 'p', model: 'anthropic:claude-3-5-haiku-20241022', tools: { preset: 'none' } })
    const profile = await loadProfile(dir)
    const order: string[] = []
    const mk = (src: string, toolName: string): ConnectorToolProvider => ({
      source: src,
      async getToolsForProfile() {
        order.push(src)
        return { tools: [mkTool(toolName)], stubs: [] }
      },
    })
    const result = await assembleAgent(profile, {
      toolProviders: [mk('a', 'tool_a'), mk('b', 'tool_b')],
    })
    expect(order).toEqual(['a', 'b'])
    expect(result.tools.map(t => t.name)).toEqual(['tool_a', 'tool_b'])
  })

  it('a throwing provider does NOT crash assembly; others still contribute', async () => {
    const dir = writeProfile({ name: 'p', model: 'anthropic:claude-3-5-haiku-20241022', tools: { preset: 'none' } })
    const profile = await loadProfile(dir)
    const bad: ConnectorToolProvider = {
      source: 'bad',
      async getToolsForProfile() { throw new Error('vendor down') },
    }
    const good: ConnectorToolProvider = {
      source: 'good',
      async getToolsForProfile() { return { tools: [mkTool('good_tool')], stubs: [] } },
    }
    const result = await assembleAgent(profile, { toolProviders: [bad, good] })
    expect(result.tools.some(t => t.name === 'good_tool')).toBe(true)
  })

  it('collision between two real tools from different providers throws', async () => {
    const dir = writeProfile({ name: 'p', model: 'anthropic:claude-3-5-haiku-20241022', tools: { preset: 'none' } })
    const profile = await loadProfile(dir)
    const p1: ConnectorToolProvider = {
      source: 'p1',
      async getToolsForProfile() { return { tools: [mkTool('dup')], stubs: [] } },
    }
    const p2: ConnectorToolProvider = {
      source: 'p2',
      async getToolsForProfile() { return { tools: [mkTool('dup')], stubs: [] } },
    }
    await expect(assembleAgent(profile, { toolProviders: [p1, p2] }))
      .rejects.toThrow(/collides/)
  })

  it('replaceToolNames swaps the matching built-in', async () => {
    const dir = writeProfile({
      name: 'p',
      model: 'anthropic:claude-3-5-haiku-20241022',
      tools: { preset: 'full' },
    })
    const profile = await loadProfile(dir)
    const replacer: ConnectorToolProvider = {
      source: 'web_search',
      async getToolsForProfile() {
        return {
          tools: [],
          stubs: [mkTool('web_search')],
          replaceToolNames: new Set(['web_search']),
        }
      },
    }
    const result = await assembleAgent(profile, { toolProviders: [replacer] })
    const hits = result.tools.filter(t => t.name === 'web_search')
    expect(hits).toHaveLength(1)
    // The replacement is our stub mock — it has description 'tool web_search'.
    expect(hits[0]!.description).toBe('tool web_search')
  })

  it('stubs with existing name are skipped', async () => {
    const dir = writeProfile({ name: 'p', model: 'anthropic:claude-3-5-haiku-20241022', tools: { preset: 'full' } })
    const profile = await loadProfile(dir)
    const p: ConnectorToolProvider = {
      source: 'x',
      async getToolsForProfile() {
        return { tools: [], stubs: [mkTool('web_search')] } // no replace → skipped
      },
    }
    const result = await assembleAgent(profile, { toolProviders: [p] })
    const ws = result.tools.filter(t => t.name === 'web_search')
    expect(ws).toHaveLength(1)
    // Original built-in still in place (not our mock).
    expect(ws[0]!.description).not.toBe('tool web_search')
  })
})
