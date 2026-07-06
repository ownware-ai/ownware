/**
 * SqliteUserIdentityStore — single-row global identity.
 *
 * Lives in the `user_identity` table with a CHECK constraint pinning
 * the row id to the literal 'singleton'. Every `set()` call is an
 * UPSERT against that one row.
 *
 * The store always returns a UserIdentity object — when the row
 * doesn't exist yet, all fields are null and `updatedAt` is null.
 * Callers (assembler, gateway) can rely on shape stability without
 * branching on existence.
 */

import type Database from 'better-sqlite3'
import { type UserIdentity, type UpdateUserIdentityRequest } from './schema.js'
import type { MemoryEventBus } from './event-bus.js'

const SINGLETON_ID = 'singleton'

interface IdentityRow {
  readonly id: string
  readonly name: string | null
  readonly role: string | null
  readonly company: string | null
  readonly timezone: string | null
  readonly pronouns: string | null
  readonly preferences: string | null
  readonly created_at: string
  readonly updated_at: string
}

const EMPTY: UserIdentity = {
  name: null,
  role: null,
  company: null,
  timezone: null,
  pronouns: null,
  preferences: null,
  updatedAt: null,
}

function rowToIdentity(row: IdentityRow): UserIdentity {
  return {
    name: row.name,
    role: row.role,
    company: row.company,
    timezone: row.timezone,
    pronouns: row.pronouns,
    preferences: row.preferences,
    updatedAt: row.updated_at,
  }
}

export class SqliteUserIdentityStore {
  private readonly db: Database.Database
  private readonly bus: MemoryEventBus | null

  constructor(db: Database.Database, bus: MemoryEventBus | null = null) {
    this.db = db
    this.bus = bus
  }

  get(): UserIdentity {
    const row = this.db.prepare(
      `SELECT * FROM user_identity WHERE id = ?`,
    ).get(SINGLETON_ID) as IdentityRow | undefined
    return row ? rowToIdentity(row) : EMPTY
  }

  /**
   * Partial update. Fields that are present in `input` are written;
   * `null` clears them; `undefined` is left unchanged. Returns the
   * resulting full identity record.
   */
  set(input: UpdateUserIdentityRequest): UserIdentity {
    const current = this.get()
    const merged: Omit<UserIdentity, 'updatedAt'> = {
      name: input.name === undefined ? current.name : input.name,
      role: input.role === undefined ? current.role : input.role,
      company: input.company === undefined ? current.company : input.company,
      timezone: input.timezone === undefined ? current.timezone : input.timezone,
      pronouns: input.pronouns === undefined ? current.pronouns : input.pronouns,
      preferences: input.preferences === undefined ? current.preferences : input.preferences,
    }

    const now = new Date().toISOString()

    this.db.prepare(
      `INSERT INTO user_identity (id, name, role, company, timezone, pronouns, preferences, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         role = excluded.role,
         company = excluded.company,
         timezone = excluded.timezone,
         pronouns = excluded.pronouns,
         preferences = excluded.preferences,
         updated_at = excluded.updated_at`,
    ).run(
      SINGLETON_ID,
      merged.name,
      merged.role,
      merged.company,
      merged.timezone,
      merged.pronouns,
      merged.preferences,
      now,
      now,
    )

    this.bus?.emit({ type: 'memory.identity.changed', at: now })

    return { ...merged, updatedAt: now }
  }

  /**
   * Render the identity as a system-prompt fragment, or null when no
   * field is populated. Designed to be ergonomic to inline at assembly
   * time — same pattern the credential context fragment uses.
   */
  renderForPrompt(): string | null {
    const id = this.get()
    const lines: string[] = []
    if (id.name) lines.push(`- Name: ${id.name}`)
    if (id.pronouns) lines.push(`- Pronouns: ${id.pronouns}`)
    if (id.role) lines.push(`- Role: ${id.role}`)
    if (id.company) lines.push(`- Company: ${id.company}`)
    if (id.timezone) lines.push(`- Timezone: ${id.timezone}`)
    if (id.preferences) {
      lines.push(`- Preferences:`)
      for (const line of id.preferences.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) lines.push(`  - ${trimmed.replace(/^[-*]\s+/, '')}`)
      }
    }
    if (lines.length === 0) return null
    return [
      '## About the user',
      'These are facts the user has shared in their global "About you" settings. Apply them when answering — never ask for information already listed below.',
      ...lines,
    ].join('\n')
  }
}
