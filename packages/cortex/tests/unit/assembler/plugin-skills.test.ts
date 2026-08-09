import { afterEach, describe, expect, it } from 'vitest'
import type { Tool, ToolContext, ToolResult } from '@ownware/loom'
import { systemPromptToText } from '@ownware/loom'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { subagentToolPool } from '../../../src/gateway/handlers/run.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

describe('agent plugin skill assembly', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn()
  })

  it('gives a real assembled agent a lazy dispatcher and invokes the selected body', async () => {
    const fixture = await createMinimalProfile({ tools: { preset: 'coding' } })
    cleanup.push(fixture.cleanup)
    const profile = await loadProfile(fixture.dir)
    const assembled = await assembleAgent(profile, {
      additionalSkills: [{
        name: 'create-document',
        description: 'Plan, draft, and verify a structured document.',
        trigger: '/create-document',
        content: 'First clarify the audience. Then draft and verify the saved artifact.',
      }],
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain('/create-document')
    const tool = assembled.tools.find(candidate => candidate.name === 'skill')
    expect(tool).toBeDefined()
    const result = await tool!.execute(
      { name: 'create-document', args: 'project brief' },
      {} as ToolContext,
    ) as ToolResult
    expect(result).toMatchObject({
      isError: false,
      content: expect.stringContaining('verify the saved artifact'),
      metadata: { skillName: 'create-document' },
    })
    expect(result.content).toContain('project brief')
  })

  it('lets the agent tool deny policy remove the dispatcher', async () => {
    const fixture = await createMinimalProfile({
      tools: { preset: 'coding', deny: ['skill'] },
    })
    cleanup.push(fixture.cleanup)
    const profile = await loadProfile(fixture.dir)
    const assembled = await assembleAgent(profile, {
      additionalSkills: [{
        name: 'create-document',
        description: 'Create a document.',
        trigger: '/create-document',
        content: 'Create it.',
      }],
    })
    expect(assembled.tools.some(tool => tool.name === 'skill')).toBe(false)
  })

  it('fails loudly when an agent enables more than the bounded task catalog', async () => {
    const fixture = await createMinimalProfile({ tools: { preset: 'coding' } })
    cleanup.push(fixture.cleanup)
    const profile = await loadProfile(fixture.dir)
    const additionalSkills = Array.from({ length: 129 }, (_, index) => ({
      name: `task-${index}`,
      description: `Task ${index}.`,
      trigger: `/task-${index}`,
      content: `Perform task ${index}.`,
    }))
    await expect(assembleAgent(profile, { additionalSkills }))
      .rejects.toThrow('An agent may enable at most 128 skills.')
  })

  it('does not leak the root lazy skill registry into spawned helpers', () => {
    const rootTools = [
      { name: 'readFile' },
      { name: 'skill' },
      { name: 'writeFile' },
    ] as unknown as Tool[]
    expect(subagentToolPool(rootTools).map(tool => tool.name)).toEqual([
      'readFile',
      'writeFile',
    ])
  })
})
