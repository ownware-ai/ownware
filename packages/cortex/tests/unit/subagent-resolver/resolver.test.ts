/**
 * Unit tests for resolveSubagentDef — grant semantics + validation.
 */

import { describe, it, expect } from 'vitest'
import { resolveSubagentDef } from '../../../src/profile/subagent-resolver.js'
import type { ResolveSubagentInputs } from '../../../src/profile/subagent-resolver.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import type { SubagentSpec } from '../../../src/profile/schema.js'
import { ProfileSchema } from '../../../src/profile/schema.js'
import type { SkillDefinition } from '@ownware/loom'

// Test-local wrapper that defaults parentSkills to empty when a given
// case is not exercising skill grants. Keeps every existing assertion
// sharp without forcing every caller to spell out an empty array.
function callResolver(
  inputs: Omit<ResolveSubagentInputs, 'parentSkills'> & {
    parentSkills?: readonly SkillDefinition[]
  },
) {
  return resolveSubagentDef({
    parentSkills: inputs.parentSkills ?? [],
    spec: inputs.spec,
    refProfile: inputs.refProfile,
    parentToolNames: inputs.parentToolNames,
  })
}

function makeSpec(overrides: Partial<SubagentSpec> & { name: string; description: string }): SubagentSpec {
  const { name, description, ...rest } = overrides
  return { name, description, ...rest }
}

function makeRefProfile(overrides: {
  name?: string
  model?: string
  soulMd?: string
  systemPrompt?: string
  allow?: string[]
  maxTurns?: number
}): LoadedProfile {
  const config = ProfileSchema.parse({
    name: overrides.name ?? 'helper',
    model: overrides.model ?? 'anthropic:claude-haiku-4-5-20251001',
    systemPrompt: overrides.systemPrompt,
    maxTurns: overrides.maxTurns ?? 50,
    tools: {
      preset: 'none',
      allow: overrides.allow ?? [],
    },
  })
  return {
    config,
    basePath: '/tmp/helper',
    soulMd: overrides.soulMd,
    agentsMd: undefined,
    skills: [],
  }
}

describe('resolveSubagentDef: no grant (legacy behaviour)', () => {
  it('returns undefined tools when neither parent nor helper constrain', () => {
    const r = callResolver({
      spec: makeSpec({ name: 'h', description: 'd', profile: 'helper' }),
      refProfile: makeRefProfile({}),
      parentToolNames: new Set(['readFile', 'writeFile']),
    })
    expect(r.tools).toBeUndefined()
  })

  it('parent inline allow wins over helper allow', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
        tools: { preset: 'coding', allow: ['readFile'], deny: [] },
      }),
      refProfile: makeRefProfile({ allow: ['writeFile', 'glob'] }),
      parentToolNames: new Set(['readFile', 'writeFile', 'glob']),
    })
    expect(r.tools).toEqual(['readFile'])
  })

  it('falls back to helper allow when parent provides none', () => {
    const r = callResolver({
      spec: makeSpec({ name: 'h', description: 'd', profile: 'helper' }),
      refProfile: makeRefProfile({ allow: ['writeFile', 'glob'] }),
      parentToolNames: new Set(['readFile', 'writeFile', 'glob']),
    })
    expect(r.tools).toEqual(['writeFile', 'glob'])
  })
})

describe('resolveSubagentDef: grant', () => {
  it('grant becomes the allow list when neither parent nor helper constrain', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'composer',
        description: 'd',
        profile: 'helper',
        grant: { tools: ['concat_text'] },
      }),
      refProfile: makeRefProfile({}),
      parentToolNames: new Set(['concat_text', 'readFile']),
    })
    expect(r.tools).toEqual(['concat_text'])
  })

  it('grant unions with helper allow (dedup preserves order)', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'composer',
        description: 'd',
        profile: 'helper',
        grant: { tools: ['concat_text', 'readFile'] },
      }),
      refProfile: makeRefProfile({ allow: ['readFile', 'glob'] }),
      parentToolNames: new Set(['concat_text', 'readFile', 'glob']),
    })
    expect(r.tools).toEqual(['readFile', 'glob', 'concat_text'])
  })

  it('grant unions with parent inline allow', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'composer',
        description: 'd',
        profile: 'helper',
        tools: { preset: 'coding', allow: ['readFile'], deny: [] },
        grant: { tools: ['concat_text'] },
      }),
      refProfile: makeRefProfile({ allow: ['ignored'] }),
      parentToolNames: new Set(['concat_text', 'readFile']),
    })
    expect(r.tools).toEqual(['readFile', 'concat_text'])
  })

  it('throws when grant references a tool the parent does not own', () => {
    expect(() =>
      callResolver({
        spec: makeSpec({
          name: 'composer',
          description: 'd',
          profile: 'helper',
          grant: { tools: ['mystery_tool'] },
        }),
        refProfile: makeRefProfile({}),
        parentToolNames: new Set(['concat_text']),
      }),
    ).toThrow(/grants tool \["mystery_tool"\].*does not own/)
  })

  it('lists every missing tool in a single error', () => {
    expect(() =>
      callResolver({
        spec: makeSpec({
          name: 'composer',
          description: 'd',
          profile: 'helper',
          grant: { tools: ['a', 'b', 'c'] },
        }),
        refProfile: makeRefProfile({}),
        parentToolNames: new Set(['a']),
      }),
    ).toThrow(/"b", "c"/)
  })
})

