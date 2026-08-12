import { join } from 'node:path'
import type { DeploymentHealth, DeploymentRoutingState } from '../gateway/candidate-store.js'
import type { CandidateRepository } from '../storage/platform-repositories.js'
import { validateProfileCandidate } from './candidate.js'
import { loadProfile, type LoadedProfile } from './loader.js'

export interface ResolvedCandidateProfile {
  readonly candidateId: string
  readonly profile: LoadedProfile
}

export class CandidateActivationRejected extends Error {
  constructor(
    readonly code: 'candidate_not_ready' | 'candidate_scope_mismatch' |
      'candidate_storage_inconsistent' | 'candidate_activation_conflict',
    readonly activeCandidateId: string | null,
    readonly deploymentRevision: number | null = null,
  ) {
    super(code)
    this.name = 'CandidateActivationRejected'
  }
}

export class CandidateProfileResolver {
  constructor(private readonly options: {
    readonly candidatesRoot: string
    readonly store: CandidateRepository
  }) {}

  async resolve(profileId: string): Promise<ResolvedCandidateProfile | null> {
    const active = await this.options.store.getActive(profileId)
    if (!active) return null
    return this.resolveCandidate(profileId, active.candidateId)
  }

  async resolveCandidate(
    profileId: string,
    candidateId: string,
  ): Promise<ResolvedCandidateProfile> {
    const record = await this.options.store.get(candidateId)
    const activeId = (await this.options.store.getActive(profileId))?.candidateId ?? null
    if (!record || record.state !== 'ready') {
      throw new CandidateActivationRejected('candidate_not_ready', activeId)
    }
    if (record.profileId !== profileId) {
      throw new CandidateActivationRejected('candidate_scope_mismatch', activeId)
    }
    const directory = join(this.options.candidatesRoot, candidateId.slice('sha256:'.length))
    const validation = await validateProfileCandidate({ profileDir: directory })
    if (!validation.valid || validation.candidateId !== candidateId ||
        validation.profileName !== profileId) {
      throw new CandidateActivationRejected('candidate_storage_inconsistent', activeId)
    }
    return { candidateId, profile: await loadProfile(directory) }
  }

  invalidate(_profileId: string): void {
    // Resolution deliberately revalidates on every call; this hook gives the
    // activation transaction an explicit cache-refresh boundary if caching is
    // introduced later.
  }
}

export interface CandidateActivationResult {
  readonly state: 'active' | 'activation_failed'
  readonly changed: boolean
  readonly candidateId: string
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: DeploymentRoutingState
  readonly health: DeploymentHealth
  readonly healthObservedAt: number | null
  readonly code: string | null
}

export interface CandidateRollbackResult {
  readonly state: 'rolled_back' | 'rollback_failed'
  readonly changed: boolean
  readonly candidateId: string
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: DeploymentRoutingState
  readonly health: DeploymentHealth
  readonly healthObservedAt: number | null
  readonly code: string | null
}

export class CandidateActivator {
  constructor(private readonly options: {
    readonly store: CandidateRepository
    readonly resolver: CandidateProfileResolver
    readonly afterSwitch?: (profileId: string) => void | Promise<void>
  }) {}

