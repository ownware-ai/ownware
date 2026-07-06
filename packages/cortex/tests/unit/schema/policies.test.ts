/**
 * Tests for the per-tool policies block on ProfileSchema.
 */

import { describe, it, expect } from 'vitest'
import { ProfileSchema, ToolPolicySpecSchema } from '../../../src/profile/schema.js'

describe('ProfileSchema: policies', () => {
  it('defaults to an empty array', () => {
    const parsed = ProfileSchema.parse({ name: 'p' })
    expect(parsed.policies).toEqual([])
  })

  it('accepts a valid shell policy entry', () => {
    const parsed = ProfileSchema.parse({
      name: 'p',
      policies: [
        {
          kind: 'shell',
          tool: 'shell_execute',
          allowPrefixes: ['ls', 'git log'],
          denyPatterns: ['^git push'],
          allowDangerous: false,
          allowInjection: false,
        },
      ],
    })
    expect(parsed.policies).toHaveLength(1)
    expect(parsed.policies[0]?.tool).toBe('shell_execute')
  })

  it('fills shell-policy defaults', () => {
    const parsed = ToolPolicySpecSchema.parse({
      kind: 'shell',
      tool: 'shell_execute',
    })
    expect(parsed).toEqual({
      kind: 'shell',
      tool: 'shell_execute',
      allowPrefixes: [],
      denyPatterns: [],
      allowDangerous: false,
      allowInjection: false,
    })
  })

  it('rejects unknown kinds', () => {
    const result = ToolPolicySpecSchema.safeParse({
      kind: 'mystery',
      tool: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty tool pattern', () => {
    const result = ToolPolicySpecSchema.safeParse({
      kind: 'shell',
      tool: '',
    })
    expect(result.success).toBe(false)
  })
})
