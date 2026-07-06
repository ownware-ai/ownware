/**
 * Unit Tests — `skill` builtin tool (skill dispatcher)
 */

import { describe, it, expect } from 'vitest'

import { createSkillTool } from '../skill.js'
import { SkillRegistry } from '../../../skills/registry.js'
import {
  ReminderInjector,
  ReminderRegistry,
  defineTemplate,
} from '../../../reminders/index.js'

import type { SkillDefinition } from '../../../skills/types.js'
import type { ToolContext } from '../../types.js'

function makeContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: {} as ToolContext['config'],
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

function makeSkill(over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'simplify',
    description: 'Walk recent changes and reduce duplication',
    trigger: 'simplify',
    content: 'Walk every changed file. Look for duplication. Refactor.',
    ...over,
  }
}

describe('createSkillTool', () => {
  it('returns the skill body as the tool result for a registered skill', async () => {
    const reg = new SkillRegistry().register(makeSkill())
    const tool = createSkillTool(reg)

    const result = await tool.execute({ name: 'simplify' }, makeContext())
    if ('then' in (result as object)) throw new Error('skill tool should be sync-resolvable')

    const r = await result
    expect(r.isError).toBe(false)
    expect(r.content).toContain('# Skill activated: simplify')
    expect(r.content).toContain('Walk every changed file. Look for duplication. Refactor.')
    expect(r.metadata?.skillName).toBe('simplify')
    expect(r.metadata?.skillDescription).toBe('Walk recent changes and reduce duplication')
  })

  it('appends a Caller args section when args are supplied', async () => {
    const reg = new SkillRegistry().register(makeSkill())
    const tool = createSkillTool(reg)

    const r = await tool.execute({ name: 'simplify', args: 'focus on src/payments/*' }, makeContext())
    expect(r.isError).toBe(false)
    expect(r.content).toContain('## Caller args')
    expect(r.content).toContain('focus on src/payments/*')
  })

  it('omits the Caller args section when args is empty or whitespace', async () => {
    const reg = new SkillRegistry().register(makeSkill())
    const tool = createSkillTool(reg)

    const r1 = await tool.execute({ name: 'simplify', args: '' }, makeContext())
    expect(r1.content).not.toContain('Caller args')
    const r2 = await tool.execute({ name: 'simplify', args: '   ' }, makeContext())
    expect(r2.content).not.toContain('Caller args')
  })

  it('returns isError:true with an available list for an unknown skill', async () => {
    const reg = new SkillRegistry()
      .register(makeSkill({ name: 'simplify' }))
      .register(makeSkill({ name: 'review', content: 'Review the PR.' }))
    const tool = createSkillTool(reg)

    const r = await tool.execute({ name: 'nope' }, makeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Unknown skill: "nope"')
    expect(r.content).toContain('Available skills: simplify, review')
  })

  it('reports "(none registered)" when registry is empty', async () => {
    const tool = createSkillTool(new SkillRegistry())
    const r = await tool.execute({ name: 'nope' }, makeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('(none registered)')
  })

  it('returns isError:true when the skill is registered but disabled', async () => {
    const reg = new SkillRegistry().register(makeSkill({ active: false }))
    const tool = createSkillTool(reg)

    const r = await tool.execute({ name: 'simplify' }, makeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('disabled')
  })

  it('omits a disabled skill from the available-list shown on unknown-skill error', async () => {
    const reg = new SkillRegistry()
      .register(makeSkill({ name: 'simplify' }))
      .register(makeSkill({ name: 'archive', active: false }))
    const tool = createSkillTool(reg)

    const r = await tool.execute({ name: 'nope' }, makeContext())
    expect(r.content).toContain('simplify')
    expect(r.content).not.toContain('archive')
  })

  it('emits a hook.context reminder when the optional injector is supplied', async () => {
    const remRegistry = new ReminderRegistry().register(
      defineTemplate({
        id: 'test.skill.context',
        eventType: 'hook.context',
        suppressible: true,
        render: (e) => `CTX ${e.hookName}: ${e.context}`,
      }),
    )
    const reminders = new ReminderInjector(remRegistry)

    const reg = new SkillRegistry().register(makeSkill())
    const tool = createSkillTool(reg, { reminders })

    await tool.execute({ name: 'simplify' }, makeContext())

    const fragments = reminders.drain({ turnIndex: 0 })
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toContain('CTX skill:simplify:')
    expect(fragments[0]).toContain('Walk recent changes')
  })

  it('does NOT emit a reminder when the skill is unknown or disabled', async () => {
    const remRegistry = new ReminderRegistry().register(
      defineTemplate({
        id: 'test.skill.context',
        eventType: 'hook.context',
        suppressible: true,
        render: (e) => `CTX ${e.hookName}`,
      }),
    )
    const reminders = new ReminderInjector(remRegistry)

    const reg = new SkillRegistry().register(makeSkill({ active: false }))
    const tool = createSkillTool(reg, { reminders })

    await tool.execute({ name: 'simplify' }, makeContext())  // disabled
    await tool.execute({ name: 'unknown' }, makeContext())   // missing

    expect(reminders.drain({ turnIndex: 0 })).toEqual([])
  })

  it('marks the tool as read-only and not requiring permission', () => {
    const tool = createSkillTool(new SkillRegistry())
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresPermission).toBe(false)
  })
})
