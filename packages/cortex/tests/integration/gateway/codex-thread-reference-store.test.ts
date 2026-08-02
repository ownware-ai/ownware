import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayState } from '../../../src/gateway/state.js'
import {
  CodexThreadReferenceStore,
  CodexThreadReferenceStoreError,
} from '../../../src/runtime/codex/thread-reference-store.js'
import {
  beginCodexThreadTurn,
  createCodexThreadReference,
} from '../../../src/runtime/codex/official-thread.js'

describe('Codex thread reference persistence', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ))
  })

  async function database() {
    const directory = await mkdtemp(join(tmpdir(), 'codex-thread-store-'))
    cleanup.push(directory)
    const path = join(directory, 'ownware.db')
    const state = new GatewayState(path)
    return { directory, path, state }
  }

  it('survives restart using only allowlisted columns and cascades on thread delete', async () => {
    const { path, state } = await database()
    const thread = await state.createThread('test')
    const store = new CodexThreadReferenceStore(state.rawDbHandle)
    const reference = createCodexThreadReference({
      localThreadId: thread.id,
      remoteThreadId: 'remote-thread-1',
      accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
      model: 'gpt-5.4',
      modelProvider: 'openai',
      profileReportId: 'profile-report',
      sandboxReportId: 'sandbox-report',
      boundAt: '2026-07-26T20:00:00.000Z',
    })
    store.save(reference)
    state.close()

    const reopened = new GatewayState(path)
    const reopenedStore = new CodexThreadReferenceStore(reopened.rawDbHandle)
    expect(reopenedStore.load(thread.id)).toEqual(reference)
    const columns = reopened.rawDbHandle.prepare(
      'PRAGMA table_info(codex_thread_references)',
    ).all() as Array<{ name: string }>
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        'email',
        'token',
        'prompt',
        'output',
        'credential',
        'metadata_json',
      ]),
    )
    await expect(reopened.deleteThread(thread.id)).resolves.toBe(true)
    expect(reopenedStore.load(thread.id)).toBeUndefined()
    reopened.close()
  })

  it('uses revision CAS so a stale process cannot overwrite active recovery state', async () => {
    const { state } = await database()
    const thread = await state.createThread('test')
    const store = new CodexThreadReferenceStore(state.rawDbHandle)
    const initial = createCodexThreadReference({
      localThreadId: thread.id,
      remoteThreadId: 'remote-thread-1',
      accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
      model: 'gpt-5.4',
      modelProvider: 'openai',
      profileReportId: 'profile-report',
      sandboxReportId: 'sandbox-report',
      boundAt: '2026-07-26T20:00:00.000Z',
    })
    store.save(initial)
    const winner = beginCodexThreadTurn(initial, {
      id: 'turn-winner',
      startedAt: '2026-07-26T20:01:00.000Z',
    })
    const stale = beginCodexThreadTurn(initial, {
      id: 'turn-stale',
      startedAt: '2026-07-26T20:01:01.000Z',
    })

    store.save(winner)
    expect(() => store.save(stale)).toThrowError(
      expect.objectContaining({ code: 'stale_write' }),
    )
    expect(store.load(thread.id)?.activeTurn?.id).toBe('turn-winner')
    state.close()
  })

  it('rejects invalid references without echoing data-layer failures', async () => {
    const { state } = await database()
    const store = new CodexThreadReferenceStore(state.rawDbHandle)

    expect(() => store.save({
      localThreadId: 'missing',
      accessToken: 'private-token',
    })).toThrowError(expect.objectContaining({
      name: 'CodexThreadReferenceStoreError',
      code: 'invalid_reference',
    }))
    expect(new CodexThreadReferenceStoreError('write_failed').message).toBe(
      'Codex thread reference store failed (write_failed).',
    )
    state.close()
  })
})
