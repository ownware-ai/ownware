import { describe, expect, it } from 'vitest'
import type { ContentBlock, LoomEvent, Session } from '@ownware/loom'
import {
  ManagedExecutionRuntime,
  createOwnwareRuntimeDriver,
  type RuntimeDriver,
  type RuntimeDriverEvent,
  type RuntimeStartRequest,
} from '../../../src/runtime/port.js'
import type { RuntimeSelection } from '../../../src/runtime/selection.js'

const OWNWARE_SELECTION: RuntimeSelection = {
  runtime: 'ownware',
  access: { route: 'provider-api' },
}

const EXTERNAL_SELECTION: RuntimeSelection = {
  runtime: 'openai-codex',
  access: { route: 'openai-chatgpt-managed' },
}

const COMPLETE_EVENTS: readonly LoomEvent[] = [
  { type: 'turn.start', turnIndex: 0, timestamp: 1 },
  { type: 'text.delta', text: 'hello', turnIndex: 0 },
  {
    type: 'turn.end',
    turnIndex: 0,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'synthetic',
      costUsd: 0,
    },
    timestamp: 2,
  },
]

class ScriptedSession {
  readonly sessionId = 'scripted'
  abortCalls = 0

  constructor(private readonly events: readonly LoomEvent[]) {}

  async *submitMessage(
    _message: string | ContentBlock[],
  ): AsyncGenerator<LoomEvent, unknown> {
    yield* this.events
    return { completed: true }
  }

  abort(): void {
    this.abortCalls++
  }
}

function externalDriver(
  events: readonly RuntimeDriverEvent[],
  overrides: Partial<RuntimeDriver> = {},
): RuntimeDriver {
  return {
    selection: EXTERNAL_SELECTION,
    async *start(_request: RuntimeStartRequest) {
      yield* events
      return {
        outcome: 'succeeded',
        authority: 'synthetic external completion',
      } as const
    },
    answerPermission: async () => ({ status: 'unsupported' }),
    cancel: async () => {},
    close: async () => {},
    ...overrides,
  }
}

async function collect(runtime: ManagedExecutionRuntime): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  const stream = runtime.start({ prompt: 'synthetic prompt' })
  let result = await stream.next()
  while (!result.done) {
    events.push(result.value.event)
    result = await stream.next()
  }
  return events
}

describe.each([
  {
    name: 'Ownware session adapter',
    create: () => {
      const session = new ScriptedSession(COMPLETE_EVENTS)
      return new ManagedExecutionRuntime(createOwnwareRuntimeDriver({
        session: session as unknown as Session,
        selection: OWNWARE_SELECTION,
      }))
    },
  },
  {
    name: 'test-only external runtime',
    create: () => new ManagedExecutionRuntime(externalDriver(
      COMPLETE_EVENTS.map((event, index) => ({
        kind: 'canonical',
        sourceSequence: index + 1,
        event,
      })),
    )),
  },
])('$name runtime contract', ({ create }) => {
  it('streams canonical events in source order and records visible output', async () => {
    const runtime = create()

    await expect(collect(runtime)).resolves.toEqual(COMPLETE_EVENTS)
    expect(runtime.status()).toMatchObject({
      phase: 'completed',
      outcome: 'succeeded',
      consequence: 'output_observed',
      lastSequence: 3,
    })
  })
})

describe('managed runtime failure semantics', () => {
  it('preserves an authoritative cancellation instead of calling it success or failure', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      async *start() {
        return {
          outcome: 'cancelled',
          authority: 'turn/completed',
          reason: 'user',
        } as const
      },
    }))
    const stream = runtime.start({ prompt: 'synthetic' })

    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: {
        outcome: 'cancelled',
        authority: 'turn/completed',
        reason: 'user',
      },
    })
    expect(runtime.status()).toMatchObject({
      phase: 'completed',
      outcome: 'cancelled',
    })
  })

  it('rejects an unknown external event without preserving its payload or claiming success', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([
      {
        kind: 'unknown',
        sourceSequence: 1,
        sourceType: 'future/event',
        observedAt: 10,
      },
    ]))

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_unknown_event',
      sourceType: 'future/event',
    })
    expect(runtime.status()).toMatchObject({
      phase: 'failed',
      outcome: 'indeterminate',
      consequence: 'effect_possible',
    })
    expect(JSON.stringify(runtime.status())).not.toContain('payload')
  })

  it('rejects duplicate or out-of-order source positions', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([
      { kind: 'canonical', sourceSequence: 2, event: COMPLETE_EVENTS[0]! },
      { kind: 'canonical', sourceSequence: 2, event: COMPLETE_EVENTS[1]! },
    ]))

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_event_order',
      sourceSequence: 2,
    })
    expect(runtime.status().outcome).toBe('indeterminate')
  })

  it('rejects an event observed after the runtime declared a terminal event', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([
      {
        kind: 'canonical',
        sourceSequence: 1,
        event: {
          type: 'session.end',
          sessionId: 'external',
          reason: 'end_turn',
          totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
          turnCount: 1,
          durationMs: 1,
        },
      },
      { kind: 'canonical', sourceSequence: 2, event: COMPLETE_EVENTS[1]! },
    ]))

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_late_event',
      sourceSequence: 2,
    })
  })

  it('does not accept success while an exact permission is still pending', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([
      {
        kind: 'canonical',
        sourceSequence: 1,
        event: {
          type: 'permission.request',
          requestId: 'unanswered',
          toolName: 'synthetic_tool',
          input: {},
          reason: 'Synthetic approval',
          turnIndex: 0,
        },
      },
    ]))

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_permission_unresolved',
    })
    expect(runtime.status()).toMatchObject({
      phase: 'failed',
      outcome: 'indeterminate',
      consequence: 'effect_possible',
    })
  })

  it('keeps an early indeterminate exit indeterminate', async () => {
    const driver = externalDriver([], {
      async *start() {
        return {
          outcome: 'indeterminate',
          authority: 'synthetic process exited before completion',
        } as const
      },
    })
    const runtime = new ManagedExecutionRuntime(driver)

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_outcome_indeterminate',
    })
    expect(runtime.status()).toMatchObject({
      phase: 'failed',
      outcome: 'indeterminate',
    })
  })

  it('throws a typed failure when the driver authoritatively reports failure', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      async *start() {
        return {
          outcome: 'failed',
          authority: 'synthetic external rejection',
          code: 'model_rejected',
        } as const
      },
    }))

    await expect(collect(runtime)).rejects.toMatchObject({
      code: 'runtime_reported_failure',
      runtimeCode: 'model_rejected',
    })
    expect(runtime.status()).toMatchObject({
      phase: 'failed',
      outcome: 'failed',
      consequence: 'none_observed',
    })
  })

  it('does not surface an unsafe unknown-event label', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([
      {
        kind: 'unknown',
        sourceSequence: 1,
        sourceType: 'future/event raw-secret-value',
        observedAt: 10,
      },
    ]))

    const error = await collect(runtime).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'runtime_unknown_event',
      sourceType: 'unrecognized',
    })
    expect(JSON.stringify(error)).not.toContain('raw-secret-value')
  })
})

