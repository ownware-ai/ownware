import { createHash, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'

const THREAD_SCOPE_DOMAIN = 'ownware.gateway.thread-principal-scope.v1\0'
const SHA256_HEX = /^[0-9a-f]{64}$/

interface ThreadPrincipalBindingRow {
  readonly principal_scope_digest: string
}

/**
 * One-way representation of a verified delegated authority context.
 * Persisting only a domain-separated digest avoids creating a second
 * identity/subject catalogue.
 */
export function threadPrincipalScopeDigest(principalKey: string): string {
  return createHash('sha256').update(THREAD_SCOPE_DOMAIN).update(principalKey).digest('hex')
}

/** Durable, private binding between a delegated authority context and thread. */
export class ThreadPrincipalBindingStore {
  constructor(private readonly db: Database.Database) {}

  /** Same-scope repeats are idempotent; a thread can never be rebound. */
  bind(threadId: string, principalKey: string, now: number = Date.now()): boolean {
    const digest = threadPrincipalScopeDigest(principalKey)
    this.db.prepare(`
      INSERT INTO thread_principal_bindings (
        thread_id, principal_scope_digest, created_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO NOTHING
    `).run(threadId, digest, now)
    return this.allowsDigest(threadId, digest)
  }

  /** Unbound legacy/owner threads fail closed for delegated callers. */
  allows(threadId: string, principalKey: string): boolean {
    return this.allowsDigest(threadId, threadPrincipalScopeDigest(principalKey))
  }

  private allowsDigest(threadId: string, expected: string): boolean {
    const row = this.db.prepare(`
      SELECT principal_scope_digest
      FROM thread_principal_bindings
      WHERE thread_id = ?
    `).get(threadId) as ThreadPrincipalBindingRow | undefined
    if (!row || !SHA256_HEX.test(row.principal_scope_digest)) return false
    return timingSafeEqual(
      Buffer.from(row.principal_scope_digest, 'hex'),
      Buffer.from(expected, 'hex'),
    )
  }
}
