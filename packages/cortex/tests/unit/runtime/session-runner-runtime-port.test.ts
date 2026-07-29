import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanInTheLoop, type LoomEvent, type Session } from '@ownware/loom'
import { GatewayState } from '../../../src/gateway/state.js'
import { SessionRunner } from '../../../src/gateway/session-runner.js'
import {
  ManagedExecutionRuntime,
  type RuntimeDriver,
  type RuntimeDriverEvent,
  type RuntimeCompletion,
} from '../../../src/runtime/port.js'

class SilentLegacySession {
  readonly sessionId = 'silent-legacy'
  abort(): void {}
  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    return { completed: true }
  }
}

function externalRuntime(
  events: readonly RuntimeDriverEvent[],
  close: () => Promise<void> = async () => {},
  completion: RuntimeCompletion = {
    outcome: 'succeeded',
    authority: 'synthetic external completion',
  },
): ManagedExecutionRuntime {
  const driver: RuntimeDriver = {
    selection: {
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    },
    async *start() {
      yield* events
      return completion
    },
    answerPermission: async () => ({ status: 'unsupported' }),
    cancel: async () => {},
    close,
  }
  return new ManagedExecutionRuntime(driver)
}

describe('SessionRunner execution-runtime port', () => {
  let state: GatewayState
  let runner: SessionRunner
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ownware-runtime-port-'))
    state = new GatewayState(join(testDir, 'ownware.db'))
    runner = new SessionRunner(state)
  })

  afterEach(async () => {
    state.close()
    await rm(testDir, { recursive: true, force: true })
  })

  it('consumes the selected execution runtime instead of the cached Ownware session', async () => {
    const thread = state.createThread('test')
    const session = new SilentLegacySession()
    const hitl = new HumanInTheLoop({ requestPermission: async () => 'allow' })
    const runtime = externalRuntime([
      {
        kind: 'canonical',
        sourceSequence: 1,
        event: { type: 'turn.start', turnIndex: 0, timestamp: 1 },
      },
      {
        kind: 'canonical',
        sourceSequence: 2,
        event: { type: 'text.delta', text: 'from external runtime', turnIndex: 0 },
      },
      {
        kind: 'canonical',
        sourceSequence: 3,
        event: {
          type: 'turn.end',
          turnIndex: 0,
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1,
            outputTokens: 3,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            model: 'synthetic',
            costUsd: 0,
          },
          timestamp: 2,
        },
      },
    ])
    state.setSession(thread.id, session as unknown as Session)
    state.setRuntime(thread.id, {
      session: session as unknown as Session,
      hitl,
      zoneManager: null,
      execution: runtime,
    })

    const result = await runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'synthetic',
      prompt: 'hello',
    }).done

    expect(result.status).toBe('completed')
    expect(state.getMessages(thread.id)).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: 'from external runtime',
    }))
    expect(runtime.status().phase).toBe('closed')
    expect(state.getRuntime(thread.id)).toBeUndefined()
  })

  it('surfaces an unknown external event as a typed run error and never persists raw payload', async () => {
    const thread = state.createThread('test')
    const runtime = externalRuntime([
      {
        kind: 'unknown',
        sourceSequence: 1,
        sourceType: 'future/event',
        observedAt: 1,
      },
    ])
    state.setRuntime(thread.id, {
      zoneManager: null,
      execution: runtime,
    })

    const result = await runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'synthetic',
      prompt: 'secret prompt must not enter runtime error',
    }).done

    expect(result.status).toBe('error')
    const errors = state.listAgentEvents({
      threadId: thread.id,
      agentId: 'root',
    }).filter((event) => event.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.payload).toMatchObject({
      code: 'runtime_unknown_event',
    })
    expect(JSON.stringify(errors)).toContain('future/event')
    expect(JSON.stringify(errors)).not.toContain('secret prompt')
  })

  it('records provider-authoritative interruption as aborted rather than completed or failed', async () => {
    const thread = state.createThread('test')
    const runtime = externalRuntime([
      {
        kind: 'canonical',
        sourceSequence: 1,
        event: { type: 'turn.start', turnIndex: 0, timestamp: 1 },
      },
      {
        kind: 'canonical',
        sourceSequence: 2,
        event: {
          type: 'turn.end',
          turnIndex: 0,
          stopReason: 'aborted',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            model: 'synthetic',
            costUsd: 0,
          },
          timestamp: 2,
        },
      },
    ], async () => {}, {
      outcome: 'cancelled',
      authority: 'turn/completed',
      reason: 'user',
    })
    state.setRuntime(thread.id, {
      zoneManager: null,
      execution: runtime,
    })

    const result = await runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'synthetic',
      prompt: 'cancel me',
    }).done

    expect(result.status).toBe('aborted')
    expect(state.listAgentEvents({
      threadId: thread.id,
      agentId: 'root',
    })).toContainEqual(expect.objectContaining({
      type: 'turn.end',
      payload: expect.objectContaining({ stopReason: 'aborted' }),
    }))
  })
})
