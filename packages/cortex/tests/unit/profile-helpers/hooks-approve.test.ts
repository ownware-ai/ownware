/**
 * Unit tests for the `approve` hook action (H6) — the declarative
 * "pause this tool call for a human decision" verb.
 *
 * Covers:
 *   - schema accepts the action; onToolCall-only validation
 *   - `tools` glob scoping (matching pauses, non-matching passes through)
 *   - approver verdicts: approve → continue, deny → block with reason
 *   - FAIL CLOSED: no approver wired / approver throws → deny, never allow
 *   - the wait is awaited (a delayed decision still lands)
 */

import { describe, it, expect } from 'vitest'
import { ProfileSchema } from '../../../src/profile/schema.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'
import {
  buildHookBinding,
  HookConfigError,
  type HookApprovalRequest,
} from '../../../src/profile/hooks.js'
import type { HookContext } from '@ownware/loom'

function makeProfile(hooks: Record<string, unknown>): LoadedProfile {
  const config = ProfileSchema.parse({ name: 'approve-test', hooks })
  return {
    config,
    soulMd: null,
    agentsMd: null,
    skills: [],
    basePath: '/tmp/approve-test-profile',
    timeoutMs: 1_800_000,
  }
}

const toolPre = (toolName: string): HookContext => ({
  event: 'tool.pre',
  turnIndex: 1,
  toolName,
  toolInput: { amount: 500 },
})

describe('approve hook — compile validation', () => {
  it('parses and compiles in onToolCall', () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      { requestHookApproval: async () => ({ approved: true }) },
    )
    expect(binding).not.toBeNull()
    expect(binding!.runtime.has('tool.pre')).toBe(true)
  })

  it('rejects approve outside onToolCall (nothing left to approve)', () => {
    expect(() =>
      buildHookBinding(makeProfile({ onToolEnd: [{ action: 'approve' }] })),
    ).toThrow(HookConfigError)
    expect(() =>
      buildHookBinding(makeProfile({ onComplete: [{ action: 'approve' }] })),
    ).toThrow(/only valid in hooks\.onToolCall/)
  })
})

describe('approve hook — decisions', () => {
  it('approve → the tool proceeds; the approver sees the real call', async () => {
    const seen: HookApprovalRequest[] = []
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      {
        requestHookApproval: async (req) => {
          seen.push(req)
          return { approved: true }
        },
      },
    )!
    const result = await binding.runtime.run(toolPre('send_refund'))
    expect(result.continue).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.toolName).toBe('send_refund')
    expect(seen[0]!.toolInput).toEqual({ amount: 500 })
    expect(seen[0]!.reason).toContain('approve-test')
  })

  it('deny → the tool is blocked with the decision reason (model-visible)', async () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      {
        requestHookApproval: async () => ({
          approved: false,
          reason: 'The operator denied "send_refund" (approval prompt).',
        }),
      },
    )!
    const result = await binding.runtime.run(toolPre('send_refund'))
    expect(result.continue).toBe(false)
    expect(result.blockedReason).toContain('denied')
  })

  it('a delayed decision is awaited, not timed out by the fn path', async () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      {
        requestHookApproval: () =>
          new Promise((r) => setTimeout(() => r({ approved: true }), 150)),
      },
    )!
    const result = await binding.runtime.run(toolPre('send_refund'))
    expect(result.continue).toBe(true)
  })
})

describe('approve hook — tools glob scoping', () => {
  it('only matching tools pause; others pass without consulting the approver', async () => {
    let asked = 0
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve', tools: ['send_*', 'shell_execute'] }] }),
      {
        requestHookApproval: async () => {
          asked++
          return { approved: true }
        },
      },
    )!

    const readResult = await binding.runtime.run(toolPre('readFile'))
    expect(readResult.continue).toBe(true)
    expect(asked).toBe(0) // readFile never paused

    await binding.runtime.run(toolPre('send_email'))
    await binding.runtime.run(toolPre('shell_execute'))
    expect(asked).toBe(2)
  })
})

describe('approve hook — fail closed', () => {
  it('no approver wired → deny with an honest reason (CLI/tests/bare embedders)', async () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      // no requestHookApproval
    )!
    const result = await binding.runtime.run(toolPre('send_refund'))
    expect(result.continue).toBe(false)
    expect(result.blockedReason).toContain('no approval channel')
    expect(result.blockedReason).toContain('fail-closed')
  })

  it('approver throws → deny, never allow', async () => {
    const binding = buildHookBinding(
      makeProfile({ onToolCall: [{ action: 'approve' }] }),
      {
        requestHookApproval: async () => {
          throw new Error('SSE bus down')
        },
      },
    )!
    const result = await binding.runtime.run(toolPre('send_refund'))
    expect(result.continue).toBe(false)
    expect(result.blockedReason).toContain('SSE bus down')
    expect(result.blockedReason).toContain('fail-closed')
  })
})
