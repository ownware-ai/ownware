import { describe, expect, it, vi } from 'vitest'
import {
  CodexThreadLifecycleError,
  CodexThreadLifecycleService,
} from '../../../../src/runtime/codex/thread-lifecycle.js'
import {
  beginCodexThreadTurn,
  createCodexThreadReference,
} from '../../../../src/runtime/codex/official-thread.js'

const REFERENCE = createCodexThreadReference({
  localThreadId: 'local-thread-1',
  remoteThreadId: 'remote-thread-1',
  accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
  model: 'gpt-5.4',
  modelProvider: 'openai',
  profileReportId: 'profile-report-1',
  sandboxReportId: 'sandbox-report-1',
  boundAt: '2026-07-26T19:00:00.000Z',
})

describe('Codex remote thread lifecycle', () => {
  it('inspects only the exact bound remote thread without loading history', async () => {
    const request = vi.fn(async () => ({
      thread: {
        id: 'remote-thread-1',
        modelProvider: 'openai',
        status: { type: 'idle' },
        turns: [],
        preview: 'private prompt',
      },
    }))
    const service = new CodexThreadLifecycleService({ request })

    await expect(service.inspect(REFERENCE)).resolves.toEqual({
      status: 'available',
      remoteThreadId: 'remote-thread-1',
    })
    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'remote-thread-1',
      includeTurns: false,
    })
  })

  it('archives and deletes only after strict empty acknowledgements', async () => {
    const request = vi.fn(async () => ({}))
    const service = new CodexThreadLifecycleService({ request })

    await expect(service.archive(REFERENCE)).resolves.toEqual({
      status: 'archived',
      remoteThreadId: 'remote-thread-1',
    })
    await expect(service.delete(REFERENCE)).resolves.toEqual({
      status: 'deleted',
      remoteThreadId: 'remote-thread-1',
    })
    expect(request.mock.calls).toEqual([
      ['thread/archive', { threadId: 'remote-thread-1' }],
      ['thread/delete', { threadId: 'remote-thread-1' }],
    ])
  })

  it('does not claim a missing thread from an opaque RPC rejection', async () => {
    const service = new CodexThreadLifecycleService({
      request: async () => {
        throw new Error('private provider detail')
      },
    })

    await expect(service.inspect(REFERENCE)).resolves.toEqual({
      status: 'unavailable',
      remoteThreadId: 'remote-thread-1',
    })
  })

  it('rejects malformed acknowledgements and lifecycle changes during an active turn', async () => {
    const service = new CodexThreadLifecycleService({
      request: async () => ({ secret: 'private provider detail' }),
    })
    await expect(service.archive(REFERENCE)).rejects.toMatchObject({
      code: 'invalid_response',
    })
    await expect(service.delete(REFERENCE)).rejects.toMatchObject({
      code: 'invalid_response',
    })

    const active = beginCodexThreadTurn(REFERENCE, {
      id: 'turn-1',
      startedAt: '2026-07-26T19:01:00.000Z',
    })
    const noRpc = vi.fn()
    const guarded = new CodexThreadLifecycleService({ request: noRpc })
    await expect(guarded.archive(active)).rejects.toMatchObject({
      code: 'active_turn_unresolved',
    })
    expect(noRpc).not.toHaveBeenCalled()
    expect(
      new CodexThreadLifecycleError('invalid_response').message,
    ).not.toContain('private')
  })
})
