import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import {
  ThreadPrincipalBindingStore,
  threadPrincipalScopeDigest,
} from '../../../src/gateway/thread-principal-binding.js'

let dir: string
let state: GatewayState

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-thread-principal-'))
  state = new GatewayState(join(dir, 'ownware.db'))
})

afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

describe('ThreadPrincipalBindingStore', () => {
  it('persists only a domain-separated digest and survives restart', () => {
    const thread = state.createThread('mini')
    const principalKey = 'delegated\0client-a\0workspace-a\0mini\0support\0web\0subject-a'
    const store = new ThreadPrincipalBindingStore(state.rawDbHandle)

    expect(store.bind(thread.id, principalKey, 1_000)).toBe(true)
    expect(store.allows(thread.id, principalKey)).toBe(true)
    expect(store.allows(thread.id, `${principalKey}-other`)).toBe(false)

    const row = state.rawDbHandle.prepare(
      'SELECT principal_scope_digest FROM thread_principal_bindings WHERE thread_id = ?',
    ).get(thread.id) as { principal_scope_digest: string }
    expect(row.principal_scope_digest).toBe(threadPrincipalScopeDigest(principalKey))
    expect(JSON.stringify(row)).not.toContain('client-a')
    expect(JSON.stringify(row)).not.toContain('subject-a')

    state.close()
    state = new GatewayState(join(dir, 'ownware.db'))
    expect(new ThreadPrincipalBindingStore(state.rawDbHandle).allows(thread.id, principalKey)).toBe(true)
  })

  it('is idempotent for the same authority and refuses rebinding', () => {
    const thread = state.createThread('mini')
    const store = new ThreadPrincipalBindingStore(state.rawDbHandle)
    expect(store.bind(thread.id, 'scope-a')).toBe(true)
    expect(store.bind(thread.id, 'scope-a')).toBe(true)
    expect(store.bind(thread.id, 'scope-b')).toBe(false)
  })
})
