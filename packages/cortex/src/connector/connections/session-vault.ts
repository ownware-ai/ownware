import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_DATA_DIR_NAME } from '../../constants.js'
import {
  CredentialVault,
  type CredentialBundle,
} from '../credentials/vault.js'

const HANDLE_PREFIX = 'connection-session.'
export const CONNECTION_SESSION_HANDLE_PATTERN =
  /^connection-session\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const CONNECTION_SESSION_MAX_TTL_MS = 10 * 60 * 1_000

const SCHEMA_VERSION = 'OWNWARE_CONNECTION_SESSION_SCHEMA_VERSION'
const CONNECTION_ID = 'OWNWARE_CONNECTION_SESSION_CONNECTION_ID'
const CONNECTOR_ID = 'OWNWARE_CONNECTION_SESSION_CONNECTOR_ID'
const SOURCE = 'OWNWARE_CONNECTION_SESSION_SOURCE'
const ENTITY_ID = 'OWNWARE_CONNECTION_SESSION_ENTITY_ID'
const AUTHORIZATION_URL = 'OWNWARE_CONNECTION_AUTHORIZATION_URL'
const LINK_TOKEN = 'OWNWARE_CONNECTION_LINK_TOKEN'
const EXPIRES_AT = 'OWNWARE_CONNECTION_EXPIRES_AT'
const SESSION_SCHEMA_VERSION = '1'

export interface ConnectionSessionScope {
  readonly connectionId: string
  readonly connectorId: string
  readonly source: string
  readonly entityId: string
}

export interface ConnectionSessionMaterial {
  readonly authorizationUrl: string
  readonly linkToken: string
  readonly expiresAt: number
}

export interface CreateConnectionSessionInput extends ConnectionSessionScope,
  ConnectionSessionMaterial {}

export type ConnectionSessionVaultErrorCode =
  | 'invalid_session'
  | 'cleanup_unverified'

export class ConnectionSessionVaultError extends Error {
  constructor(readonly code: ConnectionSessionVaultErrorCode) {
    super(code === 'invalid_session'
      ? 'Connection session material is invalid.'
      : 'Connection session cleanup could not be verified.')
    this.name = 'ConnectionSessionVaultError'
  }
}

export interface ConnectionSessionVaultPort {
  save(connectorId: string, env: Record<string, string>): Promise<void>
  load(connectorId: string): Promise<CredentialBundle | null>
  delete(connectorId: string): Promise<void>
}

export interface ConnectionSessionVaultOptions {
  readonly directory?: string
  readonly clock?: () => number
}

/**
 * Encrypted, short-lived connection continuation material.
 *
 * The only value safe to persist in ordinary connection metadata is the
 * random handle returned by {@link create}. Scope, vendor material and expiry
 * stay inside the encrypted vault envelope and are released only when every
 * expected scope field matches exactly.
 */
export class ConnectionSessionVault {
  private readonly vault: ConnectionSessionVaultPort
  private readonly directory: string | null
  private readonly clock: () => number

  constructor(options?: ConnectionSessionVaultOptions)
  /** Compatibility seam for focused handler tests that inject a temp vault. */
  constructor(vault?: ConnectionSessionVaultPort, clock?: () => number)
  constructor(
    optionsOrVault: ConnectionSessionVaultOptions | ConnectionSessionVaultPort = {},
    legacyClock: () => number = Date.now,
  ) {
    if (isVaultPort(optionsOrVault)) {
      this.vault = optionsOrVault
      this.directory = null
      this.clock = legacyClock
      return
    }
    this.directory = optionsOrVault.directory ?? defaultSessionDirectory()
    this.vault = new CredentialVault(this.directory)
    this.clock = optionsOrVault.clock ?? Date.now
  }

  async create(input: CreateConnectionSessionInput): Promise<string> {
    const now = this.clock()
    validateCreateInput(input, now)
    const handle = `${HANDLE_PREFIX}${randomUUID()}`
    await this.vault.save(handle, {
      [SCHEMA_VERSION]: SESSION_SCHEMA_VERSION,
      [CONNECTION_ID]: input.connectionId,
      [CONNECTOR_ID]: input.connectorId,
      [SOURCE]: input.source,
      [ENTITY_ID]: input.entityId,
      [AUTHORIZATION_URL]: input.authorizationUrl,
      [LINK_TOKEN]: input.linkToken,
      [EXPIRES_AT]: String(input.expiresAt),
    })
    return handle
  }

