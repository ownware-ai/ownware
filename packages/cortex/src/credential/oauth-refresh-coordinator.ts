import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import { isCredentialId } from './schema.js'

export interface OAuthRefreshLease {
  readonly credentialId: string
  readonly ownerId: string
  readonly generation: number
  readonly expiresAt: number
}

export type OAuthRefreshAcquireResult =
  | { readonly kind: 'acquired'; readonly lease: OAuthRefreshLease }
  | { readonly kind: 'held'; readonly retryAt: number }
  | { readonly kind: 'missing' }

export interface OAuthRefreshCoordinator {
  tryAcquire(
    credentialId: string,
    now: number,
    leaseMs: number,
  ): OAuthRefreshAcquireResult
  renew(
    lease: OAuthRefreshLease,
    now: number,
    leaseMs: number,
  ): OAuthRefreshLease | null
  release(lease: OAuthRefreshLease): boolean
}

interface LeaseRow {
  readonly credential_id: string
  readonly owner_id: string
  readonly generation: number
  readonly expires_at: number
}

function assertTime(name: string, value: number, allowZero: boolean): void {
  if (
    !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${name} must be a safe positive integer`)
  }
}

function hydrate(row: LeaseRow): OAuthRefreshLease {
  return {
    credentialId: row.credential_id,
    ownerId: row.owner_id,
    generation: row.generation,
    expiresAt: row.expires_at,
  }
}

/**
 * SQLite is the actual credential persistence boundary, so it is also the
 * refresh concurrency authority. Independent gateway processes opening the
 * same database contend on this row through `BEGIN IMMEDIATE`.
 */
export class DbOAuthRefreshCoordinator implements OAuthRefreshCoordinator {
  private readonly ownerId: string

  constructor(
    private readonly db: SqliteDatabase,
    ownerId: string = randomUUID(),
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) {
      throw new Error('OAuth refresh owner id is invalid')
    }
    this.ownerId = ownerId
  }

  tryAcquire(
    credentialId: string,
    now: number,
    leaseMs: number,
  ): OAuthRefreshAcquireResult {
    if (!isCredentialId(credentialId)) return { kind: 'missing' }
    assertTime('now', now, true)
    assertTime('leaseMs', leaseMs, false)
    if (!Number.isSafeInteger(now + leaseMs)) {
      throw new Error('OAuth refresh lease expiry is outside the safe range')
    }

    return this.db.transaction((): OAuthRefreshAcquireResult => {
      const credential = this.db.prepare(
        'SELECT 1 FROM credentials WHERE id = ?',
      ).get(credentialId)
      if (credential === undefined) return { kind: 'missing' }

      const current = this.db.prepare(`
        SELECT credential_id, owner_id, generation, expires_at
        FROM oauth_refresh_leases
        WHERE credential_id = ?
      `).get(credentialId) as LeaseRow | undefined

      if (current !== undefined && current.expires_at > now) {
        return { kind: 'held', retryAt: current.expires_at }
      }

      const generation = (current?.generation ?? 0) + 1
      const expiresAt = now + leaseMs
      this.db.prepare(`
        INSERT INTO oauth_refresh_leases (
          credential_id, owner_id, generation, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE oauth_refresh_leases.expires_at <= excluded.updated_at
      `).run(credentialId, this.ownerId, generation, expiresAt, now)

      const acquired = this.inspect(credentialId)
      if (
        acquired === null
        || acquired.ownerId !== this.ownerId
        || acquired.generation !== generation
      ) {
        return {
          kind: 'held',
          retryAt: acquired?.expiresAt ?? expiresAt,
        }
      }
      return { kind: 'acquired', lease: acquired }
    }).immediate()
  }

  renew(
    lease: OAuthRefreshLease,
    now: number,
    leaseMs: number,
  ): OAuthRefreshLease | null {
    assertTime('now', now, true)
    assertTime('leaseMs', leaseMs, false)
    if (!Number.isSafeInteger(now + leaseMs)) {
      throw new Error('OAuth refresh lease expiry is outside the safe range')
    }
    const expiresAt = now + leaseMs
    const result = this.db.prepare(`
      UPDATE oauth_refresh_leases
      SET expires_at = ?, updated_at = ?
      WHERE credential_id = ?
        AND owner_id = ?
        AND generation = ?
        AND expires_at > ?
    `).run(
      expiresAt,
      now,
      lease.credentialId,
      lease.ownerId,
      lease.generation,
      now,
    )
    if (result.changes !== 1) return null
    return { ...lease, expiresAt }
  }

  release(lease: OAuthRefreshLease): boolean {
    const result = this.db.prepare(`
      DELETE FROM oauth_refresh_leases
      WHERE credential_id = ?
        AND owner_id = ?
        AND generation = ?
    `).run(lease.credentialId, lease.ownerId, lease.generation)
    return result.changes === 1
  }

  /** Safe test/operator diagnostic: no provider or credential material. */
  inspect(credentialId: string): OAuthRefreshLease | null {
    const row = this.db.prepare(`
      SELECT credential_id, owner_id, generation, expires_at
      FROM oauth_refresh_leases
      WHERE credential_id = ?
    `).get(credentialId) as LeaseRow | undefined
    return row === undefined ? null : hydrate(row)
  }
}
