import {
  parseCodexThreadReference,
  type CodexThreadReference,
} from './official-thread.js'

export interface CodexThreadLifecycleClient {
  request(method: string, params: unknown): Promise<unknown>
}

export type CodexThreadLifecycleErrorCode =
  | 'active_turn_unresolved'
  | 'invalid_response'
  | 'request_rejected'

export class CodexThreadLifecycleError extends Error {
  public override readonly name = 'CodexThreadLifecycleError'

  constructor(readonly code: CodexThreadLifecycleErrorCode) {
    super(`Codex thread lifecycle failed (${code}).`)
  }
}

export type CodexThreadInspection =
  | {
      readonly status: 'available'
      readonly remoteThreadId: string
    }
  | {
      /**
       * The read RPC failed. This does not claim the thread is missing:
       * app-server error codes do not provide that semantic authority.
       */
      readonly status: 'unavailable'
      readonly remoteThreadId: string
    }
  | {
      readonly status: 'invalid_response'
      readonly remoteThreadId: string
    }

export interface CodexThreadLifecycleResult {
  readonly status: 'archived' | 'deleted'
  readonly remoteThreadId: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isEmptyResponse(value: unknown): boolean {
  const response = asRecord(value)
  return response !== null && Object.keys(response).length === 0
}

/**
 * Exact remote lifecycle RPCs for the pinned app-server schema.
 *
 * Local thread deletion remains the gateway's authority and cascades the
 * safe reference row. This class only establishes whether the corresponding
 * remote request was acknowledged; it never mutates local state itself.
 */
export class CodexThreadLifecycleService {
  constructor(private readonly client: CodexThreadLifecycleClient) {}

  async inspect(input: unknown): Promise<CodexThreadInspection> {
    const reference = parseCodexThreadReference(input)
    let response: unknown
    try {
      response = await this.client.request('thread/read', {
        threadId: reference.remoteThreadId,
        includeTurns: false,
      })
    } catch {
      return {
        status: 'unavailable',
        remoteThreadId: reference.remoteThreadId,
      }
    }

    const envelope = asRecord(response)
    const thread = asRecord(envelope?.['thread'])
    if (
      envelope == null
      || thread == null
      || thread['id'] !== reference.remoteThreadId
      || thread['modelProvider'] !== reference.modelProvider
      || !Array.isArray(thread['turns'])
    ) {
      return {
        status: 'invalid_response',
        remoteThreadId: reference.remoteThreadId,
      }
    }
    return {
      status: 'available',
      remoteThreadId: reference.remoteThreadId,
    }
  }

  archive(input: unknown): Promise<CodexThreadLifecycleResult> {
    return this.mutate('thread/archive', 'archived', input)
  }

  delete(input: unknown): Promise<CodexThreadLifecycleResult> {
    return this.mutate('thread/delete', 'deleted', input)
  }

  private async mutate(
    method: 'thread/archive' | 'thread/delete',
    status: CodexThreadLifecycleResult['status'],
    input: unknown,
  ): Promise<CodexThreadLifecycleResult> {
    const reference: CodexThreadReference = parseCodexThreadReference(input)
    if (reference.activeTurn != null) {
      throw new CodexThreadLifecycleError('active_turn_unresolved')
    }

    let response: unknown
    try {
      response = await this.client.request(method, {
        threadId: reference.remoteThreadId,
      })
    } catch {
      throw new CodexThreadLifecycleError('request_rejected')
    }
    if (!isEmptyResponse(response)) {
      throw new CodexThreadLifecycleError('invalid_response')
    }
    return {
      status,
      remoteThreadId: reference.remoteThreadId,
    }
  }
}
