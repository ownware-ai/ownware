import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestPrincipal } from '../auth/scoped-principal.js'
import {
  ConnectionInventoryCursorNotFoundError,
  type ConnectionRow,
  type ConnectorConnectionsStore,
} from '../../connector/connections/store.js'
import { deriveLogicalKey } from '../../connector/logical-key.js'
import { ConnectorSourceSchema } from '../../connector/schema.js'
import { sendError, sendJSON } from '../router.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PUBLIC_CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEFAULT_LIMIT = 50
export const CONNECTION_LIST_MAX_LIMIT = 100

export function createConnectionInventoryHandler(options: {
  readonly connections: ConnectorConnectionsStore
  readonly entityId: string
  readonly authEnabled: boolean
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!requireOwner(req, res, options.authEnabled)) return
    const page = parsePage(req)
    if (!page) return invalid(res)

    try {
      const result = options.connections.listInventory(options.entityId, page)
      res.setHeader('Cache-Control', 'no-store')
      sendJSON(res, 200, {
        items: result.items.map(projectConnection),
        nextCursor: result.nextCursor,
        accessPolicy: 'separate_grant_required',
      })
    } catch (error) {
      if (error instanceof ConnectionInventoryCursorNotFoundError) return invalid(res)
      throw error
    }
  }
}

function requireOwner(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
): boolean {
  if (!authEnabled) {
    sendError(res, 409, 'Enable Gateway authentication before listing connections.',
      'auth_required', 'auth')
    return false
  }
  if (getRequestPrincipal(req)?.kind !== 'owner') {
    sendError(res, 403, 'Only the install owner can list connections.',
      'owner_required', 'auth')
    return false
  }
  return true
}

function parsePage(req: IncomingMessage): { limit: number; cursor?: string } | null {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if ([...url.searchParams.keys()].some((key) => key !== 'limit' && key !== 'cursor') ||
      url.searchParams.getAll('limit').length > 1 ||
      url.searchParams.getAll('cursor').length > 1) return null
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit)
  const cursor = url.searchParams.get('cursor')
  if (!Number.isInteger(limit) || limit < 1 || limit > CONNECTION_LIST_MAX_LIMIT ||
      (cursor !== null && !UUID.test(cursor))) return null
  return { limit, ...(cursor === null ? {} : { cursor }) }
}

function projectConnection(row: ConnectionRow & { publicConnectionId: string }) {
  const source = ConnectorSourceSchema.parse(row.source)
  if (source === 'builtin') {
    throw new Error('Connection inventory contains a non-external capability')
  }
  const capabilityId = deriveLogicalKey(source, row.connectorId)
  if (!PUBLIC_CAPABILITY_ID.test(capabilityId)) {
    throw new Error('Connection inventory contains an unsafe capability identity')
  }
  const changedAt = toSecond(row.completedAt ?? row.initiatedAt)

  if (row.status === 'pending') {
    if (row.completedAt !== null || row.terminalCause !== null) {
      throw new Error('Connection inventory contains inconsistent pending state')
    }
    return {
      connectionId: row.publicConnectionId,
      capabilityId,
      status: 'pending' as const,
      recovery: 'complete_connection' as const,
      changedAt,
      expiresAt: row.expiresAt === null ? null : toNextSecond(row.expiresAt),
      lastVerifiedAt: null,
    }
  }
  if (row.status === 'ready') {
    if (row.completedAt === null || row.terminalCause !== null) {
      throw new Error('Connection inventory contains inconsistent connected state')
    }
    return {
      connectionId: row.publicConnectionId,
      capabilityId,
      status: 'connected' as const,
      recovery: 'none' as const,
      changedAt,
      expiresAt: null,
      lastVerifiedAt: row.lastVerifiedAt === null ? null : toSecond(row.lastVerifiedAt),
    }
  }
  if (row.status === 'failed') {
    if (row.completedAt === null || row.terminalCause !== 'failed') {
      throw new Error('Connection inventory contains inconsistent failure state')
    }
    return {
      connectionId: row.publicConnectionId,
      capabilityId,
      status: 'failed' as const,
      recovery: 'reconnect' as const,
      changedAt,
      expiresAt: null,
      lastVerifiedAt: null,
    }
  }
  if (row.terminalCause === 'revocation_unconfirmed') {
    if (row.completedAt === null) {
      throw new Error('Connection inventory contains inconsistent revocation state')
    }
    return {
      connectionId: row.publicConnectionId,
      capabilityId,
      status: 'failed' as const,
      recovery: 'verify_revocation' as const,
      changedAt,
      expiresAt: null,
      lastVerifiedAt: null,
    }
  }
  if (row.completedAt === null || row.terminalCause !== 'timeout') {
    throw new Error('Connection inventory contains inconsistent expiry state')
  }
  return {
    connectionId: row.publicConnectionId,
    capabilityId,
    status: 'expired' as const,
    recovery: 'reconnect' as const,
    changedAt,
    expiresAt: null,
    lastVerifiedAt: null,
  }
}

function toSecond(value: number): number {
  return Math.floor(value / 1_000) * 1_000
}

function toNextSecond(value: number): number {
  return Math.ceil(value / 1_000) * 1_000
}

function invalid(res: ServerResponse): void {
  sendError(res, 400, 'Connection list request is invalid.',
    'connection_list_invalid', 'invalid_request')
}
