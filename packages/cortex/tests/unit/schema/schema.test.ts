/**
 * Unit tests for ProfileSchema (Zod validation).
 *
 * Tests every field, default, constraint, and error path.
 */

import { describe, it, expect } from 'vitest'
import { ProfileSchema, HookSchema, MCPServerSchema } from '../../../src/profile/schema.js'
import { MINIMAL_CONFIG, FULL_CONFIG, INVALID_CONFIGS } from '../../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// Minimal config
// ---------------------------------------------------------------------------

describe('ProfileSchema: minimal config', () => {
  it('accepts name-only config', () => {
    const result = ProfileSchema.safeParse(MINIMAL_CONFIG)
    expect(result.success).toBe(true)
  })

  it('fills all defaults for minimal config', () => {
    const result = ProfileSchema.parse(MINIMAL_CONFIG)

    expect(result.name).toBe('test-agent')
    expect(result.version).toBe('0.1.0')
    expect(result.tags).toEqual([])
    expect(result.productId).toBe('ownware')
    expect(result.model).toBe('openai:gpt-5.5')
    expect(result.temperature).toBeUndefined()
    expect(result.maxTokens).toBe(16384)
    expect(result.maxTurns).toBe(100)

    // Tools
    expect(result.tools.preset).toBe('full')
    expect(result.tools.allow).toEqual([])
    expect(result.tools.deny).toEqual([])
    expect(result.tools.custom).toEqual([])
    expect(result.tools.mcp).toEqual({})

    // Memory
    expect(result.memory.enabled).toBe(true)
    expect(result.memory.sources).toEqual(['AGENTS.md'])
    expect(result.memory.autoLearn).toBe(true)
    expect(result.memory.isolation).toBe('shared')

    // Skills
    expect(result.skills.dirs).toEqual(['skills/'])
    expect(result.skills.external).toEqual([])

    // Context
    expect(result.context.cwd).toBe(true)
    expect(result.context.datetime).toBe(true)
    expect(result.context.git).toBe(false)
    expect(result.context.os).toBe(false)
    expect(result.context.project).toBe(false)
    expect(result.context.modelInfo).toBe(false)
    expect(result.context.contextUsage).toBe(false)

    // Workspace
    expect(result.workspace.mode).toBe('cwd')
    expect(result.workspace.isolation).toBe('shared')
    expect(result.workspace.dirs).toEqual([])

    // Security
    expect(result.security.level).toBe('standard')
    expect(result.security.permissionMode).toBe('ask')
    expect(result.security.sandbox.enabled).toBe(false)
    expect(result.security.sandbox.provider).toBe('local')

    // Execution
    expect(result.execution.mode).toBe('foreground')
    expect(result.execution.timeout).toBe('30m')
    expect(result.execution.maxCostUsd).toBeUndefined()

    // Subagents
    expect(result.subagents).toEqual([])

    // Compaction
    expect(result.compaction.strategy).toBe('summarize')
    expect(result.compaction.trigger.type).toBe('fraction')
    expect(result.compaction.trigger.threshold).toBe(0.80)
    expect(result.compaction.retain.type).toBe('messages')
    expect(result.compaction.retain.count).toBe(6)
    expect(result.compaction.summaryModel).toBeUndefined()

    // Checkpoint
    expect(result.checkpoint.store).toBe('memory')
    expect(result.checkpoint.connectionString).toBeUndefined()
    expect(result.checkpoint.dir).toBeUndefined()

    // Hooks
    expect(result.hooks.onStart).toEqual([])
    expect(result.hooks.onComplete).toEqual([])
    expect(result.hooks.onError).toEqual([])
    expect(result.hooks.onToolCall).toEqual([])
    expect(result.hooks.onToolEnd).toEqual([])

    // Thinking — off by default, budget 10000
    expect(result.thinking.enabled).toBe(false)
    expect(result.thinking.budgetTokens).toBe(10000)
  })
})

// ---------------------------------------------------------------------------
// productId
// ---------------------------------------------------------------------------

