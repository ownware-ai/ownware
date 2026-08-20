import { describe, expect, it } from 'vitest'
import { hydratedStreamTarget } from '../../repl.js'

describe('hydratedStreamTarget', () => {
  it('uses the exact bounded run when hydration proves one', () => {
    expect(hydratedStreamTarget({
      thread: { id: 'thread-1' },
      runningAgentId: 'root',
      runningRunId: '00000000-0000-4000-8000-000000000001',
      lastClosedTurnEndSeq: 42,
    })).toEqual({
      streamId: '00000000-0000-4000-8000-000000000001',
      runId: '00000000-0000-4000-8000-000000000001',
      since: 42,
    })
  })

  it('uses the legacy thread stream only for live work without run correlation', () => {
    expect(hydratedStreamTarget({
      thread: { id: 'thread-1' },
      runningAgentId: 'root',
      runningRunId: null,
      lastClosedTurnEndSeq: 7,
    })).toEqual({ streamId: 'thread-1', runId: null, since: 7 })
  })

  it('does not open a stream for terminal hydration', () => {
    expect(hydratedStreamTarget({
      thread: { id: 'thread-1' },
      runningAgentId: null,
      runningRunId: null,
      lastClosedTurnEndSeq: 9,
    })).toBeNull()
  })
})