describe('managed runtime control contract', () => {
  it('tracks an exact pending permission until the driver accepts its decision', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    const driver = externalDriver([], {
      async *start() {
        yield {
          kind: 'canonical',
          sourceSequence: 1,
          event: {
            type: 'permission.request',
            requestId: 'pending',
            toolName: 'synthetic_tool',
            input: {},
            reason: 'Synthetic approval',
            turnIndex: 0,
          },
        } as const
        await released
        yield {
          kind: 'canonical',
          sourceSequence: 2,
          event: {
            type: 'permission.response',
            requestId: 'pending',
            granted: true,
            turnIndex: 0,
          },
        } as const
        return {
          outcome: 'succeeded',
          authority: 'synthetic external completion',
        } as const
      },
      answerPermission: async () => {
        release()
        return { status: 'delivered' }
      },
    })
    const runtime = new ManagedExecutionRuntime(driver)
    const stream = runtime.start({ prompt: 'synthetic' })

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: { type: 'permission.request', requestId: 'pending' } },
    })
    expect(runtime.hasPendingPermission('pending')).toBe(true)
    await expect(runtime.answerPermission({
      requestId: 'pending',
      decision: 'approve',
    })).resolves.toEqual({ status: 'delivered' })
    expect(runtime.hasPendingPermission('pending')).toBe(false)
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: { type: 'permission.response', requestId: 'pending' } },
    })
    await expect(stream.next()).resolves.toMatchObject({
      done: true,
      value: { outcome: 'succeeded' },
    })
  })

  it('delivers an exact permission decision and fails a stale request honestly', async () => {
    const delivered: Array<{ requestId: string; decision: string }> = []
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      answerPermission: async (decision) => {
        delivered.push(decision)
        return decision.requestId === 'pending'
          ? { status: 'delivered' }
          : { status: 'stale' }
      },
    }))

    await expect(runtime.answerPermission({
      requestId: 'pending',
      decision: 'approve',
    })).resolves.toEqual({ status: 'delivered' })
    await expect(runtime.answerPermission({
      requestId: 'missing',
      decision: 'deny',
    })).resolves.toEqual({ status: 'stale' })
    expect(delivered).toEqual([
      { requestId: 'pending', decision: 'approve' },
      { requestId: 'missing', decision: 'deny' },
    ])
  })

  it('makes cancellation state idempotent while allowing repeated transport signals', async () => {
    let signals = 0
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      cancel: async () => { signals++ },
    }))

    await expect(runtime.cancel('user')).resolves.toEqual({ status: 'requested' })
    await expect(runtime.cancel('user')).resolves.toEqual({ status: 'already_requested' })
    expect(signals).toBe(2)
    expect(runtime.status()).toMatchObject({
      phase: 'cancelling',
      outcome: 'pending',
    })
  })

  it('closes once and returns the same bounded result to concurrent callers', async () => {
    let closes = 0
    let release!: () => void
    const blocker = new Promise<void>((resolve) => { release = resolve })
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      close: async () => {
        closes++
        await blocker
      },
    }))

    const first = runtime.close(100)
    const second = runtime.close(100)
    release()

    await expect(first).resolves.toEqual({ status: 'closed' })
    await expect(second).resolves.toEqual({ status: 'closed' })
    expect(closes).toBe(1)
  })

  it('bounds a stuck close and reports that the process outcome is unknown', async () => {
    const runtime = new ManagedExecutionRuntime(externalDriver([], {
      close: () => new Promise<void>(() => {}),
    }))

    await expect(runtime.close(5)).resolves.toEqual({ status: 'timed_out' })
    expect(runtime.status()).toMatchObject({
      phase: 'failed',
      outcome: 'indeterminate',
      consequence: 'effect_possible',
    })
    await expect(runtime.close(5)).resolves.toEqual({ status: 'timed_out' })
  })
})
