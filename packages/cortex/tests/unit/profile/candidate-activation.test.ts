import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'
import { validateProfileCandidate } from '../../../src/profile/candidate.js'
import {
  CandidateActivationRejected,
  CandidateActivator,
  CandidateDeploymentManager,
  CandidateDeploymentRejected,
  CandidateProfileResolver,
} from '../../../src/profile/candidate-activation.js'

describe('candidate activation', () => {
  let dir: string
  let candidatesRoot: string
  let database: CortexDatabase
  let store: CandidateStore
  let candidateId: string
  let candidateDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-activation-'))
    candidatesRoot = join(dir, 'candidates')
    const source = join(dir, 'source')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'agent.json'), '{"name":"portable","description":"candidate"}')
    const validation = await validateProfileCandidate({ profileDir: source })
    if (!validation.candidateId) throw new Error('candidate fixture invalid')
    candidateId = validation.candidateId
    candidateDir = join(candidatesRoot, candidateId.slice('sha256:'.length))
    await mkdir(candidatesRoot, { recursive: true })
    await import('node:fs/promises').then(({ cp }) => cp(source, candidateDir, { recursive: true }))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new CandidateStore(database.rawMainHandle)
    store.begin({
      candidateId,
      profileId: 'portable',
      attemptId: 'attempt-1',
      fileCount: validation.fileCount!,
      totalBytes: validation.totalBytes!,
    })
    store.markReady(candidateId, 'attempt-1')
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('verifies stored bytes immediately before compare-and-set activation', async () => {
    const resolver = new CandidateProfileResolver({ candidatesRoot, store })
    const activator = new CandidateActivator({ store, resolver })
    await expect(activator.activate({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })).resolves.toMatchObject({
      state: 'active',
      changed: true,
      candidateId,
      previousCandidateId: null,
      activeCandidateId: candidateId,
      deploymentRevision: 1,
      routingState: 'active',
      health: 'healthy',
      code: null,
    })
    await expect(resolver.resolve('portable')).resolves.toMatchObject({
      candidateId,
      profile: { config: { name: 'portable', description: 'candidate' } },
    })
  })

  it('rejects tampered stored bytes without changing active state', async () => {
    await writeFile(join(candidateDir, 'agent.json'), '{"name":"portable","description":"tampered"}')
    const activator = new CandidateActivator({
      store,
      resolver: new CandidateProfileResolver({ candidatesRoot, store }),
    })
    const error = await activator.activate({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CandidateActivationRejected)
    expect(error).toMatchObject({ code: 'candidate_storage_inconsistent' })
    expect(store.getActive('portable')).toBeNull()
  })

  it('reports the actual switched identity when post-switch refresh fails', async () => {
    const resolver = new CandidateProfileResolver({ candidatesRoot, store })
    const activator = new CandidateActivator({
      store,
      resolver,
      afterSwitch: async () => { throw new Error('injected refresh failure') },
    })
    await expect(activator.activate({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })).resolves.toMatchObject({
      state: 'activation_failed',
      changed: true,
      candidateId,
      activeCandidateId: candidateId,
      code: 'resolver_refresh_failed',
    })
    expect(store.getActive('portable')).toMatchObject({ candidateId })
  })

  it('returns a typed conflict with the actual active identity', async () => {
    store.compareAndSetActive({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })
    const activator = new CandidateActivator({
      store,
      resolver: new CandidateProfileResolver({ candidatesRoot, store }),
    })
    const error = await activator.activate({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CandidateActivationRejected)
    expect(error).toMatchObject({
      code: 'candidate_activation_conflict',
      activeCandidateId: candidateId,
    })
  })

  it('rolls back through the same verified compare-and-set and names post-switch failure', async () => {
    store.compareAndSetActive({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })
    const clean = new CandidateActivator({
      store,
      resolver: new CandidateProfileResolver({ candidatesRoot, store }),
    })
    await expect(clean.rollback({
      profileId: 'portable',
      candidateId,
      expectedActiveCandidateId: candidateId,
    })).resolves.toMatchObject({
      state: 'rolled_back',
      changed: false,
      activeCandidateId: candidateId,
      code: null,
    })

    const failing = new CandidateActivator({
      store,
      resolver: new CandidateProfileResolver({ candidatesRoot, store }),
      afterSwitch: async () => { throw new Error('injected rollback refresh failure') },
    })
    await expect(failing.rollback({
      profileId: 'portable',
      candidateId,
      expectedActiveCandidateId: candidateId,
    })).resolves.toMatchObject({
      state: 'rollback_failed',
      activeCandidateId: candidateId,
      code: 'resolver_refresh_failed',
    })
  })

  it('keeps a paused deployment closed when resume health verification fails', async () => {
    const resolver = new CandidateProfileResolver({ candidatesRoot, store })
    const activator = new CandidateActivator({ store, resolver })
    await activator.activate({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })
    const deployment = new CandidateDeploymentManager({
      store,
      resolver,
      activeRunCount: () => 2,
    })
    expect(deployment.pause({
      profileId: 'portable', expectedDeploymentRevision: 1,
    })).toMatchObject({
      state: 'paused', deploymentRevision: 2, activeRunCount: 2,
    })

    await writeFile(join(candidateDir, 'agent.json'), '{"name":"portable","description":"tampered"}')
    const error = await deployment.resume({
      profileId: 'portable', expectedDeploymentRevision: 2,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(CandidateDeploymentRejected)
    expect(error).toMatchObject({
      code: 'candidate_storage_inconsistent',
      actual: {
        candidateId,
        deploymentRevision: 2,
        routingState: 'paused',
        health: 'unhealthy',
      },
    })
  })
})
