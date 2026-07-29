import { describe, expect, it, vi } from 'vitest'
import {
  CodexThreadRecoveryService,
  CodexThreadRecoveryError,
} from '../../../../src/runtime/codex/thread-recovery.js'
import {
  beginCodexThreadTurn,
  createCodexThreadReference,
  observeCodexThreadConsequence,
  type CodexThreadReference,
} from '../../../../src/runtime/codex/official-thread.js'

const BASE = {
  localThreadId: 'local-thread-1',
  remoteThreadId: 'remote-thread-1',
  accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
  model: 'gpt-5.4',
  modelProvider: 'openai',
  profileReportId: 'profile-report-1',
  sandboxReportId: 'sandbox-report-1',
  boundAt: '2026-07-26T19:00:00.000Z',
} as const

function active(consequence: 'none_observed' | 'effect_possible' = 'none_observed') {
  const started = beginCodexThreadTurn(createCodexThreadReference(BASE), {
    id: 'turn-1',
    startedAt: '2026-07-26T19:01:00.000Z',
  })
  return consequence === 'none_observed'
    ? started
    : observeCodexThreadConsequence(started, consequence)
}

function response(status: 'inProgress' | 'completed' | 'interrupted' | 'failed') {
  return {
    thread: {
      id: 'remote-thread-1',
      modelProvider: 'openai',
      turns: [{
        id: 'turn-1',
        status,
        items: [{
          id: 'message-1',
          type: 'agentMessage',
          text: 'private provider history',
        }],
        startedAt: 1_785_067_260,
        completedAt: status === 'inProgress' ? null : 1_785_067_320,
      }],
    },
  }
}

function service(
  request: (method: string, params: unknown) => Promise<unknown>,
  persistReference = vi.fn(async (_reference: CodexThreadReference) => {}),
) {
  return {
    subject: new CodexThreadRecoveryService({
      client: { request },
      persistReference,
    }),
    persistReference,
  }
}

describe('Codex thread restart recovery', () => {
  it('uses exact thread/read history as terminal authority and persists ready state', async () => {
    const request = vi.fn(async () => response('completed'))
    const { subject, persistReference } = service(request)

    const result = await subject.recover(active())

    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'remote-thread-1',
      includeTurns: true,
    })
    expect(result).toMatchObject({
      status: 'ready',
      reference: {
        activeTurn: null,
        recoveryState: 'ready',
        lastTerminalTurn: {
          id: 'turn-1',
          status: 'completed',
          authority: 'thread/read',
        },
      },
    })
    expect(persistReference).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain('private provider history')
  })

  it('closes an effectful recovered turn as outcome_unknown and blocks replay', async () => {
    const { subject } = service(async () => response('completed'))

    const result = await subject.recover(active('effect_possible'))

    expect(result).toMatchObject({
      status: 'outcome_unknown',
      reference: {
        activeTurn: null,
        recoveryState: 'outcome_unknown',
      },
    })
  })

  it('does not mutate a turn still running or absent from authoritative history', async () => {
    const runningPersist = vi.fn()
    const running = await service(
      async () => response('inProgress'),
      runningPersist,
    ).subject.recover(active())
    expect(running.status).toBe('still_running')
    expect(runningPersist).not.toHaveBeenCalled()

    const missingResponse = response('completed')
    missingResponse.thread.turns[0]!.id = 'another-turn'
    const missingPersist = vi.fn()
    const missing = await service(
      async () => missingResponse,
      missingPersist,
    ).subject.recover(active())
    expect(missing.status).toBe('history_unresolved')
    expect(missingPersist).not.toHaveBeenCalled()
  })

  it('contains read rejection and malformed history without retaining provider data', async () => {
    const rejected = await service(async () => {
      throw new Error('private account and prompt')
    }).subject.recover(active())
    expect(rejected).toEqual({
      status: 'read_unavailable',
      reference: active(),
    })

    const malformed = await service(async () => ({
      thread: {
        id: 'wrong-thread',
        modelProvider: 'openai',
        turns: [],
        secret: 'private-token',
      },
    })).subject.recover(active())
    expect(malformed).toEqual({
      status: 'invalid_response',
      reference: active(),
    })
    expect(JSON.stringify([rejected, malformed])).not.toMatch(
      /private account|private-token/,
    )
  })

  it('reports persistence failure with one stable content-free code', async () => {
    const { subject } = service(
      async () => response('completed'),
      vi.fn(async () => {
        throw new Error('private sqlite detail')
      }),
    )

    await expect(subject.recover(active())).rejects.toMatchObject({
      name: 'CodexThreadRecoveryError',
      code: 'persistence_failed',
    })
    expect(new CodexThreadRecoveryError('persistence_failed').message).toBe(
      'Codex thread recovery failed (persistence_failed).',
    )
  })
})
