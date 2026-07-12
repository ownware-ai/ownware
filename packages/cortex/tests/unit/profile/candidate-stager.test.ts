import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'
import { validateProfileCandidate } from '../../../src/profile/candidate.js'
import {
  CandidateStageRejected,
  CandidateStager,
  type CandidateStageStore,
} from '../../../src/profile/candidate-stager.js'

describe('CandidateStager', () => {
  let dir: string
  let source: string
  let candidatesRoot: string
  let profilesRoot: string
  let database: CortexDatabase
  let store: CandidateStore
  let candidateId: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-stager-'))
    source = join(dir, 'upload')
    candidatesRoot = join(dir, 'private-candidates')
    profilesRoot = join(dir, 'profiles')
    await mkdir(source, { recursive: true })
    await mkdir(profilesRoot, { recursive: true })
    await writeFile(join(source, 'agent.json'), '{"name":"portable"}')
    await writeFile(join(profilesRoot, 'active-marker'), 'known-good')
    const validation = await validateProfileCandidate({ profileDir: source })
    if (!validation.candidateId) throw new Error('fixture candidate did not validate')
    candidateId = validation.candidateId
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new CandidateStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('records first, revalidates placed bytes and becomes ready without touching active profiles', async () => {
    const result = await new CandidateStager({ candidatesRoot, store }).stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })

    expect(result).toMatchObject({
      candidateId,
      profileName: 'portable',
      state: 'ready',
      ready: true,
      code: null,
      fileCount: 1,
    })
    expect(store.get(candidateId)).toMatchObject({ state: 'ready', code: null })
    await expect(access(join(candidatesRoot, candidateId.slice('sha256:'.length), 'agent.json')))
      .resolves.toBeUndefined()
    await expect(writeFile(join(profilesRoot, 'active-marker'), 'known-good', { flag: 'wx' }))
      .rejects.toThrow()
  })

  it('is idempotent for the same ready identity after re-verifying stored bytes', async () => {
    const stager = new CandidateStager({ candidatesRoot, store })
    const input = { candidateDir: source, expectedCandidateId: candidateId, profileId: 'portable' }
    await expect(stager.stage(input)).resolves.toMatchObject({ state: 'ready', idempotent: false })
    await expect(stager.stage(input)).resolves.toMatchObject({ state: 'ready', idempotent: true })
  })

  it('rejects an expected identity or profile mismatch before recording or placement', async () => {
    const stager = new CandidateStager({ candidatesRoot, store })
    for (const input of [
      { candidateDir: source, expectedCandidateId: `sha256:${'b'.repeat(64)}`, profileId: 'portable' },
      { candidateDir: source, expectedCandidateId: candidateId, profileId: 'other' },
    ]) {
      const error = await stager.stage(input).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(CandidateStageRejected)
    }
    expect(store.get(candidateId)).toBeNull()
    await expect(access(candidatesRoot)).rejects.toThrow()
  })

  it('returns placement_failed and cleans the attempt after an injected copy failure', async () => {
    const stager = new CandidateStager({
      candidatesRoot,
      store,
      dependencies: { copyDirectory: async () => { throw new Error('injected copy failure') } },
    })
    await expect(stager.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({
      state: 'placement_failed',
      ready: false,
      code: 'placement_failed',
    })
    expect(store.get(candidateId)).toMatchObject({ state: 'placement_failed', code: 'placement_failed' })
  })

  it('returns cleanup_failed when a failed placement cannot remove its attempt', async () => {
    const stager = new CandidateStager({
      candidatesRoot,
      store,
      dependencies: {
        copyDirectory: async () => { throw new Error('injected copy failure') },
        removeDirectory: async () => { throw new Error('injected cleanup failure') },
      },
    })
    await expect(stager.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({
      state: 'cleanup_failed',
      ready: false,
      code: 'cleanup_failed',
    })
    expect(store.get(candidateId)).toMatchObject({ state: 'cleanup_failed', code: 'cleanup_failed' })
  })

  it('never becomes ready when the post-copy identity differs', async () => {
    let validations = 0
    const stager = new CandidateStager({
      candidatesRoot,
      store,
      dependencies: {
        validateCandidate: async (input) => {
          validations += 1
          const result = await validateProfileCandidate(input)
          return validations === 1 ? result : { ...result, candidateId: `sha256:${'c'.repeat(64)}` }
        },
      },
    })
    await expect(stager.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({ state: 'placement_failed', ready: false })
    expect(store.get(candidateId)).toMatchObject({ state: 'placement_failed' })
  })

  it('reports a metadata-write failure instead of treating placed bytes as ready', async () => {
    const failingStore: CandidateStageStore = {
      get: (id) => store.get(id),
      begin: (input, now) => store.begin(input, now),
      markReady: () => { throw new Error('injected metadata write failure') },
      markFailed: (id, attempt, state, code, now) => store.markFailed(id, attempt, state, code, now),
      markCleanupFailed: (id, attempt, now) => store.markCleanupFailed(id, attempt, now),
      markCleanupResolved: (id, attempt, now) => store.markCleanupResolved(id, attempt, now),
    }
    const stager = new CandidateStager({ candidatesRoot, store: failingStore })
    await expect(stager.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({
      state: 'placement_failed',
      ready: false,
      code: 'metadata_write_failed',
    })
    expect(store.get(candidateId)).toMatchObject({
      state: 'placement_failed',
      code: 'metadata_write_failed',
    })
  })

  it('reconciles a recorded leftover before retrying a cleanup-failed candidate', async () => {
    let removeCalls = 0
    const first = new CandidateStager({
      candidatesRoot,
      store,
      dependencies: {
        copyDirectory: async (_from, target) => {
          await mkdir(target, { recursive: true })
          throw new Error('injected partial copy')
        },
        removeDirectory: async (path) => {
          removeCalls += 1
          if (removeCalls === 1) throw new Error('injected first cleanup failure')
          await rm(path, { recursive: true, force: true })
        },
        makeAttemptId: () => 'first-attempt',
      },
    })
    await expect(first.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({ state: 'cleanup_failed' })
    await expect(access(join(candidatesRoot, '.incoming', 'first-attempt'))).resolves.toBeUndefined()

    const retry = new CandidateStager({ candidatesRoot, store })
    await expect(retry.stage({
      candidateDir: source,
      expectedCandidateId: candidateId,
      profileId: 'portable',
    })).resolves.toMatchObject({ state: 'ready', ready: true })
    await expect(access(join(candidatesRoot, '.incoming', 'first-attempt'))).rejects.toThrow()
  })
})
