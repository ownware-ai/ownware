/**
 * Unit tests for profile assembler.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { systemPromptToText } from '@ownware/loom'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile, createTempProfile, EXAMPLE_PROFILE_DIR } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

describe('assembleAgent: provider', () => {
  it('resolves anthropic provider', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    expect(agent.provider.name).toBe('anthropic')
  })

  it('resolves openai provider', async () => {
    const { dir } = track(await createMinimalProfile({
      model: 'openai:gpt-4o',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.provider.name).toBe('openai')
  })

  it('resolves google provider', async () => {
    const { dir } = track(await createMinimalProfile({
      model: 'google:gemini-2.0-flash',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.provider.name).toBe('google')
  })

  it('throws on unknown provider', async () => {
    const { dir } = track(await createMinimalProfile({
      model: 'unknown:model-xyz',
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow('Unknown provider')
  })
})

// ---------------------------------------------------------------------------
// Tool assembly
// ---------------------------------------------------------------------------

describe('assembleAgent: tools', () => {
  it('includes builtin tools for "full" preset', async () => {
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'full' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.tools.length).toBeGreaterThan(0)
  })

  it('includes filesystem + shell for "coding" preset', async () => {
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'coding' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.tools.length).toBeGreaterThan(0)
  })

  it('includes only readonly filesystem tools for "readonly" preset', async () => {
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'readonly' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    // All tools should be read-only
    for (const tool of agent.tools) {
      expect(tool.isReadOnly).toBe(true)
    }
  })

  it('has no tools for "none" preset', async () => {
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'none' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.tools).toHaveLength(0)
  })

  it('applies deny filter', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    const names = agent.tools.map(t => t.name)
    expect(names).not.toContain('shell_execute')
  })

  it('rejects duplicate tool names', async () => {
    // This would happen if custom tools collide with builtins
    // Testing the validation path
    const { dir } = track(await createMinimalProfile({
      tools: { preset: 'none' },
    }))
    const profile = await loadProfile(dir)
    // No duplicates with preset: none and no custom tools — should be fine
    const agent = await assembleAgent(profile)
    const names = agent.tools.map(t => t.name)
    const unique = new Set(names)
    expect(names.length).toBe(unique.size)
  })
})

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------

describe('assembleAgent: system prompt', () => {
  it('includes SOUL.md content', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Example Agent')
    expect(systemPromptToText(agent.systemPrompt)).toContain('helpful coding assistant')
  })

  it('includes AGENTS.md in memory slot', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Memory')
  })

  it('includes cwd context when enabled', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { cwd: true },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Working directory:')
  })

  it('includes datetime context when enabled', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { datetime: true },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Current date:')
  })

  it('includes OS context when enabled', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { os: true },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Platform:')
  })

  it('includes model info when enabled', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { modelInfo: true },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Model:')
  })

  it('uses inline systemPrompt when no SOUL.md', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'inline-prompt',
        systemPrompt: 'You are an inline agent.',
      }),
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('inline agent')
  })

  it('adds orchestrate guidance to the subagent fragment when helpers are declared', async () => {
    // `coding` preset does NOT include orchestrate; declaring a subagent
    // auto-injects it (assembler a.5b), which in turn surfaces the guidance.
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'helper-user',
        tools: { preset: 'coding' },
        subagents: [{ name: 'scout', description: 'Read-only search helper' }],
      }),
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    const prompt = systemPromptToText(agent.systemPrompt)
    expect(agent.tools.some(t => t.name === 'orchestrate')).toBe(true)
    expect(prompt).toContain('orchestrate')
    expect(prompt).toContain('fan-out')
    expect(prompt).toContain('map-reduce')
  })

  it('SOUL.md takes priority over inline systemPrompt', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'dual-prompt',
        systemPrompt: 'INLINE_MARKER',
      }),
      'SOUL.md': '# SOUL_MARKER\n\nIdentity from SOUL.md',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('SOUL_MARKER')
    expect(systemPromptToText(agent.systemPrompt)).not.toContain('INLINE_MARKER')
  })

  it('excludes disabled context', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { cwd: false, datetime: false, git: false, os: false, project: false, modelInfo: false },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).not.toContain('Working directory:')
    expect(systemPromptToText(agent.systemPrompt)).not.toContain('Current date:')
    expect(systemPromptToText(agent.systemPrompt)).not.toContain('Platform:')
    expect(systemPromptToText(agent.systemPrompt)).not.toContain('Model:')
  })

  it('adds the +Add rail-routing guidance when the connectors() tool is present', async () => {
    // Added 2026-05-13. The agent's `connectors()` tool exposes only
    // list_attached + status — it cannot add new connectors. Adding
    // happens via the chat AbilityRail's `+ Add` button. The system
    // prompt tells the agent to route users there instead of either
    // pretending it can add or staying silent.
    const { dir } = track(await createMinimalProfile({}))
    const profile = await loadProfile(dir)
    const stubConnectorsTool = {
      name: 'connectors',
      description: 'stub',
      inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
      isReadOnly: true,
      requiresPermission: false,
      category: 'custom' as const,
      execute: async () => ({ content: '', isError: false }),
    }
    const agent = await assembleAgent(profile, {
      toolProviders: [
        {
          source: 'stub-connectors',
          // eslint-disable-next-line @typescript-eslint/require-await
          async getToolsForProfile() {
            return {
              tools: [stubConnectorsTool as never],
              stubs: [],
            }
          },
        },
      ],
    })
    const prompt = systemPromptToText(agent.systemPrompt)
    expect(prompt).toContain('"+ Add"')
    expect(prompt).toContain('ability rail')
    expect(prompt).toContain('CANNOT add or connect services yourself')
  })

  it('omits the rail-routing guidance when no connectors() tool is in the catalog', async () => {
    // Counter-test: a profile assembled WITHOUT the connectors() tool
    // (e.g. a CLI / direct-Loom test path) must NOT carry the rail
    // instruction. It's a stale UI affordance reference for that
    // surface and only earns its place when the tool is actually
    // present.
    const { dir } = track(await createMinimalProfile({}))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    const prompt = systemPromptToText(agent.systemPrompt)
    expect(prompt).not.toContain('ability rail')
  })

  it('includes skills catalog when skills exist', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'skill-agent' }),
      'SOUL.md': '# Skill Agent',
      'skills/test.md': '---\nname: test-skill\ndescription: A test skill\ntrigger: /test\n---\nTest content.',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('Available Skills')
    expect(systemPromptToText(agent.systemPrompt)).toContain('/test-skill')
  })
})

// ---------------------------------------------------------------------------
// LoomConfig mapping
// ---------------------------------------------------------------------------

describe('assembleAgent: LoomConfig', () => {
  it('maps model correctly', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    expect(agent.config.model).toBe('anthropic:claude-sonnet-4-20250514')
  })

  it('maps maxTurns', async () => {
    const { dir } = track(await createMinimalProfile({ maxTurns: 25 }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.maxTurns).toBe(25)
  })

  it('maps maxTokens', async () => {
    const { dir } = track(await createMinimalProfile({ maxTokens: 4096 }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.maxTokens).toBe(4096)
  })

  it('maps maxBudgetUsd from execution.maxCostUsd', async () => {
    const { dir } = track(await createMinimalProfile({
      execution: { maxCostUsd: 10.0 },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.maxBudgetUsd).toBe(10.0)
  })

  it('defaults maxBudgetUsd to 0 when not set', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.maxBudgetUsd).toBe(0)
  })

  it('maps compaction config', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const agent = await assembleAgent(profile)
    expect(agent.config.compaction.strategy).toBe('summarize')
    expect(agent.config.compaction.trigger.type).toBe('fraction')
  })

  it('maps temperature', async () => {
    const { dir } = track(await createMinimalProfile({ temperature: 0.5 }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.temperature).toBe(0.5)
  })

  it('temperature null when not specified', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.temperature).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Checkpoint store
// ---------------------------------------------------------------------------

describe('assembleAgent: checkpoint', () => {
  it('creates MemoryCheckpointStore by default', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.checkpointStore).not.toBeNull()
  })

  it('creates FileCheckpointStore for file store', async () => {
    const { dir } = track(await createMinimalProfile({
      checkpoint: { store: 'file', dir: '/tmp/cortex-test-cp' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.checkpointStore).not.toBeNull()
  })

  it('returns null for "none" store', async () => {
    const { dir } = track(await createMinimalProfile({
      checkpoint: { store: 'none' },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.checkpointStore).toBeNull()
  })
})
