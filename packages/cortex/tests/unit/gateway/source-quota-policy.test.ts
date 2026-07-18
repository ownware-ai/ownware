import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import {
  SourceQuotaExceededError,
  SourceQuotaPolicy,
  type SourceQuotaLimits,
} from '../../../src/gateway/source-quota-policy.js'
import { SourceStore } from '../../../src/gateway/source-store.js'

const LIMITS: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 2,
    maxRetainedAndReservedBytes: 8,
    maxActiveUploadSessions: 2,
    maxNonterminalJobs: 2,
    maxDerivedResources: 2,
  },
  profile: {
    maxSourceRegistrations: 1,
    maxRetainedAndReservedBytes: 4,
    maxActiveUploadSessions: 1,
    maxNonterminalJobs: 1,
    maxDerivedResources: 1,
  },
}

let dir: string
let state: GatewayState

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'source-quota-policy-'))
  state = new GatewayState(join(dir, 'ownware.db'))
})

afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

describe('SourceQuotaPolicy', () => {
  it('enforces profile growth before the broader workspace ceiling', () => {
    const policy = new SourceQuotaPolicy(state.rawDbHandle, LIMITS)
    policy.assertCanGrow(
      { workspaceId: 'workspace-a', profileId: 'profile-a' },
      { sourceRegistrations: 1 },
    )
    createSource('workspace-a', 'profile-a')

    expect(() => policy.assertCanGrow(
      { workspaceId: 'workspace-a', profileId: 'profile-a' },
      { sourceRegistrations: 1 },
    )).toThrow(expect.objectContaining<Partial<SourceQuotaExceededError>>({
      resourceClass: 'source_registrations',
    }))
    expect(() => policy.assertCanGrow(
      { workspaceId: 'workspace-a', profileId: 'profile-b' },
      { sourceRegistrations: 1 },
    )).not.toThrow()
  })

  it('does not block non-growing recovery when an installation is already over limit', () => {
    createSource('workspace-a', 'profile-a')
    createSource('workspace-a', 'profile-a')
    const policy = new SourceQuotaPolicy(state.rawDbHandle, LIMITS)
    expect(() => policy.assertCanGrow(
      { workspaceId: 'workspace-a', profileId: 'profile-a' },
      {},
    )).not.toThrow()
  })
})

function createSource(workspaceId: string, profileId: string): void {
  new SourceStore(state.rawDbHandle).create({
    workspaceId,
    profileId,
    kind: 'file',
    label: 'Synthetic quota source',
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'audience.test',
    sensitivityPolicyRef: 'sensitivity.test',
    purposePolicyRef: 'purpose.test',
    retentionPolicyRef: 'retention.test',
    freshnessPolicyRef: 'freshness.test',
  })
}
