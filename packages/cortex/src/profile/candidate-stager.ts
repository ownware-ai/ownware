import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CandidateRecord, CandidateState } from '../gateway/candidate-store.js'
import {
  validateProfileCandidate,
  type CandidateFinding,
  type ProfileCandidateValidation,
} from './candidate.js'

const CANDIDATE_ID = /^sha256:[0-9a-f]{64}$/

export interface CandidateStageStore {
  get(candidateId: string): CandidateRecord | null
  begin(input: {
    readonly candidateId: string
    readonly profileId: string
    readonly attemptId: string
    readonly fileCount: number
    readonly totalBytes: number
  }, now?: number): 'started' | 'ready' | 'in_progress'
  markReady(candidateId: string, attemptId: string, now?: number): void
  markFailed(
    candidateId: string,
    attemptId: string,
    state: Extract<CandidateState, 'placement_failed' | 'cleanup_failed'>,
    code: string,
    now?: number,
  ): void
  markCleanupFailed(candidateId: string, attemptId: string, now?: number): void
  markCleanupResolved(candidateId: string, attemptId: string, now?: number): void
}

export interface CandidateStageResult {
  readonly candidateId: string
  readonly profileName: string
  readonly state: Extract<CandidateState, 'ready' | 'placement_failed' | 'cleanup_failed'>
  readonly ready: boolean
  readonly idempotent: boolean
  readonly code: string | null
  readonly fileCount: number
  readonly totalBytes: number
}

type ValidatedCandidate = ProfileCandidateValidation & {
  readonly candidateId: string
  readonly profileName: string
  readonly fileCount: number
  readonly totalBytes: number
}

export class CandidateStageRejected extends Error {
  constructor(
    readonly code: 'candidate_identity_invalid' | 'candidate_invalid' |
      'candidate_identity_mismatch' | 'candidate_scope_mismatch' |
      'candidate_stage_in_progress' | 'candidate_storage_inconsistent',
    readonly findings: readonly CandidateFinding[] = [],
  ) {
    super(code)
    this.name = 'CandidateStageRejected'
  }
}

export interface CandidateStagerDependencies {
  readonly copyDirectory: (source: string, target: string) => Promise<void>
  readonly renameDirectory: (source: string, target: string) => Promise<void>
  readonly removeDirectory: (path: string) => Promise<void>
  readonly makeDirectory: (path: string) => Promise<void>
  readonly pathExists: (path: string) => Promise<boolean>
  readonly validateCandidate: typeof validateProfileCandidate
  readonly makeAttemptId: () => string
}

const DEFAULT_DEPENDENCIES: CandidateStagerDependencies = {
  copyDirectory: (source, target) => cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  }),
  renameDirectory: rename,
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
  makeDirectory: async (path) => { await mkdir(path, { recursive: true }) },
  pathExists: async (path) => {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  },
  validateCandidate: validateProfileCandidate,
  makeAttemptId: randomUUID,
}

export class CandidateStager {
  private readonly dependencies: CandidateStagerDependencies

