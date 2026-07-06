/**
 * POST /api/v1/connectors/:id/runtime-setup
 *
 * Triggers the one-time setup action for a `runtime_setup` connector
 * (browser login for LinkedIn, plugin install acknowledgement for Obsidian,
 * future "needs config edit" tools, etc.).
 *
 * Behaviour:
 *  - Looks up the connector. Must be `auth.mode === 'runtime_setup'`,
 *    else 422.
 *  - When `auth.command !== null`: spawns the command as a child process,
 *    waits for exit (with timeout), captures stderr tail. Exit 0 → success.
 *    Anything else → return error with stderr tail.
 *  - When `auth.command === null`: no spawn. Setup is manual (user did the
 *    plugin install / config edit elsewhere). Click is the acknowledgment.
 *  - On success: writes the `RUNTIME_SETUP_COMPLETED_KEY` marker to the
 *    connector's credential vault entry, recomputes status, emits SSE.
 *  - On failure: leaves the marker absent, returns 502 + stderr tail.
 *
 * No connector-specific code lives here. The handler only knows about the
 * variant shape (hint, command). Each entry's `command` is opaque data.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { sendJSON, sendError } from '../router.js'
import { credentialVault } from '../../connector/credentials/vault.js'
import { RUNTIME_SETUP_COMPLETED_KEY } from '../../connector/registry.js'
import type { ConnectorRegistry } from '../../connector/registry.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes — generous for browser login

export interface ConnectorRuntimeSetupDeps {
  readonly registry: ConnectorRegistry
  readonly statusBus?: ConnectorStatusBus
  /** Override timeout in tests. */
  readonly timeoutMs?: number
}

export function createConnectorRuntimeSetupHandler(deps: ConnectorRuntimeSetupDeps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async function runtimeSetup(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (id == null || id.length === 0) {
      sendError(res, 400, 'Missing :id path parameter')
      return
    }

    // Look up the connector. We accept both the bare server id and the
    // canonical id (`mcp:<id>`) — same tolerance as the rest of the gateway.
    const connector =
      (await deps.registry.getByCanonicalId(id)) ?? (await deps.registry.get(id))
    if (connector == null) {
      sendError(res, 404, `Connector "${id}" not found`)
      return
    }
    if (connector.auth.mode !== 'runtime_setup') {
      sendError(
        res,
        422,
        `Connector "${id}" is not a runtime-setup connector (auth.mode = ${connector.auth.mode})`,
      )
      return
    }

    const command = connector.auth.command

    // Manual-setup path: no spawn, just acknowledge.
    if (command === null) {
      await markCompleted(connector.id)
      emitReadyIfPossible(deps, connector.id)
      sendJSON(res, 200, { connectorId: connector.id, status: 'ready', mode: 'manual' })
      return
    }

    // Command-spawn path: run the setup, wait for exit.
    if (command.length === 0) {
      sendError(res, 422, `Connector "${id}" has an empty setup command`)
      return
    }

    const result = await runSetupCommand([...command], timeoutMs)
    if (!result.ok) {
      sendError(
        res,
        502,
        `Setup command failed (exit ${result.exitCode ?? 'signal'}): ${result.stderrTail}`,
      )
      return
    }

    await markCompleted(connector.id)
    emitReadyIfPossible(deps, connector.id)
    sendJSON(res, 200, {
      connectorId: connector.id,
      status: 'ready',
      mode: 'spawned',
      durationMs: result.durationMs,
    })
  }
}

async function markCompleted(connectorId: string): Promise<void> {
  const existing = await credentialVault.load(connectorId)
  const env = { ...(existing?.env ?? {}), [RUNTIME_SETUP_COMPLETED_KEY]: '1' }
  await credentialVault.save(connectorId, env)
}

function emitReadyIfPossible(deps: ConnectorRuntimeSetupDeps, connectorId: string): void {
  if (deps.statusBus == null) return
  deps.statusBus.emit({
    connectorId,
    source: 'mcp',
    status: 'ready',
    previousStatus: 'needs_setup',
    reason: 'Runtime setup completed',
  })
}

interface SpawnResult {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly stderrTail: string
  readonly durationMs: number
}

function runSetupCommand(argv: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const start = Date.now()
    const cmd = argv[0]
    const args = argv.slice(1)
    if (cmd == null) {
      resolve({ ok: false, exitCode: null, stderrTail: 'Empty argv', durationMs: 0 })
      return
    }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stderrChunks: Buffer[] = []
    let stderrLen = 0
    const STDERR_CAP = 8 * 1024
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen >= STDERR_CAP) return
      stderrChunks.push(chunk)
      stderrLen += chunk.length
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').slice(-1024)
      resolve({
        ok: code === 0,
        exitCode: code,
        stderrTail: stderrText.length > 0 ? stderrText : signal != null ? `signal: ${signal}` : '',
        durationMs: Date.now() - start,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        exitCode: null,
        stderrTail: err.message,
        durationMs: Date.now() - start,
      })
    })
  })
}
