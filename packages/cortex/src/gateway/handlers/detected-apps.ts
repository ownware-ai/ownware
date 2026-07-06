/**
 * GET /api/v1/detected-apps — returns the rich list of apps the
 * gateway noticed installed on this machine (Spotlight, bridge
 * folder, Claude Desktop config, Claude Code settings + plugins).
 *
 * Phase 3a (2026-05-06) of the connector production rebuild.
 *
 * The client's `/tools` lobby fetches this to render "Found on your Mac"
 * hint cards, replacing the previous Electron-side scanner that
 * diverged from cortex's filter and let undeliverable rows leak.
 *
 * Read-only, single-tenant, machine-local: no auth gate beyond the
 * existing 127.0.0.1-only listen socket. Safe for the renderer to
 * call on every lobby open.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJSON } from '../router.js'
import { getDetectedApps } from '../../connector/detection/get-detected-apps.js'

export async function detectedAppsHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const apps = await getDetectedApps()
  sendJSON(res, 200, { detectedApps: apps })
}
