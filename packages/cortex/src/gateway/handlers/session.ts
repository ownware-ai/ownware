/**
 * Session state handlers — crash recovery and session persistence.
 *
 * GET  /api/v1/session/state   — read persisted session state
 * POST /api/v1/session/restore — restore a saved session
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON } from '../router.js'
import type { GatewayState } from '../state.js'

export function createSessionHandlers(state: GatewayState) {

  // GET /api/v1/session/state
  async function getState(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const saved = state.getSessionState()
    if (!saved) {
      sendJSON(res, 200, { hasSession: false })
      return
    }
    sendJSON(res, 200, saved)
  }

  // POST /api/v1/session/restore
  async function restore(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const result = state.restoreSession()
    sendJSON(res, 200, {
      restored: true,
      workspaceCount: result.workspaceCount,
      tabCount: result.tabCount,
    })
  }

  return { getState, restore }
}
