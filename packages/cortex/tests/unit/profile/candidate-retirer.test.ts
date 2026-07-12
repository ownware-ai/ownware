import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'
import {
  CandidateDeleteRejected,
  CandidateRetirer,
} from '../../../src/profile/candidate-retirer.js'

const CANDIDATE = `sha256:${'c'.repeat(64)}`

describe('candidate retirement', () => {
  let dir: string
  let candidatesRoot: string
  let candidateDir: string
  let database: CortexDatabase
  let store: CandidateStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-retirer-'))
    candidatesRoot = join(dir, 'candidates')
    candidateDir = join(candidatesRoot, CANDIDATE.slice('sha256:'.length))
    await mkdir(candidateDir, { recursive: true })
    await writeFile(join(candidateDir, 'agent.json'), '{"name":"portable"}')
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new CandidateStore(database.rawMainHandle)
    store.begin({
      candidateId: CANDIDATE, profileId: 'portable', attemptId: 'attempt-c',
      fileCount: 1, totalBytes: 19,
    })
    store.markReady(CANDIDATE, 'attempt-c')
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('deletes eligible bytes, verifies absence and replays the durable result', async () => {
    const retirer = new CandidateRetirer({ candidatesRoot, store })
    await expect(retirer.delete({
      profileId: 'portable', candidateId: CANDIDATE,
    })).resolves.toMatchObject({
      state: 'deleted', deleted: true, idempotent: false, code: null,
    })
    await expect(stat(candidateDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(retirer.delete({
      profileId: 'portable', candidateId: CANDIDATE,
    })).resolves.toMatchObject({
      state: 'deleted', deleted: true, idempotent: true, code: null,
    })
  })

  it('records a truthful partial failure and permits a verified retry', async () => {
    const failing = new CandidateRetirer({
      candidatesRoot,
      store,
      removeDirectory: async () => { throw new Error('injected remove failure') },
    })
    await expect(failing.delete({
      profileId: 'portable', candidateId: CANDIDATE,
    })).resolves.toMatchObject({
      state: 'delete_failed', deleted: false, code: 'candidate_delete_failed',
    })
    expect(store.getDeletion(CANDIDATE)).toMatchObject({ state: 'delete_failed' })
    const retry = new CandidateRetirer({ candidatesRoot, store })
    await expect(retry.delete({
      profileId: 'portable', candidateId: CANDIDATE,
    })).resolves.toMatchObject({ state: 'deleted', deleted: true })
  })

  it('rejects active candidates before touching bytes', async () => {
    store.compareAndSetActive({
      profileId: 'portable', candidateId: CANDIDATE, expectedActiveCandidateId: null,
    })
    const retirer = new CandidateRetirer({ candidatesRoot, store })
    const error = await retirer.delete({
      profileId: 'portable', candidateId: CANDIDATE,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CandidateDeleteRejected)
    expect(error).toMatchObject({ code: 'candidate_delete_active' })
    await expect(stat(candidateDir)).resolves.toBeDefined()
  })
})
