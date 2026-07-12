import { createHash, createSecretKey, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { SignJWT, jwtVerify } from 'jose'

const AUDIENCE = 'ownware.gateway.v1'
const KEY_DOMAIN = 'ownware.gateway.delegated-principal.hs256.v1\0'
const ISSUER_DOMAIN = 'ownware.gateway.delegated-principal.issuer.v1\0'
export const DEFAULT_TTL_SECONDS = 15 * 60
export const MAX_TTL_SECONDS = 60 * 60
const SAFE_SCOPE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SAFE_OPERATION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/

export interface DelegatedPrincipal {
  readonly kind: 'delegated'
  readonly tokenId: string
  readonly delegateId: string
  readonly workspaceId: string
  readonly profileId: string
  readonly purpose: string
  readonly channel?: string
  readonly operations: readonly string[]
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface OwnerPrincipal {
  readonly kind: 'owner'
}

export type RuntimePrincipal = OwnerPrincipal | DelegatedPrincipal

const requestPrincipals = new WeakMap<object, RuntimePrincipal>()

export function setRequestPrincipal(request: object, principal: RuntimePrincipal): void {
  requestPrincipals.set(request, principal)
}

export function getRequestPrincipal(request: object): RuntimePrincipal | undefined {
  return requestPrincipals.get(request)
}

export function authorizePrincipalScope(
  request: object,
  expected: { readonly workspaceId?: string; readonly profileId?: string },
): boolean {
  const principal = getRequestPrincipal(request)
  if (!principal || principal.kind === 'owner') return true
  return expected.workspaceId !== undefined && expected.profileId !== undefined &&
    principal.workspaceId === expected.workspaceId && principal.profileId === expected.profileId
}

export interface PrincipalIssueInput {
  readonly delegateId: string
  readonly workspaceId: string
  readonly profileId: string
  readonly purpose: string
  readonly channel?: string
  readonly operations: readonly string[]
  readonly ttlSeconds?: number
}

export class PrincipalAuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'PrincipalAuthError'
  }
}

interface PrincipalRow {
  readonly token_id: string
  readonly delegate_id: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly purpose: string
  readonly channel: string | null
  readonly operations_json: string
  readonly issued_at: number
  readonly expires_at: number
  readonly revoked_at: number | null
  readonly revoke_reason: string | null
}

export class DelegatedPrincipalStore {
  constructor(private readonly db: Database.Database) {}

