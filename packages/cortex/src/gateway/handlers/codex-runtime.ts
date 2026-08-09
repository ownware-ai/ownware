import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  CodexAppServerError,
  CodexProcessError,
  SUPPORTED_CODEX_VERSION_RANGE,
} from '../../runtime/codex/app-server-client.js'
import {
  CodexAccountProtocolError,
  CodexAccountUnavailableError,
} from '../../runtime/codex/account.js'
import {
  CodexControlPlaneInputError,
  type CodexRuntimeControlPlane,
} from '../../runtime/codex/control-plane.js'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import { readJSON, sendError, sendJSON } from '../router.js'

const StartLoginSchema = z.object({
  kind: z.enum(['browser', 'device']),
}).strict()

const WaitLoginSchema = z.object({
  timeoutMs: z.number().int().min(0).max(25_000).optional(),
}).strict()

const EmptyBodySchema = z.object({}).strict()

export function createCodexRuntimeHandlers(options: {
  readonly controlPlane: CodexRuntimeControlPlane
  readonly authEnabled: boolean
}) {
  async function status(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    await handle(res, () => options.controlPlane.status())
  }

  async function startLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    const body = await parseBody(req, res, StartLoginSchema)
    if (body === null) return
    await handle(res, () => options.controlPlane.startLogin(body.kind))
  }

  async function waitLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    const body = await parseBody(req, res, WaitLoginSchema)
    if (body === null) return
    await handle(res, () => options.controlPlane.waitForLogin(body.timeoutMs))
  }

  async function cancelLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    if (await parseBody(req, res, EmptyBodySchema) === null) return
    await handle(res, () => options.controlPlane.cancelLogin())
  }

  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    if (await parseBody(req, res, EmptyBodySchema) === null) return
    await handle(res, () => options.controlPlane.logout())
  }

  async function models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!ownerOnly(req, res, options.authEnabled)) return
    await handle(res, () => options.controlPlane.models())
  }

  return { status, startLogin, waitLogin, cancelLogin, logout, models }
}

function ownerOnly(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
): boolean {
  res.setHeader('Cache-Control', 'no-store')
  const principal = getRequestPrincipal(req)
  if (
    (authEnabled && principal?.kind !== 'owner')
    || principal?.kind === 'delegated'
  ) {
    sendError(
      res,
      403,
      'Only the install owner can manage the Codex runtime.',
      'owner_required',
      'auth',
    )
    return false
  }
  return true
}

async function parseBody<T extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: T,
): Promise<z.infer<T> | null> {
  let raw: unknown
  try {
    raw = await readJSON(req)
  } catch {
    sendError(res, 400, 'Codex runtime request body is invalid.',
      'codex_request_invalid', 'invalid_request')
    return null
  }
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    sendError(res, 400, 'Codex runtime request body is invalid.',
      'codex_request_invalid', 'invalid_request')
    return null
  }
  return parsed.data
}

async function handle(
  res: ServerResponse,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    sendJSON(res, 200, await action())
  } catch (error) {
    if (error instanceof CodexProcessError) {
      if (error.code === 'incompatible_version') {
        sendError(
          res,
          409,
          'The installed Codex version is not supported by this Ownware build.',
          'codex_version_unsupported',
          'config',
          { supportedVersionRange: SUPPORTED_CODEX_VERSION_RANGE },
        )
        return
      }
      if (error.code === 'binary_not_found' || error.code === 'version_probe_failed') {
        sendError(
          res,
          503,
          'A compatible Codex CLI is not available.',
          'codex_binary_unavailable',
          'config',
          { supportedVersionRange: SUPPORTED_CODEX_VERSION_RANGE },
        )
        return
      }
      sendError(res, 503, 'The Codex runtime is unavailable.',
        'codex_runtime_unavailable', 'overload')
      return
    }
    if (error instanceof CodexControlPlaneInputError) {
      sendError(
        res,
        error.code === 'invalid_wait' ? 400 : 503,
        error.code === 'invalid_wait'
          ? 'Codex login wait is invalid.'
          : 'The Codex runtime is closed.',
        error.code === 'invalid_wait'
          ? 'codex_request_invalid'
          : 'codex_runtime_unavailable',
        error.code === 'invalid_wait' ? 'invalid_request' : 'overload',
      )
      return
    }
    if (error instanceof CodexAccountUnavailableError) {
      sendError(res, 409, 'ChatGPT subscription access is not available.',
        `codex_${error.code}`, 'config')
      return
    }
    if (error instanceof CodexAccountProtocolError) {
      const conflict = error.code === 'login_in_progress'
        || error.code === 'no_login_in_progress'
      sendError(
        res,
        conflict ? 409 : 502,
        conflict
          ? 'The Codex login state does not allow this action.'
          : 'The Codex account response could not be verified.',
        conflict ? `codex_${error.code}` : 'codex_account_protocol_invalid',
        conflict ? 'invalid_request' : 'connector_vendor',
      )
      return
    }
    if (error instanceof CodexAppServerError) {
      sendError(res, 502, 'The Codex runtime rejected the account operation.',
        'codex_account_operation_rejected', 'connector_vendor')
      return
    }
    throw error
  }
}
