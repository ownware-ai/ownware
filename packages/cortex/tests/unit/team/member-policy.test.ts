/**
 * Member tool policy (B3a) — autonomy + restricts enforced as tool
 * ACCESS. The guarantee is structural: a read-only member's mutating
 * tools are not present at all, which is stronger than a permission
 * denial a headless run could never answer.
 */

import { describe, expect, it } from 'vitest'
import type { Tool } from '@ownware/loom'
import { applyMemberToolPolicy } from '../../../src/team/member-policy.js'
import type { TeamMember } from '../../../src/team/schema.js'

function tool(name: string, isReadOnly: boolean): Tool {
  return { name, isReadOnly } as unknown as Tool
}

function member(overrides: Partial<TeamMember>): TeamMember {
  return {
    slug: 'm',
    profileId: 'p',
    role: 'R',
    autonomy: 'inherit',
    toolRestricts: [],
    ...overrides,
  }
}

const TOOLS: Tool[] = [
  tool('readFile', true),
  tool('grep', true),
  tool('writeFile', false),
  tool('editFile', false),
  tool('shell_execute', false),
  tool('mystery_tool', undefined as unknown as boolean), // unknown read-only status
]

const names = (ts: Tool[]): string[] => ts.map((t) => t.name).sort()

describe('applyMemberToolPolicy', () => {
  it('inherit keeps the full surface untouched', () => {
    expect(applyMemberToolPolicy(TOOLS, member({ autonomy: 'inherit' }))).toHaveLength(TOOLS.length)
  })

  it('read-only keeps only read tools — every mutating tool is gone', () => {
    const out = names(applyMemberToolPolicy(TOOLS, member({ autonomy: 'read-only' })))
    expect(out).toEqual(['grep', 'readFile'])
    expect(out).not.toContain('writeFile')
    expect(out).not.toContain('editFile')
    expect(out).not.toContain('shell_execute')
  })

  it('read-only treats unknown read-only status as mutating (safe default)', () => {
    const out = names(applyMemberToolPolicy(TOOLS, member({ autonomy: 'read-only' })))
    expect(out).not.toContain('mystery_tool')
  })

  it('toolRestricts remove named tools via glob, independent of autonomy', () => {
    const out = names(applyMemberToolPolicy(TOOLS, member({ toolRestricts: ['shell_*', 'editFile'] })))
    expect(out).not.toContain('shell_execute')
    expect(out).not.toContain('editFile')
    expect(out).toContain('writeFile')
    expect(out).toContain('readFile')
  })

  it('read-only and restricts compose (restrict removes a read tool too)', () => {
    const out = names(applyMemberToolPolicy(TOOLS, member({ autonomy: 'read-only', toolRestricts: ['grep'] })))
    expect(out).toEqual(['readFile'])
  })
})
