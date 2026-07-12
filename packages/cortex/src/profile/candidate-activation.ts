import { join } from 'node:path'
import type {
  CandidateStore,
  DeploymentHealth,
  DeploymentRoutingState,
} from '../gateway/candidate-store.js'
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
  ) {
    super(code)
    this.name = 'CandidateActivationRejected'
  }
}

export class CandidateProfileResolver {
  constructor(private readonly options: {
    readonly candidatesRoot: string
    readonly store: CandidateStore
  }) {}

  async resolve(profileId: string): Promise<ResolvedCandidateProfile | null> {
    const active = this.options.store.getActive(profileId)
    if (!active) return null
    return this.resolveCandidate(profileId, active.candidateId)
  }

  async resolveCandidate(
    profileId: string,
    candidateId: string,
  ): Promise<ResolvedCandidateProfile> {
    const record = this.options.store.get(candidateId)
    const activeId = this.options.store.getActive(profileId)?.candidateId ?? null
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
    readonly store: CandidateStore
    readonly resolver: CandidateProfileResolver
    readonly afterSwitch?: (profileId: string) => void | Promise<void>
  }) {}

  async activate(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly expectedActiveCandidateId: string | null
  }): Promise<CandidateActivationResult> {
    await this.options.resolver.resolveCandidate(input.profileId, input.candidateId)
    const changed = this.options.store.compareAndSetActive(input)
    if (changed.status === 'conflict') {
      throw new CandidateActivationRejected(
        'candidate_activation_conflict',
        changed.activeCandidateId,
      )
    }
    if (changed.status === 'candidate_not_ready') {
      throw new CandidateActivationRejected('candidate_not_ready', changed.activeCandidateId)
    }
    if (changed.status === 'candidate_scope_mismatch') {
      throw new CandidateActivationRejected('candidate_scope_mismatch', changed.activeCandidateId)
    }
    const activeCandidateId = changed.activeCandidateId
    if (activeCandidateId === null) throw new Error('Activation did not produce an active candidate')

    try {
      this.options.resolver.invalidate(input.profileId)
      await this.options.afterSwitch?.(input.profileId)
    } catch {
      const observedAt = Date.now()
      this.options.store.recordHealth({
        profileId: input.profileId,
        candidateId: activeCandidateId,
        health: 'degraded',
        observedAt,
      })
      const actual = this.options.store.getActive(input.profileId)!
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
    this.options.store.recordHealth({
      profileId: input.profileId,
      candidateId: activeCandidateId,
      health: 'healthy',
      observedAt,
    })
    const actual = this.options.store.getActive(input.profileId)!
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

export class CandidateDeploymentRejected extends Error {
  constructor(
    readonly code: 'profile_not_deployed' | 'deployment_conflict' |
      'candidate_storage_inconsistent' | 'candidate_not_ready',
    readonly actual: ReturnType<CandidateStore['getActive']>,
  ) {
    super(code)
    this.name = 'CandidateDeploymentRejected'
  }
}

export class CandidateDeploymentManager {
  constructor(private readonly options: {
    readonly store: CandidateStore
    readonly resolver: CandidateProfileResolver
    readonly activeRunCount: (profileId: string) => number
  }) {}

  pause(input: {
    readonly profileId: string
    readonly expectedDeploymentRevision: number
  }): CandidateDeploymentResult {
    const transition = this.options.store.compareAndSetRouting({
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
    const current = this.options.store.getActive(input.profileId)
    if (!current) throw new CandidateDeploymentRejected('profile_not_deployed', null)
    if (current.deploymentRevision !== input.expectedDeploymentRevision) {
      throw new CandidateDeploymentRejected('deployment_conflict', current)
    }
    try {
      await this.options.resolver.resolveCandidate(input.profileId, current.candidateId)
    } catch (error) {
      if (error instanceof CandidateActivationRejected) {
        this.options.store.recordHealth({
          profileId: input.profileId,
          candidateId: current.candidateId,
          health: 'unhealthy',
          observedAt: Date.now(),
        })
        const actual = this.options.store.getActive(input.profileId)
        throw new CandidateDeploymentRejected(
          error.code === 'candidate_not_ready' ? 'candidate_not_ready' :
            'candidate_storage_inconsistent',
          actual,
        )
      }
      throw error
    }
    const transition = this.options.store.compareAndSetRouting({
      profileId: input.profileId,
      expectedRevision: input.expectedDeploymentRevision,
      routingState: 'active',
    })
    const result = this.toResult(input.profileId, transition)
    this.options.store.recordHealth({
      profileId: input.profileId,
      candidateId: result.activeCandidateId,
      health: 'healthy',
      observedAt: Date.now(),
    })
    const actual = this.options.store.getActive(input.profileId)!
    return {
      ...result,
      health: actual.health,
      healthObservedAt: actual.healthObservedAt,
    }
  }

  private toResult(
    profileId: string,
    transition: ReturnType<CandidateStore['compareAndSetRouting']>,
  ): CandidateDeploymentResult {
    const actual = this.options.store.getActive(profileId)
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
      activeRunCount: this.options.activeRunCount(profileId),
    }
  }
}