describe('ProfileSchema: productId', () => {
  it('defaults productId to "ownware" when omitted', () => {
    const result = ProfileSchema.parse({ name: 'no-product' })
    expect(result.productId).toBe('ownware')
  })

  it('accepts an explicit ownware-design productId', () => {
    const result = ProfileSchema.parse({
      name: 'designer',
      productId: 'ownware-design',
    })
    expect(result.productId).toBe('ownware-design')
  })

  it('accepts an explicit ownware-marketing productId', () => {
    const result = ProfileSchema.parse({
      name: 'marketer',
      productId: 'ownware-marketing',
    })
    expect(result.productId).toBe('ownware-marketing')
  })

  it('rejects uppercase productId', () => {
    const result = ProfileSchema.safeParse({
      name: 'bad-product',
      productId: 'Ownware-Design',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty productId', () => {
    const result = ProfileSchema.safeParse({
      name: 'bad-product',
      productId: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects productId containing underscore', () => {
    const result = ProfileSchema.safeParse({
      name: 'bad-product',
      productId: 'ownware_design',
    })
    expect(result.success).toBe(false)
  })

  it('rejects productId starting with a digit', () => {
    const result = ProfileSchema.safeParse({
      name: 'bad-product',
      productId: '2ownware',
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// locked (vertical lock — hidden from the general library, not editable)
// ---------------------------------------------------------------------------

describe('ProfileSchema: locked', () => {
  it('defaults locked to false when omitted', () => {
    const result = ProfileSchema.parse({ name: 'no-lock' })
    expect(result.locked).toBe(false)
  })

  it('accepts locked: true', () => {
    const result = ProfileSchema.parse({ name: 'vertical', locked: true })
    expect(result.locked).toBe(true)
  })

  it('rejects a non-boolean locked', () => {
    const result = ProfileSchema.safeParse({ name: 'bad-lock', locked: 'yes' })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

describe('ProfileSchema: thinking', () => {
  it('accepts enabled thinking with a custom budget', () => {
    const result = ProfileSchema.parse({
      name: 'thinker',
      thinking: { enabled: true, budgetTokens: 8192 },
    })
    expect(result.thinking.enabled).toBe(true)
    expect(result.thinking.budgetTokens).toBe(8192)
  })

  it('rejects budgetTokens below the 1024 floor', () => {
    const result = ProfileSchema.safeParse({
      name: 'bad-thinker',
      thinking: { enabled: true, budgetTokens: 512 },
    })
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full config
// ---------------------------------------------------------------------------

describe('ProfileSchema: full config', () => {
  it('accepts a fully specified config', () => {
    const result = ProfileSchema.safeParse(FULL_CONFIG)
    expect(result.success).toBe(true)
  })

  it('preserves all explicit values', () => {
    const result = ProfileSchema.parse(FULL_CONFIG)

    expect(result.name).toBe('full-agent')
    expect(result.description).toBe('A fully configured test agent')
    expect(result.version).toBe('1.0.0')
    expect(result.tags).toEqual(['test', 'full'])
    expect(result.model).toBe('anthropic:claude-sonnet-4-6')
    expect(result.temperature).toBe(0.7)
    expect(result.maxTokens).toBe(8192)
    expect(result.maxTurns).toBe(50)
    expect(result.tools.preset).toBe('coding')
    expect(result.tools.deny).toEqual(['shell_execute'])
    expect(result.execution.maxCostUsd).toBe(5.0)
    expect(result.compaction.trigger.threshold).toBe(0.75)
    expect(result.hooks.onComplete).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

describe('ProfileSchema: name constraints', () => {
  it('rejects missing name', () => {
    expect(ProfileSchema.safeParse({}).success).toBe(false)
  })

  it('rejects empty string name', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.emptyName).success).toBe(false)
  })

  it('rejects name over 128 chars', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.longName).success).toBe(false)
  })

  it('accepts 128-char name', () => {
    expect(ProfileSchema.safeParse({ name: 'x'.repeat(128) }).success).toBe(true)
  })

  it('accepts single-char name', () => {
    expect(ProfileSchema.safeParse({ name: 'a' }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model/temperature/tokens constraints
// ---------------------------------------------------------------------------

describe('ProfileSchema: model constraints', () => {
  it('rejects temperature above 2', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badTemperature).success).toBe(false)
  })

  it('rejects temperature below 0', () => {
    expect(ProfileSchema.safeParse({ name: 'x', temperature: -0.1 }).success).toBe(false)
  })

  it('accepts temperature at boundaries', () => {
    expect(ProfileSchema.safeParse({ name: 'x', temperature: 0 }).success).toBe(true)
    expect(ProfileSchema.safeParse({ name: 'x', temperature: 2 }).success).toBe(true)
  })

  it('rejects negative maxTokens', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.negativeTokens).success).toBe(false)
  })

  it('rejects zero maxTurns', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.zeroTurns).success).toBe(false)
  })

  it('accepts maxTurns of 1', () => {
    expect(ProfileSchema.safeParse({ name: 'x', maxTurns: 1 }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Enum validation
// ---------------------------------------------------------------------------

describe('ProfileSchema: enum fields', () => {
  it('rejects invalid tool preset', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badPreset).success).toBe(false)
  })

  it('accepts all valid tool presets', () => {
    for (const preset of ['full', 'coding', 'readonly', 'none']) {
      const r = ProfileSchema.safeParse({ name: 'x', tools: { preset } })
      expect(r.success).toBe(true)
    }
  })

  it('rejects invalid security level', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badSecurityLevel).success).toBe(false)
  })

  it('rejects invalid permission mode', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badPermissionMode).success).toBe(false)
  })

  it('rejects invalid workspace mode', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badWorkspaceMode).success).toBe(false)
  })

  it('rejects invalid execution mode', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badExecutionMode).success).toBe(false)
  })

  it('rejects invalid compaction strategy', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badCompactionStrategy).success).toBe(false)
  })

  it('rejects invalid checkpoint store', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badCheckpointStore).success).toBe(false)
  })

  it('rejects invalid sandbox provider', () => {
    expect(ProfileSchema.safeParse(INVALID_CONFIGS.badSandboxProvider).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hook schema
// ---------------------------------------------------------------------------

describe('HookSchema', () => {
  it('accepts log hook', () => {
    expect(HookSchema.safeParse({ action: 'log' }).success).toBe(true)
  })

  it('accepts webhook hook', () => {
    expect(HookSchema.safeParse({ action: 'webhook', url: 'https://example.com' }).success).toBe(true)
  })

  it('accepts command hook', () => {
    expect(HookSchema.safeParse({ action: 'command', command: 'echo hi' }).success).toBe(true)
  })

  it('accepts save_json hook', () => {
    expect(HookSchema.safeParse({ action: 'save_json', path: 'runs/' }).success).toBe(true)
  })

  it('rejects invalid action', () => {
    expect(HookSchema.safeParse({ action: 'fly' }).success).toBe(false)
  })

  it('defaults level to info', () => {
    const hook = HookSchema.parse({ action: 'log' })
    expect(hook.level).toBe('info')
  })
})

// ---------------------------------------------------------------------------
// MCP server schema
// ---------------------------------------------------------------------------

describe('MCPServerSchema', () => {
  it('accepts stdio transport', () => {
    const r = MCPServerSchema.safeParse({
      transport: 'stdio',
      command: 'npx',
      args: ['mcp-server'],
    })
    expect(r.success).toBe(true)
  })

  it('accepts sse transport', () => {
    const r = MCPServerSchema.safeParse({
      transport: 'sse',
      url: 'https://example.com/sse',
    })
    expect(r.success).toBe(true)
  })

  it('accepts streamable_http transport', () => {
    const r = MCPServerSchema.safeParse({
      transport: 'streamable_http',
      url: 'https://example.com/api',
    })
    expect(r.success).toBe(true)
  })

  it('accepts websocket transport', () => {
    const r = MCPServerSchema.safeParse({
      transport: 'websocket',
      url: 'ws://localhost:8080',
    })
    expect(r.success).toBe(true)
  })

  it('rejects invalid transport', () => {
    const r = MCPServerSchema.safeParse({ transport: 'grpc' })
    expect(r.success).toBe(false)
  })

  it('defaults env to empty object', () => {
    const config = MCPServerSchema.parse({ transport: 'stdio', command: 'test' })
    expect(config.env).toEqual({})
  })

  it('defaults args to empty array', () => {
    const config = MCPServerSchema.parse({ transport: 'stdio', command: 'test' })
    expect(config.args).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Subagent schema
// ---------------------------------------------------------------------------

describe('ProfileSchema: subagents', () => {
  it('accepts valid subagent array', () => {
    const result = ProfileSchema.safeParse({
      name: 'orchestrator',
      subagents: [
        { name: 'worker', description: 'Does work', profile: 'worker-profile' },
        { name: 'reviewer', description: 'Reviews work', model: 'anthropic:claude-haiku-4-5-20251001' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.subagents).toHaveLength(2)
    }
  })

  it('requires name and description on subagents', () => {
    const result = ProfileSchema.safeParse({
      name: 'test',
      subagents: [{ profile: 'worker' }],
    })
    expect(result.success).toBe(false)
  })

  it('allows subagent tools override', () => {
    const result = ProfileSchema.safeParse({
      name: 'test',
      subagents: [{
        name: 'worker',
        description: 'Worker',
        tools: { preset: 'readonly', deny: ['shell_execute'] },
      }],
    })
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('ProfileSchema: edge cases', () => {
  it('accepts custom tool entries', () => {
    const result = ProfileSchema.safeParse({
      name: 'test',
      tools: {
        custom: [
          { path: 'tools/search.ts', functions: ['webSearch'] },
          { path: 'tools/other.ts' },
        ],
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools.custom).toHaveLength(2)
      expect(result.data.tools.custom[0]!.functions).toEqual(['webSearch'])
      expect(result.data.tools.custom[1]!.functions).toBeUndefined()
    }
  })

  it('accepts all memory isolation modes', () => {
    for (const isolation of ['shared', 'per_session', 'per_thread']) {
      const r = ProfileSchema.safeParse({ name: 'x', memory: { isolation } })
      expect(r.success).toBe(true)
    }
  })

  it('accepts all compaction trigger types', () => {
    for (const type of ['tokens', 'fraction', 'messages', 'disabled']) {
      const r = ProfileSchema.safeParse({
        name: 'x',
        compaction: { trigger: { type } },
      })
      expect(r.success).toBe(true)
    }
  })

  it('strips unknown fields', () => {
    const result = ProfileSchema.safeParse({
      name: 'test',
      unknownField: 'should be stripped',
    })
    // Zod strips unknown fields by default
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Browser (managed Chrome lifecycle)
// ---------------------------------------------------------------------------

describe('ProfileSchema: browser', () => {
  it('defaults to autoLaunch: "auto" when omitted', () => {
    // "auto" means: launch Chrome only when the assembled tool set
    // actually contains a browser_* tool. Zero cost for profiles that
    // never browse; zero boilerplate for profiles that do.
    const result = ProfileSchema.parse({ name: 'x' })
    expect(result.browser.autoLaunch).toBe('auto')
    expect(result.browser.headless).toBe(false)
    expect(result.browser.noSandbox).toBe(false)
    expect(result.browser.extraArgs).toEqual([])
    expect(result.browser.readyTimeoutMs).toBe(15_000)
    expect(result.browser.port).toBeUndefined()
    expect(result.browser.userDataDir).toBeUndefined()
  })

  it('accepts an explicit true override', () => {
    const result = ProfileSchema.safeParse({
      name: 'x',
      browser: { autoLaunch: true },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.browser.autoLaunch).toBe(true)
    }
  })

  it('accepts an explicit false opt-out', () => {
    const result = ProfileSchema.safeParse({
      name: 'x',
      browser: { autoLaunch: false },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.browser.autoLaunch).toBe(false)
    }
  })

  it('rejects autoLaunch values other than boolean or "auto"', () => {
    expect(
      ProfileSchema.safeParse({
        name: 'x',
        browser: { autoLaunch: 'maybe' },
      }).success,
    ).toBe(false)
    expect(
      ProfileSchema.safeParse({
        name: 'x',
        browser: { autoLaunch: 1 },
      }).success,
    ).toBe(false)
  })

  it('accepts a fully populated browser block', () => {
    const result = ProfileSchema.safeParse({
      name: 'x',
      browser: {
        autoLaunch: true,
        headless: true,
        port: 9333,
        userDataDir: '/tmp/my-profile',
        noSandbox: true,
        extraArgs: ['--mute-audio'],
        readyTimeoutMs: 30_000,
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.browser).toMatchObject({
        autoLaunch: true,
        headless: true,
        port: 9333,
        userDataDir: '/tmp/my-profile',
        noSandbox: true,
        extraArgs: ['--mute-audio'],
        readyTimeoutMs: 30_000,
      })
    }
  })

  it('rejects a port outside 1..65535', () => {
    expect(
      ProfileSchema.safeParse({ name: 'x', browser: { port: 0 } }).success,
    ).toBe(false)
    expect(
      ProfileSchema.safeParse({ name: 'x', browser: { port: 70_000 } }).success,
    ).toBe(false)
  })

  it('rejects a readyTimeoutMs below the safe floor', () => {
    // 500ms floor — below that Chrome cannot reliably come up.
    expect(
      ProfileSchema.safeParse({
        name: 'x',
        browser: { readyTimeoutMs: 100 },
      }).success,
    ).toBe(false)
  })

  it('rejects a readyTimeoutMs above the two-minute ceiling', () => {
    expect(
      ProfileSchema.safeParse({
        name: 'x',
        browser: { readyTimeoutMs: 5 * 60 * 1000 },
      }).success,
    ).toBe(false)
  })

  it('rejects an empty userDataDir string', () => {
    // Empty string would collide with the default-temp-dir branch and
    // silently behave differently from omitting the field — make it loud.
    expect(
      ProfileSchema.safeParse({
        name: 'x',
        browser: { userDataDir: '' },
      }).success,
    ).toBe(false)
  })
})
