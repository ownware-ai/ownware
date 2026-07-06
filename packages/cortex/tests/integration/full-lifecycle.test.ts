/**
 * Integration tests: full profile lifecycle.
 *
 * Tests the complete flow from disk to Loom-ready config,
 * exercising multiple modules together.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, join } from 'path'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { ProfileRegistry } from '../../src/profile/registry.js'
import { ProfileSchema } from '../../src/profile/schema.js'
import { Session, systemPromptToText } from '@ownware/loom'
import { createTempProfile, createMinimalProfile, EXAMPLE_PROFILE_DIR } from '../helpers/fixtures.js'

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
// Load → Assemble → Session creation
// ---------------------------------------------------------------------------

describe('integration: load → assemble → Session', () => {
  it('creates a valid Loom Session from example profile', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const assembled = await assembleAgent(profile)

    // Create Loom Session — this validates that config + tools + provider are compatible
    const session = new Session({
      config: assembled.config,
      provider: assembled.provider,
      tools: assembled.tools,
      checkpoint: assembled.checkpointStore,
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBeDefined()
    expect(session.messageCount).toBe(0)
  })

  it('Session has correct tool count after deny filter', async () => {
    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: assembled.config,
      provider: assembled.provider,
      tools: assembled.tools,
    })

    // shell_execute should be denied
    expect(assembled.tools.find(t => t.name === 'shell_execute')).toBeUndefined()
    // But other coding tools should be present
    expect(assembled.tools.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Registry → Load → Assemble
// ---------------------------------------------------------------------------

describe('integration: registry → load → assemble', () => {
  it('discovers and assembles profiles', async () => {
    const registry = new ProfileRegistry()
    // The example profile is a test fixture (never shipped in
    // profiles/), so discovery runs over the fixtures root. Registry
    // ids key off the directory name: `example-profile`.
    await registry.discover(resolve(EXAMPLE_PROFILE_DIR, '..'))

    const profile = await registry.get('example-profile')
    const assembled = await assembleAgent(profile)

    expect(assembled.config.model).toBe('anthropic:claude-sonnet-4-20250514')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('Example Agent')
    expect(assembled.tools.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Programmatic config → Assemble
// ---------------------------------------------------------------------------

describe('integration: programmatic config', () => {
  it('registers and assembles a programmatic profile', async () => {
    const registry = new ProfileRegistry()
    const config = ProfileSchema.parse({
      name: 'programmatic-agent',
      description: 'Created in code',
      model: 'anthropic:claude-sonnet-4-20250514',
      systemPrompt: 'You are a programmatic agent.',
      tools: { preset: 'none' },
      context: { cwd: false, datetime: false },
    })

    registry.register('prog', config)
    const profile = await registry.get('prog')
    const assembled = await assembleAgent(profile)

    expect(systemPromptToText(assembled.systemPrompt)).toContain('programmatic agent')
    expect(assembled.tools).toHaveLength(0)
    expect(assembled.config.model).toBe('anthropic:claude-sonnet-4-20250514')
  })
})

// ---------------------------------------------------------------------------
// Multiple providers
// ---------------------------------------------------------------------------

describe('integration: multiple providers', () => {
  const providers = [
    { model: 'anthropic:claude-sonnet-4-20250514', expected: 'anthropic' },
    { model: 'openai:gpt-4o', expected: 'openai' },
    { model: 'google:gemini-2.0-flash', expected: 'google' },
  ]

  for (const { model, expected } of providers) {
    it(`resolves ${expected} provider`, async () => {
      const { dir } = track(await createMinimalProfile({ model }))
      const profile = await loadProfile(dir)
      const agent = await assembleAgent(profile)
      expect(agent.provider.name).toBe(expected)
    })
  }
})

// ---------------------------------------------------------------------------
// Compaction config mapping
// ---------------------------------------------------------------------------

describe('integration: compaction config fidelity', () => {
  const strategies = ['summarize', 'truncate', 'sliding_window', 'hierarchical'] as const

  for (const strategy of strategies) {
    it(`maps "${strategy}" strategy correctly`, async () => {
      const { dir } = track(await createMinimalProfile({
        compaction: { strategy },
      }))
      const profile = await loadProfile(dir)
      const agent = await assembleAgent(profile)
      expect(agent.config.compaction.strategy).toBe(strategy)
    })
  }

  it('maps fraction trigger', async () => {
    const { dir } = track(await createMinimalProfile({
      compaction: { trigger: { type: 'fraction', threshold: 0.75 } },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.compaction.trigger).toEqual({ type: 'fraction', threshold: 0.75 })
  })

  it('maps tokens trigger', async () => {
    const { dir } = track(await createMinimalProfile({
      compaction: { trigger: { type: 'tokens', threshold: 100000 } },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.compaction.trigger).toEqual({ type: 'tokens', threshold: 100000 })
  })

  it('maps disabled trigger', async () => {
    const { dir } = track(await createMinimalProfile({
      compaction: { trigger: { type: 'disabled' } },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.compaction.trigger.type).toBe('disabled')
  })

  it('maps messages retain', async () => {
    const { dir } = track(await createMinimalProfile({
      compaction: { retain: { type: 'messages', count: 10 } },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.compaction.retain).toEqual({ type: 'messages', count: 10 })
  })
})

// ---------------------------------------------------------------------------
// Context assembly fidelity
// ---------------------------------------------------------------------------

describe('integration: context assembly', () => {
  it('all context enabled produces rich prompt', async () => {
    const { dir } = track(await createMinimalProfile({
      context: {
        cwd: true,
        datetime: true,
        os: true,
        git: true,
        modelInfo: true,
      },
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(systemPromptToText(agent.systemPrompt)).toContain('Working directory:')
    expect(systemPromptToText(agent.systemPrompt)).toContain('Current date:')
    expect(systemPromptToText(agent.systemPrompt)).toContain('Platform:')
    expect(systemPromptToText(agent.systemPrompt)).toContain('Git branch:')
    expect(systemPromptToText(agent.systemPrompt)).toContain('Model:')
  })

  it('all context disabled produces minimal prompt', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'minimal',
        context: { cwd: false, datetime: false, git: false, os: false, project: false, modelInfo: false, contextUsage: false },
      }),
      'SOUL.md': '# Minimal',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    // Loom-level fragments (tool usage, safety, output) are always present.
    // The SOUL.md identity content should also be included.
    expect(systemPromptToText(agent.systemPrompt)).toContain('# Minimal')
    expect(systemPromptToText(agent.systemPrompt)).toContain('# Using your tools')
    expect(systemPromptToText(agent.systemPrompt)).toContain('# Executing actions with care')
  })
})

// ---------------------------------------------------------------------------
// YAML round-trip
// ---------------------------------------------------------------------------

describe('integration: YAML config', () => {
  it('loads and assembles a YAML profile', async () => {
    const { dir } = track(await createTempProfile({
      'agent.yaml': [
        'name: yaml-agent',
        'description: Configured via YAML',
        'model: anthropic:claude-sonnet-4-20250514',
        'tools:',
        '  preset: none',
        'context:',
        '  cwd: false',
        '  datetime: false',
      ].join('\n'),
      'SOUL.md': '# YAML Agent\n\nConfigured via YAML.',
    }))

    const profile = await loadProfile(dir)
    expect(profile.config.name).toBe('yaml-agent')

    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain('YAML Agent')
    expect(agent.tools).toHaveLength(0)
  })
})