  async activate(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly expectedActiveCandidateId: string | null
    readonly expectedDeploymentRevision?: number | null
  }): Promise<CandidateActivationResult> {
    await this.options.resolver.resolveCandidate(input.profileId, input.candidateId)
    const changed = await this.options.store.compareAndSetActive(input)
    if (changed.status === 'conflict') {
      throw new CandidateActivationRejected(
        'candidate_activation_conflict',
        changed.activeCandidateId,
        changed.deploymentRevision,
      )
    }
    if (changed.status === 'candidate_not_ready') {
      throw new CandidateActivationRejected(
        'candidate_not_ready',
        changed.activeCandidateId,
        changed.deploymentRevision,
      )
    }
    if (changed.status === 'candidate_scope_mismatch') {
      throw new CandidateActivationRejected(
        'candidate_scope_mismatch',
        changed.activeCandidateId,
        changed.deploymentRevision,
      )
    }
    const activeCandidateId = changed.activeCandidateId
    if (activeCandidateId === null) throw new Error('Activation did not produce an active candidate')

    try {
      this.options.resolver.invalidate(input.profileId)
      await this.options.afterSwitch?.(input.profileId)
    } catch {
      const observedAt = Date.now()
      await this.options.store.recordHealth({
        profileId: input.profileId,
        candidateId: activeCandidateId,
        health: 'degraded',
        observedAt,
      })
      const actual = (await this.options.store.getActive(input.profileId))!
      return {
        state: 'activation_failed',
        changed: changed.status === 'activated',
        candidateId: input.candidateId,
        previousCandidateId: changed.previousCandidateId,
        activeCandidateId,
        deploymentRevision: actual.deploymentRevision,
        routingState: actual.routingState,
        health: actual.health,
        healthObservedAt: actual.healthObservedAt,
        code: 'resolver_refresh_failed',
      }
    }
    const observedAt = Date.now()
    await this.options.store.recordHealth({
      profileId: input.profileId,
      candidateId: activeCandidateId,
      health: 'healthy',
      observedAt,
    })
    const actual = (await this.options.store.getActive(input.profileId))!
    return {
      state: 'active',
      changed: changed.status === 'activated',
      candidateId: input.candidateId,
      previousCandidateId: changed.previousCandidateId,
      activeCandidateId,
      deploymentRevision: actual.deploymentRevision,
      routingState: actual.routingState,
      health: actual.health,
      healthObservedAt: actual.healthObservedAt,
      code: null,
    }
  }

  async rollback(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly expectedActiveCandidateId: string | null
    readonly expectedDeploymentRevision?: number | null
  }): Promise<CandidateRollbackResult> {
    const result = await this.activate(input)
    return {
      ...result,
      state: result.state === 'active' ? 'rolled_back' : 'rollback_failed',
    }
  }
}

export interface CandidateDeploymentResult {
  readonly state: 'active' | 'paused'
  readonly changed: boolean
  readonly profileId: string
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: DeploymentRoutingState
  readonly health: DeploymentHealth
  readonly healthObservedAt: number | null
  readonly activeRunCount: number
}

export interface ProfileUndeploymentResult {
  readonly state: 'undeployed' | 'undeploy_failed'
  readonly changed: true
  readonly profileId: string
  readonly previousCandidateId: string
  readonly activeCandidateId: null
  readonly deploymentRevision: number
  readonly routingState: null
  readonly health: null
  readonly healthObservedAt: null
  readonly activeRunCount: 0
  readonly undeployedAt: number
  readonly code: 'resolver_refresh_failed' | null
}

export class CandidateUndeploymentRejected extends Error {
  constructor(
    readonly code: 'profile_not_deployed' | 'deployment_conflict' |
      'deployment_not_paused' | 'deployment_runs_active',
    readonly actual: Awaited<ReturnType<CandidateRepository['getDeploymentState']>>,
    readonly activeRunCount: number,
  ) {
    super(code)
    this.name = 'CandidateUndeploymentRejected'
  }
}

export class CandidateDeploymentRejected extends Error {
  constructor(
    readonly code: 'profile_not_deployed' | 'deployment_conflict' |
      'candidate_storage_inconsistent' | 'candidate_not_ready',
    readonly actual: Awaited<ReturnType<CandidateRepository['getActive']>>,
  ) {
    super(code)
    this.name = 'CandidateDeploymentRejected'
  }
}

export class CandidateDeploymentManager {
  constructor(private readonly options: {
    readonly store: CandidateRepository
    readonly resolver: CandidateProfileResolver
    readonly activeRunCount: (profileId: string) => number | Promise<number>
    readonly afterSwitch?: (profileId: string) => void | Promise<void>
  }) {}

  async pause(input: {
    readonly profileId: string
    readonly expectedDeploymentRevision: number
  }): Promise<CandidateDeploymentResult> {
    const transition = await this.options.store.compareAndSetRouting({
      profileId: input.profileId,
      expectedRevision: input.expectedDeploymentRevision,
      routingState: 'paused',
    })
    return this.toResult(input.profileId, transition)
  }

