import {
  completeCodexThreadTurn,
  parseCodexThreadReference,
  type CodexThreadReference,
} from './official-thread.js'

export interface CodexThreadRecoveryClient {
  request(method: string, params: unknown): Promise<unknown>
}

export type CodexThreadRecoveryErrorCode = 'persistence_failed'

export class CodexThreadRecoveryError extends Error {
  public override readonly name = 'CodexThreadRecoveryError'

  constructor(readonly code: CodexThreadRecoveryErrorCode) {
    super(`Codex thread recovery failed (${code}).`)
  }
}

export type CodexThreadRecoveryStatus =
  | 'not_required'
  | 'still_running'
  | 'history_unresolved'
  | 'read_unavailable'
  | 'invalid_response'
  | 'ready'
  | 'outcome_unknown'

export interface CodexThreadRecoveryResult {
  readonly status: CodexThreadRecoveryStatus
  readonly reference: CodexThreadReference
}

export interface CodexThreadRecoveryServiceOptions {
  readonly client: CodexThreadRecoveryClient
  readonly persistReference: (
    reference: CodexThreadReference,
  ) => void | Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

interface RecoveredTurn {
  readonly id: string
  readonly status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  readonly completedAt: number | null
}

function parseHistory(
  value: unknown,
  reference: CodexThreadReference,
): RecoveredTurn[] | null {
  const response = asRecord(value)
  const thread = asRecord(response?.['thread'])
  if (
    response == null
    || thread == null
    || thread['id'] !== reference.remoteThreadId
    || thread['modelProvider'] !== reference.modelProvider
    || !Array.isArray(thread['turns'])
  ) return null

  const matches: RecoveredTurn[] = []
  for (const value of thread['turns']) {
    const turn = asRecord(value)
    if (turn == null || turn['id'] !== reference.activeTurn?.id) continue
    const status = turn['status']
    const completedAt = turn['completedAt']
    if (
      status !== 'inProgress'
      && status !== 'completed'
      && status !== 'interrupted'
      && status !== 'failed'
    ) return null
    if (
      !(
        completedAt === null
        || (Number.isSafeInteger(completedAt) && (completedAt as number) >= 0)
      )
    ) return null
    if (
      status === 'inProgress'
        ? completedAt !== null
        : completedAt === null
    ) return null
    matches.push({
      id: turn['id'] as string,
      status,
      completedAt: completedAt as number | null,
    })
  }
  return matches
}

/**
 * Resolves the one narrow restart question that history can authoritatively
 * answer: whether the exact active provider turn reached a terminal state.
 *
 * Provider text/items are intentionally ignored and never retained here.
 * If an external effect may have occurred, terminal history closes the active
 * turn but keeps recovery blocked as `outcome_unknown`; it never licenses a
 * replay.
 */
export class CodexThreadRecoveryService {
  constructor(private readonly options: CodexThreadRecoveryServiceOptions) {}

  async recover(input: unknown): Promise<CodexThreadRecoveryResult> {
    const reference = parseCodexThreadReference(input)
    if (reference.activeTurn == null) {
      return { status: 'not_required', reference }
    }

    let response: unknown
    try {
      response = await this.options.client.request('thread/read', {
        threadId: reference.remoteThreadId,
        includeTurns: true,
      })
    } catch {
      return { status: 'read_unavailable', reference }
    }

    const matches = parseHistory(response, reference)
    if (matches == null) {
      return { status: 'invalid_response', reference }
    }
    if (matches.length !== 1) {
      return { status: 'history_unresolved', reference }
    }
    const [turn] = matches
    if (turn!.status === 'inProgress') {
      return { status: 'still_running', reference }
    }

    const outcomeKnown = (
      reference.activeTurn.consequence === 'none_observed'
      || reference.activeTurn.consequence === 'output_observed'
    )
    const recovered = completeCodexThreadTurn(reference, {
      id: turn!.id,
      status: turn!.status,
      completedAt: new Date(turn!.completedAt! * 1_000).toISOString(),
      authority: 'thread/read',
    }, outcomeKnown)

    try {
      await this.options.persistReference(recovered)
    } catch {
      throw new CodexThreadRecoveryError('persistence_failed')
    }
    return {
      status: recovered.recoveryState,
      reference: recovered,
    }
  }
}
