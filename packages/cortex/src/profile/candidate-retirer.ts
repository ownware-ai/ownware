import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CandidateStore } from '../gateway/candidate-store.js'

export interface CandidateDeletionResult {
  readonly candidateId: string
  readonly profileId: string
  readonly state: 'deleted' | 'delete_failed'
  readonly deleted: boolean
  readonly idempotent: boolean
  readonly code: string | null
}

export class CandidateDeleteRejected extends Error {
  constructor(readonly code:
    | 'candidate_delete_not_found'
    | 'candidate_scope_mismatch'
    | 'candidate_delete_not_ready'
    | 'candidate_delete_active'
    | 'candidate_delete_in_use'
    | 'candidate_delete_rollback_retained'
    | 'candidate_delete_in_progress') {
    super(code)
    this.name = 'CandidateDeleteRejected'
  }
}

export class CandidateRetirer {
  private readonly removeDirectory: (path: string) => Promise<void>
  private readonly pathExists: (path: string) => Promise<boolean>

  constructor(private readonly options: {
    readonly candidatesRoot: string
    readonly store: CandidateStore
    readonly removeDirectory?: (path: string) => Promise<void>
    readonly pathExists?: (path: string) => Promise<boolean>
  }) {
    this.removeDirectory = options.removeDirectory ??
      ((path) => rm(path, { recursive: true, force: true }))
    this.pathExists = options.pathExists ?? (async (path) => {
      try {
        await stat(path)
        return true
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    })
  }

  async delete(input: {
    readonly profileId: string
    readonly candidateId: string
  }): Promise<CandidateDeletionResult> {
    const claim = this.options.store.beginDeletion(input)
    if (claim.status === 'already_deleted') {
      return {
        ...input,
        state: 'deleted',
        deleted: true,
        idempotent: true,
        code: null,
      }
    }
    if (claim.status !== 'started') throw deletionRejected(claim.status)

    const directory = join(
      this.options.candidatesRoot,
      input.candidateId.slice('sha256:'.length),
    )
    try {
      await this.removeDirectory(directory)
    } catch {
      // Verification below decides actual state. A remove call can report an
      // error after the directory has already disappeared.
    }

    let exists = true
    try {
      exists = await this.pathExists(directory)
    } catch {
      exists = true
    }
    if (exists) {
      this.options.store.markDeleteFailed(input.candidateId, 'candidate_delete_failed')
      return {
        ...input,
        state: 'delete_failed',
        deleted: false,
        idempotent: false,
        code: 'candidate_delete_failed',
      }
    }

    this.options.store.markDeleted(input.candidateId)
    return {
      ...input,
      state: 'deleted',
      deleted: true,
      idempotent: false,
      code: null,
    }
  }
}

function deletionRejected(
  status: Exclude<ReturnType<CandidateStore['beginDeletion']>['status'], 'started' | 'already_deleted'>,
): CandidateDeleteRejected {
  const codes = {
    not_found: 'candidate_delete_not_found',
    scope_mismatch: 'candidate_scope_mismatch',
    not_ready: 'candidate_delete_not_ready',
    active: 'candidate_delete_active',
    in_use: 'candidate_delete_in_use',
    rollback_retained: 'candidate_delete_rollback_retained',
    in_progress: 'candidate_delete_in_progress',
  } as const
  return new CandidateDeleteRejected(codes[status])
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