  async resume(input: {
    readonly profileId: string
    readonly expectedDeploymentRevision: number
  }): Promise<CandidateDeploymentResult> {
    const current = await this.options.store.getActive(input.profileId)
    if (!current) throw new CandidateDeploymentRejected('profile_not_deployed', null)
    if (current.deploymentRevision !== input.expectedDeploymentRevision) {
      throw new CandidateDeploymentRejected('deployment_conflict', current)
    }
    try {
      await this.options.resolver.resolveCandidate(input.profileId, current.candidateId)
    } catch (error) {
      if (error instanceof CandidateActivationRejected) {
        await this.options.store.recordHealth({
          profileId: input.profileId,
          candidateId: current.candidateId,
          health: 'unhealthy',
          observedAt: Date.now(),
        })
        const actual = await this.options.store.getActive(input.profileId)
        throw new CandidateDeploymentRejected(
          error.code === 'candidate_not_ready' ? 'candidate_not_ready' :
            'candidate_storage_inconsistent',
          actual,
        )
      }
      throw error
    }
    const transition = await this.options.store.compareAndSetRouting({
      profileId: input.profileId,
      expectedRevision: input.expectedDeploymentRevision,
      routingState: 'active',
    })
    const result = await this.toResult(input.profileId, transition)
    await this.options.store.recordHealth({
      profileId: input.profileId,
      candidateId: result.activeCandidateId,
      health: 'healthy',
      observedAt: Date.now(),
    })
    const actual = (await this.options.store.getActive(input.profileId))!
    return {
      ...result,
      health: actual.health,
      healthObservedAt: actual.healthObservedAt,
    }
  }

  async undeploy(input: {
    readonly profileId: string
    readonly expectedActiveCandidateId: string
    readonly expectedDeploymentRevision: number
  }): Promise<ProfileUndeploymentResult> {
    const transition = await this.options.store.compareAndSetUndeployed(input)
    if (transition.status !== 'undeployed') {
      const codes = {
        conflict: 'deployment_conflict',
        not_deployed: 'profile_not_deployed',
        not_paused: 'deployment_not_paused',
        active_runs: 'deployment_runs_active',
      } as const
      throw new CandidateUndeploymentRejected(
        codes[transition.status],
        await this.options.store.getDeploymentState(input.profileId),
        transition.activeRunCount,
      )
    }
    if (transition.previousCandidateId === null ||
        transition.deploymentRevision === null ||
        transition.undeployedAt === null) {
      throw new Error('Undeploy did not produce a durable tombstone')
    }
    let code: ProfileUndeploymentResult['code'] = null
    try {
      this.options.resolver.invalidate(input.profileId)
      await this.options.afterSwitch?.(input.profileId)
    } catch {
      code = 'resolver_refresh_failed'
    }
    return {
      state: code === null ? 'undeployed' : 'undeploy_failed',
      changed: true,
      profileId: input.profileId,
      previousCandidateId: transition.previousCandidateId,
      activeCandidateId: null,
      deploymentRevision: transition.deploymentRevision,
      routingState: null,
      health: null,
      healthObservedAt: null,
      activeRunCount: 0,
      undeployedAt: transition.undeployedAt,
      code,
    }
  }

  private async toResult(
    profileId: string,
    transition: Awaited<ReturnType<CandidateRepository['compareAndSetRouting']>>,
  ): Promise<CandidateDeploymentResult> {
    const actual = await this.options.store.getActive(profileId)
    if (transition.status === 'not_deployed' || !actual) {
      throw new CandidateDeploymentRejected('profile_not_deployed', actual)
    }
    if (transition.status === 'conflict') {
      throw new CandidateDeploymentRejected('deployment_conflict', actual)
    }
    return {
      state: actual.routingState,
      changed: transition.status === 'changed',
      profileId,
      activeCandidateId: actual.candidateId,
      deploymentRevision: actual.deploymentRevision,
      routingState: actual.routingState,
      health: actual.health,
      healthObservedAt: actual.healthObservedAt,
      activeRunCount: await this.options.activeRunCount(profileId),
    }
  }
}
