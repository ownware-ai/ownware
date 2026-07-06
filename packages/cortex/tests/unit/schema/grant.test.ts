/**
 * Tests for the `grant` block on SubagentSpecSchema.
 */

import { describe, it, expect } from 'vitest'
import {
  ProfileSchema,
  SubagentGrantSchema,
  SubagentSpecSchema,
} from '../../../src/profile/schema.js'

describe('SubagentGrantSchema', () => {
  it('fills defaults when nothing is supplied', () => {
    const parsed = SubagentGrantSchema.parse({})
    expect(parsed).toEqual({ tools: [], skills: [] })
  })

  it('accepts a list of skill names', () => {
    const parsed = SubagentGrantSchema.parse({ skills: ['sqli', 'xss'] })
    expect(parsed.skills).toEqual(['sqli', 'xss'])
    expect(parsed.tools).toEqual([])
  })

  it('accepts a list of tool names', () => {
    const parsed = SubagentGrantSchema.parse({ tools: ['a', 'b'] })
    expect(parsed.tools).toEqual(['a', 'b'])
  })

  it('rejects non-string members', () => {
    const result = SubagentGrantSchema.safeParse({ tools: [1, 2] })
    expect(result.success).toBe(false)
  })
})

describe('SubagentSpecSchema: grant', () => {
  it('grant is optional and defaults to undefined', () => {
    const parsed = SubagentSpecSchema.parse({
      name: 'explorer',
      description: 'Explores',
    })
    expect(parsed.grant).toBeUndefined()
  })

  it('accepts a spec with an explicit grant', () => {
    const parsed = SubagentSpecSchema.parse({
      name: 'composer',
      description: 'Combines text',
      profile: 'helper-text',
      grant: { tools: ['concat_text'] },
    })
    expect(parsed.grant).toEqual({ tools: ['concat_text'], skills: [] })
  })
})

describe('ProfileSchema: subagents with grant', () => {
  it('parses a parent profile with a granting subagent reference', () => {
    const parsed = ProfileSchema.parse({
      name: 'parent',
      subagents: [
        {
          name: 'composer',
          description: 'Combines two strings',
          profile: 'text-helper',
          grant: { tools: ['concat_text'] },
        },
      ],
    })
    expect(parsed.subagents).toHaveLength(1)
    expect(parsed.subagents[0]?.grant?.tools).toEqual(['concat_text'])
  })
})
