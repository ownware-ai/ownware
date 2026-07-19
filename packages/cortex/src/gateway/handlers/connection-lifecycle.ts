import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import { sendError } from '../router.js'

export function createConnectionLifecycleHandlers(options: {
  readonly authEnabled: boolean
}) {
  async function start(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requireOwner(req, res, options.authEnabled)) return
    sendError(
      res,
      404,
      'Connection capability is unavailable.',
      'connection_capability_unavailable',
      'not_found',
    )
  }

  return { start }
}

function requireOwner(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) {
    sendError(
      res,
      409,
      'Enable Gateway authentication before managing connections.',
      'auth_required',
      'auth',
    )
    return false
  }
  if (getRequestPrincipal(req)?.kind !== 'owner') {
    sendError(
      res,
      403,
      'Only the install owner can manage connections.',
      'owner_required',
      'auth',
    )
    return false
  }
  return true
}