describe('resolveSubagentDef: identity fields', () => {
  it('uses helper soulMd as systemPrompt default', () => {
    const r = callResolver({
      spec: makeSpec({ name: 'h', description: 'd', profile: 'helper' }),
      refProfile: makeRefProfile({ soulMd: '# I am the helper' }),
      parentToolNames: new Set(),
    })
    expect(r.systemPrompt).toBe('# I am the helper')
  })

  it('parent inline systemPrompt wins over helper soulMd', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
        systemPrompt: 'override',
      }),
      refProfile: makeRefProfile({ soulMd: '# I am the helper' }),
      parentToolNames: new Set(),
    })
    expect(r.systemPrompt).toBe('override')
  })

  it('inherits helper model + maxTurns when parent provides neither', () => {
    const r = callResolver({
      spec: makeSpec({ name: 'h', description: 'd', profile: 'helper' }),
      refProfile: makeRefProfile({
        model: 'anthropic:claude-haiku-4-5-20251001',
        maxTurns: 25,
      }),
      parentToolNames: new Set(),
    })
    expect(r.model).toBe('anthropic:claude-haiku-4-5-20251001')
    expect(r.maxTurns).toBe(25)
  })
})

describe('resolveSubagentDef: reference validation', () => {
  it('throws when spec.profile is set but refProfile is null', () => {
    expect(() =>
      callResolver({
        spec: makeSpec({ name: 'h', description: 'd', profile: 'missing' }),
        refProfile: null,
        parentToolNames: new Set(),
      }),
    ).toThrow(/references profile "missing" which is not registered/)
  })

  it('works for inline specs (no profile reference)', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'inline-agent',
        description: 'd',
        model: 'anthropic:claude-haiku-4-5-20251001',
        systemPrompt: 'inline prompt',
      }),
      refProfile: null,
      parentToolNames: new Set(),
    })
    expect(r.model).toBe('anthropic:claude-haiku-4-5-20251001')
    expect(r.systemPrompt).toBe('inline prompt')
    expect(r.tools).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Skill grants
// ---------------------------------------------------------------------------

function makeSkill(
  name: string,
  description: string,
  content: string,
): SkillDefinition {
  return { name, description, trigger: `/${name}`, content }
}

describe('resolveSubagentDef: grant.skills', () => {
  it('no grant.skills → systemPrompt unchanged from baseline', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
      }),
      refProfile: makeRefProfile({ soulMd: 'helper soul' }),
      parentToolNames: new Set(),
      parentSkills: [makeSkill('sqli', 'SQL injection playbook', 'Step 1: check inputs')],
    })
    expect(r.systemPrompt).toBe('helper soul')
  })

  it('grant.skills inlines full skill content into systemPrompt', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
        grant: { tools: [], skills: ['sqli'] },
      }),
      refProfile: makeRefProfile({ soulMd: 'HELPER_BASE' }),
      parentToolNames: new Set(),
      parentSkills: [
        makeSkill('sqli', 'SQL injection playbook', 'Step A: inspect queries.'),
      ],
    })
    expect(r.systemPrompt).toContain('HELPER_BASE')
    expect(r.systemPrompt).toContain('# Granted Skills')
    expect(r.systemPrompt).toContain('## Granted Skill: /sqli')
    expect(r.systemPrompt).toContain('SQL injection playbook')
    expect(r.systemPrompt).toContain('Step A: inspect queries.')
  })

  it('granted skills appear in the order they are listed', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
        grant: { tools: [], skills: ['xss', 'sqli'] },
      }),
      refProfile: makeRefProfile({ soulMd: 'base' }),
      parentToolNames: new Set(),
      parentSkills: [
        makeSkill('sqli', 'SQL playbook', 'sql-content'),
        makeSkill('xss', 'XSS playbook', 'xss-content'),
      ],
    })
    const xssIdx = r.systemPrompt!.indexOf('/xss')
    const sqlIdx = r.systemPrompt!.indexOf('/sqli')
    expect(xssIdx).toBeGreaterThan(-1)
    expect(sqlIdx).toBeGreaterThan(-1)
    expect(xssIdx).toBeLessThan(sqlIdx)
  })

  it('throws when a granted skill is not in parentSkills', () => {
    expect(() =>
      callResolver({
        spec: makeSpec({
          name: 'h',
          description: 'd',
          profile: 'helper',
          grant: { tools: [], skills: ['mystery'] },
        }),
        refProfile: makeRefProfile({}),
        parentToolNames: new Set(),
        parentSkills: [makeSkill('sqli', 'd', 'c')],
      }),
    ).toThrow(/grants skill \["mystery"\].*does not own/)
  })

  it('lists every missing skill in a single error', () => {
    expect(() =>
      callResolver({
        spec: makeSpec({
          name: 'h',
          description: 'd',
          profile: 'helper',
          grant: { tools: [], skills: ['a', 'b', 'c'] },
        }),
        refProfile: makeRefProfile({}),
        parentToolNames: new Set(),
        parentSkills: [makeSkill('a', 'desc', 'content')],
      }),
    ).toThrow(/"b", "c"/)
  })

  it('appends granted skills when there is no base systemPrompt', () => {
    const r = callResolver({
      spec: makeSpec({
        name: 'h',
        description: 'd',
        profile: 'helper',
        grant: { tools: [], skills: ['sqli'] },
      }),
      refProfile: makeRefProfile({}),
      parentToolNames: new Set(),
      parentSkills: [makeSkill('sqli', 'SQL', 'body')],
    })
    expect(r.systemPrompt).toMatch(/^# Granted Skills/)
    expect(r.systemPrompt).toContain('body')
  })
})
