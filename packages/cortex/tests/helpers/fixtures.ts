/**
 * Test fixtures and factories for Cortex profile tests.
 *
 * Provides:
 * - Minimal and full profile configs
 * - Temporary profile directories on disk
 * - Mock tools conforming to the Loom Tool interface
 */

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Tool } from '@ownware/loom'

// ---------------------------------------------------------------------------
// Profile config fixtures (raw JSON objects before Zod parse)
// ---------------------------------------------------------------------------

/** Absolute minimum valid agent.json */
export const MINIMAL_CONFIG = {
  name: 'test-agent',
}

/** Full agent.json with all fields specified */
export const FULL_CONFIG = {
  name: 'full-agent',
  description: 'A fully configured test agent',
  version: '1.0.0',
  tags: ['test', 'full'],
  model: 'anthropic:claude-sonnet-4-6',
  temperature: 0.7,
  maxTokens: 8192,
  maxTurns: 50,
  tools: {
    preset: 'coding' as const,
    allow: ['filesystem.*'],
    deny: ['shell_execute'],
    custom: [],
    mcp: {},
  },
  systemPrompt: 'You are a test agent.',
  memory: {
    enabled: true,
    sources: ['AGENTS.md'],
    autoLearn: false,
    isolation: 'shared' as const,
  },
  skills: {
    dirs: ['skills/'],
    external: [],
  },
  context: {
    git: true,
    os: true,
    cwd: true,
    datetime: true,
    project: false,
    modelInfo: true,
    contextUsage: false,
  },
  workspace: {
    mode: 'cwd' as const,
    isolation: 'shared' as const,
    dirs: [],
  },
  security: {
    level: 'standard' as const,
    permissionMode: 'ask' as const,
    sandbox: { enabled: false, provider: 'local' as const },
  },
  execution: {
    mode: 'foreground' as const,
    timeout: '15m',
    maxCostUsd: 5.0,
  },
  subagents: [
    {
      name: 'helper',
      description: 'A helper subagent',
      profile: 'helper-profile',
    },
  ],
  compaction: {
    strategy: 'summarize' as const,
    trigger: { type: 'fraction' as const, threshold: 0.75 },
    retain: { type: 'messages' as const, count: 4 },
  },
  checkpoint: {
    store: 'memory' as const,
  },
  hooks: {
    onStart: [],
    onComplete: [{ action: 'log' as const, level: 'info' as const }],
    onError: [{ action: 'log' as const, level: 'error' as const }],
    onToolCall: [],
    onToolEnd: [],
  },
}

/** Config with invalid fields for negative testing */
export const INVALID_CONFIGS = {
  emptyName: { name: '' },
  longName: { name: 'x'.repeat(200) },
  badTemperature: { name: 'test', temperature: 5 },
  negativeTokens: { name: 'test', maxTokens: -100 },
  zeroTurns: { name: 'test', maxTurns: 0 },
  badPreset: { name: 'test', tools: { preset: 'invalid' } },
  badSecurityLevel: { name: 'test', security: { level: 'yolo' } },
  badPermissionMode: { name: 'test', security: { permissionMode: 'magic' } },
  badWorkspaceMode: { name: 'test', workspace: { mode: 'invalid' } },
  badExecutionMode: { name: 'test', execution: { mode: 'parallel' } },
  badCompactionStrategy: { name: 'test', compaction: { strategy: 'magic' } },
  badCheckpointStore: { name: 'test', checkpoint: { store: 'redis' } },
  badSandboxProvider: { name: 'test', security: { sandbox: { provider: 'lxc' } } },
  badHookAction: { name: 'test', hooks: { onStart: [{ action: 'fly' }] } },
}

// ---------------------------------------------------------------------------
// Temporary profile directories
// ---------------------------------------------------------------------------

export interface TempProfile {
  dir: string
  cleanup: () => Promise<void>
}

/**
 * Create a temporary profile directory with the given files.
 * Returns the path and a cleanup function.
 */