  insert(principal: DelegatedPrincipal): void {
    this.db.prepare(`
      INSERT INTO delegated_principals (
        token_id, delegate_id, workspace_id, profile_id, purpose, channel,
        operations_json, issued_at, expires_at, revoked_at, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      principal.tokenId,
      principal.delegateId,
      principal.workspaceId,
      principal.profileId,
      principal.purpose,
      principal.channel ?? null,
      JSON.stringify(principal.operations),
      principal.issuedAt,
      principal.expiresAt,
    )
  }

  find(tokenId: string): (DelegatedPrincipal & { readonly revokedAt: number | null }) | null {
    const row = this.db.prepare(
      'SELECT * FROM delegated_principals WHERE token_id = ?',
    ).get(tokenId) as PrincipalRow | undefined
    if (!row) return null
    return {
      kind: 'delegated',
      tokenId: row.token_id,
      delegateId: row.delegate_id,
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      purpose: row.purpose,
      ...(row.channel !== null ? { channel: row.channel } : {}),
      operations: parseOperations(row.operations_json),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    }
  }

  revoke(tokenId: string, reason: string, revokedAt: number): boolean {
    if (!SAFE_PURPOSE.test(reason)) {
      throw new PrincipalAuthError('principal_scope_invalid', 'Invalid revocation reason')
    }
    const result = this.db.prepare(`
      UPDATE delegated_principals
      SET revoked_at = ?, revoke_reason = ?
      WHERE token_id = ? AND revoked_at IS NULL
    `).run(revokedAt, reason, tokenId)
    return result.changes === 1
  }
}

export class ScopedPrincipalService {
  private readonly key: ReturnType<typeof createSecretKey>
  private readonly issuer: string

  constructor(private readonly options: {
    readonly ownerToken: string
    readonly store: DelegatedPrincipalStore
  }) {
    if (!/^[0-9a-f]{64}$/.test(options.ownerToken)) {
      throw new PrincipalAuthError('principal_config_invalid', 'Owner token has an invalid shape')
    }
    this.key = createSecretKey(
      createHash('sha256').update(KEY_DOMAIN).update(options.ownerToken).digest(),
    )
    this.issuer = `ownware:${createHash('sha256')
      .update(ISSUER_DOMAIN)
      .update(options.ownerToken)
      .digest('hex')
      .slice(0, 32)}`
  }

  async issue(
    input: PrincipalIssueInput,
    nowMs: number = Date.now(),
  ): Promise<{ readonly token: string; readonly principal: DelegatedPrincipal }> {
    const canonical = validateIssueInput(input)
    const issuedAt = Math.floor(nowMs / 1000)
    const expiresAt = issuedAt + canonical.ttlSeconds
    const tokenId = randomUUID()
    const principal: DelegatedPrincipal = {
      kind: 'delegated',
      tokenId,
      delegateId: canonical.delegateId,
      workspaceId: canonical.workspaceId,
      profileId: canonical.profileId,
      purpose: canonical.purpose,
      ...(canonical.channel !== undefined ? { channel: canonical.channel } : {}),
      operations: canonical.operations,
      issuedAt,
      expiresAt,
    }

    const token = await new SignJWT({
      workspace_id: principal.workspaceId,
      profile_id: principal.profileId,
      purpose: principal.purpose,
      ...(principal.channel !== undefined ? { channel: principal.channel } : {}),
      operations: principal.operations,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setSubject(principal.delegateId)
      .setJti(principal.tokenId)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.key)

    this.options.store.insert(principal)
    return { token, principal }
  }

  async verify(token: string, nowMs: number = Date.now()): Promise<DelegatedPrincipal> {
    let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
    try {
      const verified = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: AUDIENCE,
        currentDate: new Date(nowMs),
      })
      payload = verified.payload
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ERR_JWT_EXPIRED') {
        throw new PrincipalAuthError('principal_expired', 'Delegated principal expired')
      }
      throw new PrincipalAuthError('principal_invalid', 'Delegated principal is invalid')
    }

    const tokenId = boundedClaim(payload.jti)
    const delegateId = boundedClaim(payload.sub)
    const workspaceId = boundedClaim(payload['workspace_id'])
    const profileId = boundedClaim(payload['profile_id'])
    const purpose = purposeClaim(payload['purpose'])
    const channel = payload['channel'] === undefined ? undefined : purposeClaim(payload['channel'])
    const operations = operationsClaim(payload['operations'])
    const issuedAt = integerClaim(payload.iat)
    const expiresAt = integerClaim(payload.exp)
    if (!tokenId || !delegateId || !workspaceId || !profileId || !purpose ||
        !operations || issuedAt === undefined || expiresAt === undefined) {
      throw new PrincipalAuthError('principal_invalid', 'Delegated principal claims are invalid')
    }

    const persisted = this.options.store.find(tokenId)
    if (!persisted || persisted.revokedAt !== null) {
      throw new PrincipalAuthError('principal_revoked', 'Delegated principal was revoked')
    }
    const principal: DelegatedPrincipal = {
      kind: 'delegated',
      tokenId,
      delegateId,
      workspaceId,
      profileId,
      purpose,
      ...(channel !== undefined ? { channel } : {}),
      operations,
      issuedAt,
      expiresAt,
    }
    if (!samePrincipal(principal, persisted)) {
      throw new PrincipalAuthError('principal_invalid', 'Delegated principal claims do not match issuance')
    }
    return principal
  }

  revoke(tokenId: string, reason: string, nowMs: number = Date.now()): boolean {
    return this.options.store.revoke(tokenId, reason, Math.floor(nowMs / 1000))
  }
}

function validateIssueInput(input: PrincipalIssueInput): PrincipalIssueInput & {
  readonly ttlSeconds: number
  readonly operations: readonly string[]
} {
  if (!SAFE_SCOPE_VALUE.test(input.delegateId) ||
      !SAFE_SCOPE_VALUE.test(input.workspaceId) ||
      !SAFE_SCOPE_VALUE.test(input.profileId) ||
      !SAFE_PURPOSE.test(input.purpose) ||
      (input.channel !== undefined && !SAFE_PURPOSE.test(input.channel))) {
    throw new PrincipalAuthError('principal_scope_invalid', 'Delegated principal scope is invalid')
  }
  const operations = [...new Set(input.operations)].sort()
  if (operations.length === 0 || operations.length > 32 ||
      operations.some((operation) => !SAFE_OPERATION.test(operation))) {
    throw new PrincipalAuthError('principal_scope_invalid', 'Delegated principal operations are invalid')
  }
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new PrincipalAuthError('principal_scope_invalid', 'Delegated principal lifetime is invalid')
  }
  return { ...input, operations, ttlSeconds }
}

function parseOperations(raw: string): readonly string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    const operations = operationsClaim(parsed)
    if (operations) return operations
  } catch {
    // Fall through to a fail-closed persistence error.
  }
  throw new PrincipalAuthError('principal_store_invalid', 'Stored delegated principal is invalid')
}

function boundedClaim(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_SCOPE_VALUE.test(value) ? value : undefined
}

function purposeClaim(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_PURPOSE.test(value) ? value : undefined
}

function operationsClaim(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32 ||
      value.some((entry) => typeof entry !== 'string' || !SAFE_OPERATION.test(entry))) {
    return undefined
  }
  const operations = [...new Set(value as string[])].sort()
  return operations.length === value.length ? operations : undefined
}

function integerClaim(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function samePrincipal(a: DelegatedPrincipal, b: DelegatedPrincipal): boolean {
  return a.tokenId === b.tokenId && a.delegateId === b.delegateId &&
    a.workspaceId === b.workspaceId && a.profileId === b.profileId &&
    a.purpose === b.purpose && a.channel === b.channel &&
    a.issuedAt === b.issuedAt && a.expiresAt === b.expiresAt &&
    a.operations.length === b.operations.length &&
    a.operations.every((operation, index) => operation === b.operations[index])
}