  constructor(private readonly options: {
    readonly candidatesRoot: string
    readonly store: CandidateStageStore
    readonly dependencies?: Partial<CandidateStagerDependencies>
  }) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  }

  async stage(input: {
    readonly candidateDir: string
    readonly expectedCandidateId: string
    readonly profileId?: string
    readonly removeSourceAfterStage?: boolean
  }): Promise<CandidateStageResult> {
    if (!CANDIDATE_ID.test(input.expectedCandidateId)) {
      throw new CandidateStageRejected('candidate_identity_invalid')
    }

    const source = await this.dependencies.validateCandidate({ profileDir: input.candidateDir })
    if (!source.valid || source.candidateId === null || source.profileName === null ||
        source.fileCount === null || source.totalBytes === null) {
      throw new CandidateStageRejected('candidate_invalid', source.findings)
    }
    if (source.candidateId !== input.expectedCandidateId) {
      throw new CandidateStageRejected('candidate_identity_mismatch')
    }
    if (input.profileId !== undefined && source.profileName !== input.profileId) {
      throw new CandidateStageRejected('candidate_scope_mismatch')
    }
    const validated: ValidatedCandidate = {
      ...source,
      candidateId: source.candidateId,
      profileName: source.profileName,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes,
    }

    const target = join(this.options.candidatesRoot, input.expectedCandidateId.slice('sha256:'.length))
    const previous = this.options.store.get(input.expectedCandidateId)
    if (previous && previous.state !== 'ready' && previous.attemptId !== null) {
      const previousAttempt = join(this.options.candidatesRoot, '.incoming', previous.attemptId)
      try {
        await this.dependencies.removeDirectory(previousAttempt)
      } catch {
        this.options.store.markCleanupFailed(input.expectedCandidateId, previous.attemptId)
        return result(validated, 'cleanup_failed', 'cleanup_failed', true)
      }
      if (previous.state === 'cleanup_failed') {
        this.options.store.markCleanupResolved(input.expectedCandidateId, previous.attemptId)
      }
    }
    const attemptId = this.dependencies.makeAttemptId()
    const attempt = join(this.options.candidatesRoot, '.incoming', attemptId)
    const begin = this.options.store.begin({
      candidateId: input.expectedCandidateId,
      profileId: validated.profileName,
      attemptId,
      fileCount: validated.fileCount,
      totalBytes: validated.totalBytes,
    })

    if (begin === 'in_progress') throw new CandidateStageRejected('candidate_stage_in_progress')
    if (begin === 'ready') {
      const stored = await this.validateStored(target, input.expectedCandidateId, validated.profileName)
      if (!stored) throw new CandidateStageRejected('candidate_storage_inconsistent')
      return result(validated, 'ready', null, true)
    }

    try {
      await this.dependencies.makeDirectory(join(this.options.candidatesRoot, '.incoming'))
      await this.dependencies.copyDirectory(input.candidateDir, attempt)
      const placed = await this.validateStored(attempt, input.expectedCandidateId, validated.profileName)
      if (!placed) throw new Error('candidate placement verification failed')

      if (await this.dependencies.pathExists(target)) {
        const existing = await this.validateStored(target, input.expectedCandidateId, validated.profileName)
        if (!existing) throw new Error('candidate storage target conflict')
        await this.dependencies.removeDirectory(attempt)
      } else {
        await this.dependencies.renameDirectory(attempt, target)
      }

      if (input.removeSourceAfterStage === true) {
        try {
          await this.dependencies.removeDirectory(input.candidateDir)
        } catch {
          return await this.fail(
            validated,
            input.expectedCandidateId,
            attemptId,
            attempt,
            'source_cleanup_failed',
            input.candidateDir,
          )
        }
      }
      try {
        this.options.store.markReady(input.expectedCandidateId, attemptId)
      } catch {
        return await this.fail(
          validated,
          input.expectedCandidateId,
          attemptId,
          attempt,
          'metadata_write_failed',
          input.removeSourceAfterStage === true ? input.candidateDir : undefined,
        )
      }
      return result(validated, 'ready', null, false)
    } catch {
      return await this.fail(
        validated,
        input.expectedCandidateId,
        attemptId,
        attempt,
        'placement_failed',
        input.removeSourceAfterStage === true ? input.candidateDir : undefined,
      )
    }
  }

  private async validateStored(
    directory: string,
    candidateId: string,
    profileName: string,
  ): Promise<boolean> {
    const validation = await this.dependencies.validateCandidate({ profileDir: directory })
    return validation.valid && validation.candidateId === candidateId &&
      validation.profileName === profileName
  }

  private async fail(
    source: ValidatedCandidate,
    candidateId: string,
    attemptId: string,
    attempt: string,
    code: 'placement_failed' | 'metadata_write_failed' | 'source_cleanup_failed',
    sourceToRemove?: string,
  ): Promise<CandidateStageResult> {
    try {
      await this.dependencies.removeDirectory(attempt)
      if (sourceToRemove !== undefined) await this.dependencies.removeDirectory(sourceToRemove)
    } catch {
      this.options.store.markFailed(candidateId, attemptId, 'cleanup_failed', 'cleanup_failed')
      return result(source, 'cleanup_failed', 'cleanup_failed', false)
    }
    this.options.store.markFailed(candidateId, attemptId, 'placement_failed', code)
    return result(source, 'placement_failed', code, false)
  }
}

function result(
  source: ValidatedCandidate,
  state: CandidateStageResult['state'],
  code: string | null,
  idempotent: boolean,
): CandidateStageResult {
  return {
    candidateId: source.candidateId,
    profileName: source.profileName,
    state,
    ready: state === 'ready',
    idempotent,
    code,
    fileCount: source.fileCount,
    totalBytes: source.totalBytes,
  }
}