  async read(
    handle: string,
    expectedScope: ConnectionSessionScope,
  ): Promise<ConnectionSessionMaterial | null> {
    if (!validHandle(handle) || !validScope(expectedScope)) return null
    const bundle = await this.vault.load(handle)
    if (!bundle || bundle.connectorId !== handle) return null
    const session = parseSession(bundle.env)
    if (!session) return null
    if (session.expiresAt <= this.clock()) {
      await this.remove(handle)
      return null
    }
    if (!sameScope(session, expectedScope)) return null
    return {
      authorizationUrl: session.authorizationUrl,
      linkToken: session.linkToken,
      expiresAt: session.expiresAt,
    }
  }

  /** Idempotent deletion that succeeds only after absence is observed. */
  async remove(handle: string): Promise<void> {
    if (!validHandle(handle)) return
    await this.vault.delete(handle)
    if (!(await this.isAbsent(handle))) {
      throw new ConnectionSessionVaultError('cleanup_unverified')
    }
  }

  private async isAbsent(handle: string): Promise<boolean> {
    if (this.directory === null) {
      return await this.vault.load(handle) === null
    }
    try {
      await lstat(join(this.directory, `${handle}.json`))
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
}

export function connectionSessionHandle(
  metadata: Record<string, unknown> | null,
): string | null {
  const handle = metadata?.['sessionHandle']
  return typeof handle === 'string' && validHandle(handle) ? handle : null
}

interface StoredConnectionSession extends ConnectionSessionScope,
  ConnectionSessionMaterial {}

function parseSession(env: Record<string, string>): StoredConnectionSession | null {
  const expectedKeys = [
    AUTHORIZATION_URL,
    CONNECTION_ID,
    CONNECTOR_ID,
    ENTITY_ID,
    EXPIRES_AT,
    LINK_TOKEN,
    SCHEMA_VERSION,
    SOURCE,
  ].sort()
  if (Object.keys(env).sort().join('\0') !== expectedKeys.join('\0') ||
      env[SCHEMA_VERSION] !== SESSION_SCHEMA_VERSION) return null
  const candidate: StoredConnectionSession = {
    connectionId: env[CONNECTION_ID] ?? '',
    connectorId: env[CONNECTOR_ID] ?? '',
    source: env[SOURCE] ?? '',
    entityId: env[ENTITY_ID] ?? '',
    authorizationUrl: env[AUTHORIZATION_URL] ?? '',
    linkToken: env[LINK_TOKEN] ?? '',
    expiresAt: Number(env[EXPIRES_AT]),
  }
  return validStoredSession(candidate) ? candidate : null
}

function validateCreateInput(input: CreateConnectionSessionInput, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !validStoredSession(input) ||
      input.expiresAt <= now || input.expiresAt - now > CONNECTION_SESSION_MAX_TTL_MS) {
    throw new ConnectionSessionVaultError('invalid_session')
  }
}

function validStoredSession(value: StoredConnectionSession): boolean {
  if (!validScope(value) || !bounded(value.linkToken, 16_384) ||
      !bounded(value.authorizationUrl, 8_192) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) return false
  try {
    const url = new URL(value.authorizationUrl)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function validScope(scope: ConnectionSessionScope): boolean {
  return bounded(scope.connectionId, 512) && bounded(scope.connectorId, 256) &&
    bounded(scope.source, 64) && bounded(scope.entityId, 512)
}

function sameScope(a: ConnectionSessionScope, b: ConnectionSessionScope): boolean {
  return a.connectionId === b.connectionId && a.connectorId === b.connectorId &&
    a.source === b.source && a.entityId === b.entityId
}

function bounded(value: string, maxBytes: number): boolean {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)
}

function validHandle(handle: string): boolean {
  return CONNECTION_SESSION_HANDLE_PATTERN.test(handle)
}

function isVaultPort(value: ConnectionSessionVaultOptions | ConnectionSessionVaultPort):
  value is ConnectionSessionVaultPort {
  return typeof (value as ConnectionSessionVaultPort).save === 'function' &&
    typeof (value as ConnectionSessionVaultPort).load === 'function' &&
    typeof (value as ConnectionSessionVaultPort).delete === 'function'
}

function defaultSessionDirectory(): string {
  const dataDir = process.env['OWNWARE_DATA_DIR'] ?? join(homedir(), DEFAULT_DATA_DIR_NAME)
  return join(dataDir, 'connection-sessions')
}
