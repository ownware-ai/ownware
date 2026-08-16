/**
 * Dedicated opaque sensitive-input transport.
 *
 * Values are accepted only as bounded UTF-8 text/plain for one exact active
 * run/request pair. They are handed directly to the in-memory broker, never
 * decoded as JSON, logged, persisted, or returned.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RunRepository } from '../../storage/security-repositories.js'
import type { GatewayState } from '../state.js'
import { SENSITIVE_INPUT_MAX_BYTES } from '../types.js'
import { sendError, sendJSON } from '../router.js'
import {
  authorizePrincipalScope,
  getRequestPrincipal,
} from '../auth/scoped-principal.js'
import { principalContinuityKey } from '../idempotency.js'
import {
  SensitiveInputBrokerError,
  type SensitiveInputFailureCode,
} from '../sensitive-input-broker.js'

export function createSensitiveInputHandlers(
  state: GatewayState,
  runStore: RunRepository,
) {
  async function submit(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    noStore(res)
    const authority = await resolveAuthority(req, res, params)
    if (authority === null) return

    if (!isTextPlain(req.headers['content-type'])) {
      sendError(
        res,
        415,
        'Sensitive input requires Content-Type: text/plain; charset=utf-8.',
        'sensitive_input_content_type_invalid',
        'invalid_request',
      )
      return
    }

    let value: string
    try {
      value = await readBoundedUtf8(req, SENSITIVE_INPUT_MAX_BYTES)
    } catch (error) {
      const tooLarge = error instanceof SensitiveBodyError && error.kind === 'too-large'
      sendError(
        res,
        tooLarge ? 413 : 400,
        tooLarge
          ? 'Sensitive input exceeds the supported size limit.'
          : 'Sensitive input must be valid UTF-8.',
        tooLarge
          ? 'sensitive_input_too_large'
          : 'sensitive_input_utf8_invalid',
      )
      return
    }

    try {
      authority.broker.respond(authority.runId, authority.requestId, value)
    } catch (error) {
      sendBrokerError(res, error)
      return
    }
    sendJSON(res, 200, {
      runId: authority.runId,
      requestId: authority.requestId,
      accepted: true,
      status: 'provided',
    })
  }

  async function deny(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    noStore(res)
    const authority = await resolveAuthority(req, res, params)
    if (authority === null) return
    if (hasRequestBody(req)) {
      sendError(res, 400, 'The sensitive-input deny request must have an empty body.')
      return
    }
    if (!authority.broker.deny(authority.runId, authority.requestId)) {
      sendError(
        res,
        409,
        'The sensitive-input request is no longer pending.',
        'sensitive_input_request_not_pending',
      )
      return
    }
    sendJSON(res, 200, {
      runId: authority.runId,
      requestId: authority.requestId,
      accepted: true,
      status: 'denied',
    })
  }

  async function resolveAuthority(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) {
    const runId = params['runId']!
    const requestId = params['requestId']!
    const run = await runStore.get(runId)
    if (run === null) {
      sendError(res, 404, 'Run not found.', 'run_not_found')
      return null
    }
    if (
      !authorizePrincipalScope(req, {
        workspaceId: run.workspaceId ?? undefined,
        profileId: run.profileId,
      })
    ) {
      sendError(
        res,
        403,
        'Delegated principal does not allow this run.',
        'principal_scope_denied',
        'auth',
      )
      return null
    }
    const principal = getRequestPrincipal(req)
    if (
      principal?.kind === 'delegated'
      && !await state.securityRepositories.threadBindings.allows(
        run.threadId,
        principalContinuityKey(principal),
      )
    ) {
      sendError(
        res,
        403,
        'Delegated principal is not bound to this thread.',
        'principal_thread_denied',
        'auth',
      )
      return null
    }
    if (run.terminal || run.status === 'cancel_requested') {
      sendError(
        res,
        409,
        'The run is no longer accepting sensitive input.',
        'sensitive_input_run_inactive',
      )
      return null
    }
    const broker = state.getSessionCompanions(run.threadId)?.sensitiveInputBroker
    if (broker === undefined) {
      sendError(
        res,
        409,
        'Sensitive input is unavailable for this run.',
        'sensitive_input_unavailable',
      )
      return null
    }
    if (broker.getPending(runId, requestId) === undefined) {
      sendError(
        res,
        409,
        'The sensitive-input request is no longer pending.',
        'sensitive_input_request_not_pending',
      )
      return null
    }
    return { runId, requestId, broker }
  }

  return { submit, deny }
}

function noStore(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
}

function isTextPlain(value: string | undefined): boolean {
  if (value === undefined) return false
  const [mediaType, ...parameters] = value.split(';').map(part => part.trim().toLowerCase())
  if (mediaType !== 'text/plain') return false
  return parameters.every(parameter =>
    parameter === '' || parameter === 'charset=utf-8' || parameter === 'charset="utf-8"')
}

function hasRequestBody(req: IncomingMessage): boolean {
  const transferEncoding = req.headers['transfer-encoding']
  if (transferEncoding !== undefined) return true
  const contentLength = req.headers['content-length']
  if (contentLength === undefined) return false
  const parsed = Number(contentLength)
  return !Number.isSafeInteger(parsed) || parsed !== 0
}

class SensitiveBodyError extends Error {
  constructor(readonly kind: 'too-large' | 'invalid-utf8') {
    super(kind)
  }
}

function readBoundedUtf8(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength
      if (total > maxBytes) {
        chunks.length = 0
        if (!settled) {
          settled = true
          reject(new SensitiveBodyError('too-large'))
        }
        return
      }
      if (!settled) chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const value = decoder.decode(Buffer.concat(chunks))
        settled = true
        resolve(value)
      } catch {
        settled = true
        reject(new SensitiveBodyError('invalid-utf8'))
      }
    })
    req.on('error', () => {
      if (settled) return
      settled = true
      reject(new SensitiveBodyError('invalid-utf8'))
    })
  })
}

function sendBrokerError(res: ServerResponse, error: unknown): void {
  if (!(error instanceof SensitiveInputBrokerError)) {
    sendError(res, 500, 'Sensitive input could not be accepted.')
    return
  }
  const status = brokerErrorStatus(error.code)
  sendError(res, status, error.message, error.code)
}

function brokerErrorStatus(code: SensitiveInputFailureCode): number {
  switch (code) {
    case 'sensitive_input_value_invalid': return 400
    case 'sensitive_input_request_unknown':
    case 'sensitive_input_request_expired':
    case 'sensitive_input_run_inactive':
    case 'sensitive_input_request_duplicate':
    case 'sensitive_input_handle_collision':
    case 'sensitive_input_adapter_unsupported':
    case 'sensitive_input_handle_unknown':
      return 409
  }
}
