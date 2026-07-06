/**
 * Health, version, and connectivity handlers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { LOOM_VERSION } from '@ownware/loom'
import { sendJSON } from '../router.js'
import { CORTEX_VERSION } from '../../version.js'

const CONNECTIVITY_TIMEOUT_MS = 5_000

export async function healthHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJSON(res, 200, {
    status: 'ok',
    version: CORTEX_VERSION,
    uptime: Math.floor(process.uptime()),
  })
}

export async function appVersionHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJSON(res, 200, {
    version: CORTEX_VERSION,
    loomVersion: LOOM_VERSION,
    runtime: typeof (globalThis as any).Bun !== 'undefined' ? 'bun' : 'node',
    platform: process.platform,
  })
}

export async function connectivityHandler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const checks = [
    { provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages' },
    { provider: 'openai', url: 'https://api.openai.com/v1/models' },
    { provider: 'google', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  ]

  const results = await Promise.all(checks.map(async ({ provider, url }) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS)
    const start = Date.now()

    try {
      await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
      })
      return {
        provider,
        reachable: true,
        latencyMs: Date.now() - start,
        error: null,
      }
    } catch (err) {
      return {
        provider,
        reachable: false,
        latencyMs: null,
        error: err instanceof Error ? err.message : 'Connection failed',
      }
    } finally {
      clearTimeout(timeout)
    }
  }))

  sendJSON(res, 200, { providers: results })
}
