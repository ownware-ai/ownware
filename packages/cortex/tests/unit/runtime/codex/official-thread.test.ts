import { describe, expect, it } from 'vitest'
import {
  CodexThreadReferenceError,
  advanceCodexThreadReference,
  assertCodexThreadResume,
  beginCodexThreadTurn,
  completeCodexThreadTurn,
  createCodexThreadReference,
  observeCodexThreadConsequence,
  parseCodexThreadReference,
} from '../../../../src/runtime/codex/official-thread.js'

const BASE = {
  localThreadId: 'local-thread-1',
  remoteThreadId: '019-app-server-thread',
  accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
  model: 'gpt-5.4',
  modelProvider: 'openai',
  profileReportId: 'profile-report-1',
  sandboxReportId: 'sandbox-report-1',
  boundAt: '2026-07-26T19:00:00.000Z',
} as const

describe('Codex official thread reference', () => {
  it('persists only the allowlisted safe binding metadata', () => {
    const reference = createCodexThreadReference(BASE)

    expect(reference).toEqual({
      schemaVersion: 1,
      revision: 0,
      selection: {
        runtime: 'openai-codex',
        access: { route: 'openai-chatgpt-managed' },
      },
      ...BASE,
      activeTurn: null,
      lastTerminalTurn: null,
      recoveryState: 'ready',
    })
    expect(JSON.stringify(reference)).not.toMatch(/email|token|prompt|output|auth/i)
    expect(parseCodexThreadReference(JSON.parse(JSON.stringify(reference)))).toEqual(
      reference,
    )
  })

  it('rejects unknown persisted fields instead of silently retaining secrets', () => {
    expect(() => parseCodexThreadReference({
      ...createCodexThreadReference(BASE),
      accessToken: 'must-not-survive',
    })).toThrowError(expect.objectContaining({ code: 'invalid_reference' }))
  })

  it('allows resume only under the exact runtime, account, model, and plan binding', () => {
    const reference = createCodexThreadReference(BASE)
    expect(assertCodexThreadResume(reference, BASE)).toBe(reference)

    expect(() => assertCodexThreadResume(reference, {
      ...BASE,
      accountBinding: `hmac-sha256:${'b'.repeat(64)}`,
    })).toThrowError(expect.objectContaining({ code: 'account_changed' }))
    expect(() => assertCodexThreadResume(reference, {
      ...BASE,
      model: 'future-model',
    })).toThrowError(expect.objectContaining({ code: 'model_changed' }))
    expect(() => assertCodexThreadResume(reference, {
      ...BASE,
      profileReportId: 'profile-report-2',
    })).toThrowError(expect.objectContaining({ code: 'plan_changed' }))
  })

  it('records one provider-authoritative terminal turn without raw history', () => {
    const reference = createCodexThreadReference(BASE)
    const advanced = advanceCodexThreadReference(reference, {
      id: 'turn-1',
      status: 'completed',
      completedAt: '2026-07-26T19:01:00.000Z',
      authority: 'turn/completed',
    })

    expect(advanced.lastTerminalTurn).toEqual({
      id: 'turn-1',
      status: 'completed',
      completedAt: '2026-07-26T19:01:00.000Z',
      authority: 'turn/completed',
    })
    expect(() => advanceCodexThreadReference(advanced, {
      id: 'turn-1',
      status: 'failed',
      completedAt: '2026-07-26T19:01:01.000Z',
      authority: 'turn/completed',
    })).toThrowError(expect.objectContaining({ code: 'terminal_conflict' }))
  })

  it('persists an active turn and its monotonic consequence before recovery decisions', () => {
    const reference = createCodexThreadReference(BASE)
    const active = beginCodexThreadTurn(reference, {
      id: 'turn-active',
      startedAt: '2026-07-26T19:02:00.000Z',
    })
    expect(active.activeTurn).toEqual({
      id: 'turn-active',
      startedAt: '2026-07-26T19:02:00.000Z',
      consequence: 'none_observed',
    })
    expect(active.revision).toBe(1)
    const effected = observeCodexThreadConsequence(active, 'effect_possible')
    expect(effected.activeTurn?.consequence).toBe('effect_possible')
    expect(effected.revision).toBe(2)
    expect(
      observeCodexThreadConsequence(effected, 'output_observed')
        .activeTurn?.consequence,
    ).toBe('effect_possible')

    expect(() => assertCodexThreadResume(effected, BASE)).toThrowError(
      expect.objectContaining({ code: 'active_turn_unresolved' }),
    )
  })

  it('blocks automatic resume after an ambiguous effect even if the provider turn closed', () => {
    const active = beginCodexThreadTurn(createCodexThreadReference(BASE), {
      id: 'turn-ambiguous',
      startedAt: '2026-07-26T19:02:00.000Z',
    })
    const completed = completeCodexThreadTurn(
      observeCodexThreadConsequence(active, 'effect_possible'),
      {
        id: 'turn-ambiguous',
        status: 'completed',
        completedAt: '2026-07-26T19:03:00.000Z',
        authority: 'turn/completed',
      },
      false,
    )

    expect(completed.activeTurn).toBeNull()
    expect(completed.recoveryState).toBe('outcome_unknown')
    expect(() => assertCodexThreadResume(completed, BASE)).toThrowError(
      expect.objectContaining({ code: 'outcome_unknown' }),
    )
  })

  it('accepts an exact thread/read terminal as restart recovery authority', () => {
    const active = beginCodexThreadTurn(createCodexThreadReference(BASE), {
      id: 'turn-recovered',
      startedAt: '2026-07-26T19:02:00.000Z',
    })
    const recovered = completeCodexThreadTurn(active, {
      id: 'turn-recovered',
      status: 'completed',
      completedAt: '2026-07-26T19:03:00.000Z',
      authority: 'thread/read',
    }, true)

    expect(recovered.lastTerminalTurn?.authority).toBe('thread/read')
    expect(recovered.revision).toBe(2)
  })
})

describe('CodexThreadReferenceError', () => {
  it('contains a stable content-free code', () => {
    const error = new CodexThreadReferenceError('account_changed')
    expect(error.message).toBe('Codex thread reference failed (account_changed).')
    expect(error).not.toHaveProperty('reference')
  })
})