export async function createTempProfile(files: Record<string, string>): Promise<TempProfile> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-test-'))

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath)
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'))
    await mkdir(parentDir, { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/**
 * Create a minimal valid profile directory with agent.json + SOUL.md.
 */
export async function createMinimalProfile(
  configOverrides: Record<string, unknown> = {},
): Promise<TempProfile> {
  return createTempProfile({
    'agent.json': JSON.stringify({ name: 'test-agent', ...configOverrides }),
    'SOUL.md': '# Test Agent\n\nYou are a test agent.',
    'AGENTS.md': '# Memory\n\nTest memory.',
  })
}

/**
 * Create a profile with YAML config instead of JSON.
 */
export async function createYamlProfile(
  yamlContent: string,
): Promise<TempProfile> {
  return createTempProfile({
    'agent.yaml': yamlContent,
    'SOUL.md': '# YAML Agent\n\nYou are configured via YAML.',
  })
}

/**
 * Create a profile with skills directory.
 */
export async function createProfileWithSkills(): Promise<TempProfile> {
  return createTempProfile({
    'agent.json': JSON.stringify({ name: 'skill-agent' }),
    'SOUL.md': '# Skill Agent\n\nYou have skills.',
    'skills/commit.md': [
      '---',
      'name: commit',
      'description: Create a git commit',
      'trigger: /commit',
      '---',
      'Create a well-formatted git commit message.',
    ].join('\n'),
    'skills/review.md': [
      '---',
      'name: review',
      'description: Review a pull request',
      'trigger: /review',
      '---',
      'Review the PR for correctness and style.',
    ].join('\n'),
  })
}

/**
 * Profile with nested-folder skills: skills/<slug>/SKILL.md.
 * Mirrors the open-ecosystem (Anthropic Claude skills) layout.
 */
export async function createProfileWithNestedSkills(): Promise<TempProfile> {
  return createTempProfile({
    'agent.json': JSON.stringify({ name: 'nested-skill-agent' }),
    'SOUL.md': '# Nested Agent\n',
    'skills/competitive-research/SKILL.md': [
      '---',
      'name: competitive-research',
      'description: Run a structured competitor SWOT',
      '---',
      'Body of the skill.',
    ].join('\n'),
    'skills/tax-planning/SKILL.md': [
      '---',
      'name: tax-planning',
      'description: Year-end tax optimisation',
      '---',
      'Body.',
    ].join('\n'),
  })
}

/**
 * Profile with one active and one disabled nested skill — the disabled
 * one carries a `.disabled` marker file in its slug folder.
 */
export async function createProfileWithDisabledSkill(): Promise<TempProfile> {
  return createTempProfile({
    'agent.json': JSON.stringify({ name: 'mixed-active-skills-agent' }),
    'SOUL.md': '# Agent\n',
    'skills/active-one/SKILL.md':
      '---\nname: active-one\ndescription: yes\n---\nbody\n',
    'skills/disabled-one/SKILL.md':
      '---\nname: disabled-one\ndescription: no\n---\nbody\n',
    'skills/disabled-one/.disabled': '',
  })
}

/**
 * Create a profile with MCP server config that references env vars.
 */
export async function createProfileWithMCP(
  envVarName: string,
): Promise<TempProfile> {
  return createTempProfile({
    'agent.json': JSON.stringify({
      name: 'mcp-agent',
      tools: {
        mcp: {
          'test-server': {
            transport: 'stdio',
            command: 'npx',
            args: ['test-mcp-server'],
            env: {
              API_KEY: `\${${envVarName}}`,
            },
          },
        },
      },
    }),
    'SOUL.md': '# MCP Agent',
  })
}

// ---------------------------------------------------------------------------
// Mock tools
// ---------------------------------------------------------------------------

export function createMockTool(name: string, opts: { isReadOnly?: boolean } = {}): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: opts.isReadOnly ?? false,
    async execute() {
      return { content: `${name} executed`, isError: false }
    },
  }
}

export function createMockTools(names: string[]): Tool[] {
  return names.map(n => createMockTool(n))
}

// ---------------------------------------------------------------------------
// Example profile path
// ---------------------------------------------------------------------------

/**
 * Path to a deterministic test-fixture profile used by `assembler.test.ts`
 * and any other suite that wants a stable, fully-formed profile to load.
 *
 * Lives under `tests/fixtures/` — NOT alongside `packages/cortex/profiles/`
 * — because that directory is the production builtin bundle (see
 * `ownware-bundle.ts` + `BUILTINS.json`), and any profile dropped there
 * is auto-loaded into the user's profile lobby. Test fixtures must not
 * leak into the shipping product.
 */
export const EXAMPLE_PROFILE_DIR = join(import.meta.dirname, '../fixtures/example-profile')
export const PROFILES_ROOT = join(import.meta.dirname, '../../profiles')
