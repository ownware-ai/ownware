import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CandidateStore, DEPLOYMENT_HEALTH_FRESH_MS } from '../../../src/gateway/candidate-store.js'

const FIRST = `sha256:${'a'.repeat(64)}`
const SECOND = `sha256:${'b'.repeat(64)}`

describe('CandidateStore activation compare-and-set', () => {
  let dir: string
  let database: CortexDatabase
  let store: CandidateStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'candidate-activation-store-'))
    database = new CortexDatabase(join(dir, 'ownware.db'))
    store = new CandidateStore(database.rawMainHandle)
  })

  afterEach(async () => {
    database.close()
    await rm(dir, { recursive: true, force: true })
  })

  function ready(candidateId: string, profileId = 'portable'): void {
    const attemptId = `attempt-${candidateId.slice(-1)}`
    store.begin({ candidateId, profileId, attemptId, fileCount: 1, totalBytes: 20 })
    store.markReady(candidateId, attemptId)
  }

  it('activates a ready candidate only from the expected current identity', () => {
    ready(FIRST)
    ready(SECOND)
    expect(store.compareAndSetActive({
      profileId: 'portable',
      candidateId: FIRST,
      expectedActiveCandidateId: null,
    }, 100)).toMatchObject({
      status: 'activated', previousCandidateId: null, activeCandidateId: FIRST,
      deploymentRevision: 1, routingState: 'active', health: 'starting',
    })
    expect(store.getActive('portable')).toMatchObject({ candidateId: FIRST, updatedAt: 100 })

    expect(store.compareAndSetActive({
      profileId: 'portable',
      candidateId: SECOND,
      expectedActiveCandidateId: null,
    }, 110)).toMatchObject({
      status: 'conflict', previousCandidateId: FIRST, activeCandidateId: FIRST,
      deploymentRevision: 1, routingState: 'active',
    })
    expect(store.getActive('portable')).toMatchObject({ candidateId: FIRST, updatedAt: 100 })

    expect(store.compareAndSetActive({
      profileId: 'portable',
      candidateId: SECOND,
      expectedActiveCandidateId: FIRST,
    }, 120)).toMatchObject({
      status: 'activated', previousCandidateId: FIRST, activeCandidateId: SECOND,
      deploymentRevision: 2, routingState: 'active', health: 'starting',
    })
  })

  it('is idempotent when target and expected identity are already active', () => {
    ready(FIRST)
    store.compareAndSetActive({
      profileId: 'portable',
      candidateId: FIRST,
      expectedActiveCandidateId: null,
    }, 100)
    expect(store.compareAndSetActive({
      profileId: 'portable',
      candidateId: FIRST,
      expectedActiveCandidateId: FIRST,
    }, 110)).toMatchObject({
      status: 'unchanged', previousCandidateId: FIRST, activeCandidateId: FIRST,
      deploymentRevision: 1, routingState: 'active',
    })
    expect(store.getActive('portable')).toMatchObject({ updatedAt: 100 })
  })

  it('rejects missing, failed or wrong-profile candidates before mutation', () => {
    const failed = `sha256:${'c'.repeat(64)}`
    store.begin({
      candidateId: failed,
      profileId: 'portable',
      attemptId: 'failed-attempt',
      fileCount: 1,
      totalBytes: 20,
    })
    store.markFailed(failed, 'failed-attempt', 'placement_failed', 'placement_failed')
    ready(FIRST, 'other')

    expect(store.compareAndSetActive({
      profileId: 'portable', candidateId: SECOND, expectedActiveCandidateId: null,
    })).toMatchObject({ status: 'candidate_not_ready', activeCandidateId: null })
    expect(store.compareAndSetActive({
      profileId: 'portable', candidateId: failed, expectedActiveCandidateId: null,
    })).toMatchObject({ status: 'candidate_not_ready', activeCandidateId: null })
    expect(store.compareAndSetActive({
      profileId: 'portable', candidateId: FIRST, expectedActiveCandidateId: null,
    })).toMatchObject({ status: 'candidate_scope_mismatch', activeCandidateId: null })
    expect(store.getActive('portable')).toBeNull()
  })

  it('uses a monotonic revision to pause and resume without changing the active candidate', () => {
    ready(FIRST)
    store.compareAndSetActive({
      profileId: 'portable', candidateId: FIRST, expectedActiveCandidateId: null,
    }, 100)

    expect(store.compareAndSetRouting({
      profileId: 'portable', expectedRevision: 1, routingState: 'paused',
    }, 110)).toMatchObject({
      status: 'changed', activeCandidateId: FIRST, deploymentRevision: 2,
      routingState: 'paused',
    })
    expect(store.compareAndSetRouting({
      profileId: 'portable', expectedRevision: 1, routingState: 'active',
    }, 120)).toMatchObject({
      status: 'conflict', activeCandidateId: FIRST, deploymentRevision: 2,
      routingState: 'paused',
    })
    expect(store.compareAndSetRouting({
      profileId: 'portable', expectedRevision: 2, routingState: 'active',
    }, 130)).toMatchObject({
      status: 'changed', activeCandidateId: FIRST, deploymentRevision: 3,
      routingState: 'active',
    })
  })

  it('records only observed health for the still-active candidate', () => {
    ready(FIRST)
    ready(SECOND)
    store.compareAndSetActive({
      profileId: 'portable', candidateId: FIRST, expectedActiveCandidateId: null,
    }, 100)
    expect(store.recordHealth({
      profileId: 'portable', candidateId: SECOND, health: 'healthy', observedAt: 105,
    })).toBe(false)
    expect(store.recordHealth({
      profileId: 'portable', candidateId: FIRST, health: 'healthy', observedAt: 110,
    })).toBe(true)
    expect(store.getActive('portable', 110)).toMatchObject({
      candidateId: FIRST, health: 'healthy', healthObservedAt: 110,
    })
    expect(store.recordHealth({
      profileId: 'portable', candidateId: FIRST, health: 'unhealthy', observedAt: 109,
    })).toBe(false)
    expect(store.getActive('portable', 110 + DEPLOYMENT_HEALTH_FRESH_MS + 1)).toMatchObject({
      candidateId: FIRST, health: 'unknown', healthObservedAt: 110,
    })
  })

  it('retains the active and previous rollback candidate while allowing safe unused deletion', () => {
    const third = `sha256:${'c'.repeat(64)}`
    ready(FIRST)
    ready(SECOND)
    ready(third)
    store.compareAndSetActive({
      profileId: 'portable', candidateId: FIRST, expectedActiveCandidateId: null,
    }, 100)
    store.compareAndSetActive({
      profileId: 'portable', candidateId: SECOND, expectedActiveCandidateId: FIRST,
    }, 110)

    expect(store.beginDeletion({
      profileId: 'portable', candidateId: SECOND,
    }, 120)).toMatchObject({ status: 'active' })
    expect(store.beginDeletion({
      profileId: 'portable', candidateId: FIRST,
    }, 120)).toMatchObject({ status: 'rollback_retained' })
    expect(store.beginDeletion({
      profileId: 'portable', candidateId: third,
    }, 120)).toMatchObject({ status: 'started' })
    expect(store.beginDeletion({
      profileId: 'portable', candidateId: third,
    }, 121)).toMatchObject({ status: 'in_progress' })
    store.markDeleteFailed(third, 'candidate_delete_failed', 122)
    expect(store.beginDeletion({
      profileId: 'portable', candidateId: third,
    }, 123)).toMatchObject({ status: 'started' })
    store.markDeleted(third, 124)
    expect(store.beginDeletion({
      profileId: 'portable', candidateId: third,
    }, 125)).toMatchObject({ status: 'already_deleted' })
    expect(store.list('portable')).toHaveLength(3)
  })
})
