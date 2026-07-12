import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'

const ID = `sha256:${'a'.repeat(64)}`

describe('CandidateStore', () => {
  let dir: string
  let database: CortexDatabase
  let store: CandidateStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new CandidateStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('records placement before writes and transitions to ready', () => {
    expect(store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-1',
      fileCount: 2,
      totalBytes: 40,
    }, 100)).toBe('started')
    expect(store.get(ID)).toMatchObject({
      candidateId: ID,
      profileId: 'portable',
      state: 'placing',
      attemptId: 'attempt-1',
      fileCount: 2,
      totalBytes: 40,
      code: null,
      createdAt: 100,
      updatedAt: 100,
    })

    store.markReady(ID, 'attempt-1', 110)
    expect(store.get(ID)).toMatchObject({ state: 'ready', attemptId: null, updatedAt: 110 })
    expect(store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-2',
      fileCount: 2,
      totalBytes: 40,
    }, 120)).toBe('ready')
  })

  it('records explicit placement and cleanup failures and permits a retry', () => {
    store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-1',
      fileCount: 1,
      totalBytes: 20,
    }, 100)
    store.markFailed(ID, 'attempt-1', 'placement_failed', 'copy_failed', 110)
    expect(store.get(ID)).toMatchObject({ state: 'placement_failed', code: 'copy_failed' })

    expect(store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-2',
      fileCount: 1,
      totalBytes: 20,
    }, 120)).toBe('started')
    store.markFailed(ID, 'attempt-2', 'cleanup_failed', 'cleanup_failed', 130)
    expect(store.get(ID)).toMatchObject({
      state: 'cleanup_failed',
      attemptId: 'attempt-2',
      code: 'cleanup_failed',
    })
  })

  it('recovers interrupted placement as failed, never ready', () => {
    store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-1',
      fileCount: 1,
      totalBytes: 20,
    }, 100)
    expect(store.recoverInterrupted(200)).toBe(1)
    expect(store.get(ID)).toMatchObject({
      state: 'placement_failed',
      attemptId: 'attempt-1',
      code: 'gateway_restarted',
      updatedAt: 200,
    })
  })

  it('rejects the same identity being rebound to another profile', () => {
    store.begin({
      candidateId: ID,
      profileId: 'portable',
      attemptId: 'attempt-1',
      fileCount: 1,
      totalBytes: 20,
    })
    expect(() => store.begin({
      candidateId: ID,
      profileId: 'other',
      attemptId: 'attempt-2',
      fileCount: 1,
      totalBytes: 20,
    })).toThrow('Candidate identity metadata conflict')
  })
})
