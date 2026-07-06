/**
 * Pure unit tests for the per-schedule safety envelope (`applySafetyLevel`).
 * No DB, no model — fake Tool shapes only — so this runs under plain node
 * without the better-sqlite3 native module (ENV-2).
 *
 * The security invariant: a scheduled run can NEVER be handed a mutating /
 * sending tool unless the user explicitly chose 'full-access'. read-only and
 * draft-approval both withhold everything not provably read-only.
 */
import { describe, it, expect } from 'vitest'
import type { Tool } from '@ownware/loom'
import {
  applySafetyLevel,
  allowsMutatingTools,
  SafetyLevelSchema,
  DEFAULT_SAFETY_LEVEL,
} from '../../../src/schedules/safety.js'

function tool(name: string, isReadOnly: boolean | undefined): Tool {
  return { name, isReadOnly } as unknown as Tool
}

const TOOLS: Tool[] = [
  tool('readFile', true),
  tool('web_search', true),
  tool('writeFile', false),
  tool('gmail_send', false),
  tool('mystery_tool', undefined), // no flag → must be treated as mutating
]
const names = (ts: Tool[]): string[] => ts.map((t) => t.name)

describe('applySafetyLevel — the unattended tool boundary', () => {
  it('full-access keeps every tool (the user opted in)', () => {
    expect(names(applySafetyLevel(TOOLS, 'full-access'))).toEqual([
      'readFile',
      'web_search',
      'writeFile',
      'gmail_send',
      'mystery_tool',
    ])
  })

  it('read-only keeps ONLY provably read-only tools', () => {
    expect(names(applySafetyLevel(TOOLS, 'read-only'))).toEqual(['readFile', 'web_search'])
  })

  it('draft-approval also withholds writes/sends until the hold pipeline lands (8d)', () => {
    // Safe-by-default: identical to read-only for now — never a window where a
    // draft-approval scheduled run could auto-send.
    expect(names(applySafetyLevel(TOOLS, 'draft-approval'))).toEqual(['readFile', 'web_search'])
  })

  it('an unknown isReadOnly flag is treated as mutating (fails closed)', () => {
    expect(names(applySafetyLevel(TOOLS, 'read-only'))).not.toContain('mystery_tool')
  })

  it('never mutates the input array', () => {
    const copy = [...TOOLS]
    applySafetyLevel(TOOLS, 'read-only')
    expect(TOOLS).toEqual(copy)
  })

  it('allowsMutatingTools is true ONLY for full-access', () => {
    expect(allowsMutatingTools('full-access')).toBe(true)
    expect(allowsMutatingTools('read-only')).toBe(false)
    expect(allowsMutatingTools('draft-approval')).toBe(false)
  })

  it('the default level is the safe one (draft-approval) and is a valid enum', () => {
    expect(DEFAULT_SAFETY_LEVEL).toBe('draft-approval')
    expect(SafetyLevelSchema.safeParse(DEFAULT_SAFETY_LEVEL).success).toBe(true)
    expect(SafetyLevelSchema.safeParse('yolo').success).toBe(false)
  })
})
