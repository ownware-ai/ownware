/**
 * Migration safety — snapshot before migrating, auto-restore on failure.
 *
 * Ownware is local-first with NO backend and auto-updates: a bad migration
 * reaches every customer automatically and cannot be hotfixed remotely. The
 * only protection is a verified snapshot taken on the user's own disk BEFORE
 * any schema change, and an automatic restore if the change fails. A
 * half-migrated database never runs.
 *
 * Design notes:
 * - Snapshots use SQLite `VACUUM INTO`, not a file copy: the DB runs in WAL
 *   mode, where a raw copy can miss un-checkpointed pages. VACUUM INTO writes
 *   a consistent, defragmented single-file copy and is synchronous (fits the
 *   synchronous DB constructor). [E3]
 * - The current SQLite support envelope remains one gateway process per
 *   database for ordinary runtime work. Startup itself uses an adapter-owned
 *   lock database, so two library/server callers cannot race the snapshot,
 *   migration or restore sequence. Desktop's single-instance lock is not part
 *   of that proof. [E5]
 * - `_migrations` is authoritative: startup validates its exact ordered
 *   version/name prefix, plus immutable fingerprints from the opt-in migration
 *   onward. `PRAGMA user_version` is only a non-authoritative header mirror.
 */

import {
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  copyFileSync,
  chmodSync,
  renameSync,
  existsSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { Migration } from './schema.js'
import type { ErrorCategory, UserAction } from '../../errors/categories.js'
import {
  openSqliteDatabase,
  type SqliteDatabase,
} from '../../storage/sqlite-driver.js'

const BACKUP_DIR_NAME = 'backups'
const BACKUPS_TO_KEEP = 5
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000

/**
 * A migration could not be applied safely. Carries a `category` so it routes
 * through the standard error surface (Principle 21). The message is written
 * to be shown to a non-technical user as-is.
 */
export class MigrationSafetyError extends Error {
  readonly category: ErrorCategory = 'sqlite'
  readonly userAction: UserAction
  constructor(
    message: string,
    options?: {
      readonly cause?: unknown
      readonly userAction?: UserAction
    },
  ) {
    super(message, options)
    this.name = 'MigrationSafetyError'
    this.userAction = options?.userAction ?? 'restart-app'
  }
}

export interface SqliteMigrationLock {
  /** Idempotent. A process crash also releases SQLite's operating-system lock. */
  release(): void
}

export interface OpenDatabaseSafelyOptions {
  /** Test seam and bounded startup policy; production defaults to five seconds. */
  readonly migrationLockTimeoutMs?: number
}

/**
 * A separate SQLite file lets migration/recovery hold one write reservation
 * without blocking the main handle that applies migrations. SQLite owns the
 * operating-system lock, so process exit releases it without stale PID files.
 */
export function sqliteMigrationLockPath(dbPath: string): string {
  return `${dbPath}.migration-lock.sqlite`
}

/**
 * Acquire the adapter-owned cross-process migration lock.
 *
 * The lock covers history inspection, snapshot, migration and recovery. It is
 * intentionally not a claim that all gateway runtime work supports multiple
 * processes; it proves only that startup schema effects cannot race.
 */
export function acquireSqliteMigrationLock(
  dbPath: string,
  timeoutMs: number = DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
): SqliteMigrationLock {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new MigrationSafetyError(
      'Ownware could not establish its database update lock because the lock timeout is invalid.',
      { userAction: 'contact-support' },
    )
  }

  let lockDb: SqliteDatabase | null = null
  try {
    lockDb = openSqliteDatabase(sqliteMigrationLockPath(dbPath), {
      timeout: timeoutMs,
    })
    lockDb.exec(`
      CREATE TABLE IF NOT EXISTS ownware_migration_lock (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      )
    `)
    lockDb.exec('BEGIN IMMEDIATE')
    // Materialize a write in the uncommitted transaction. This makes the
    // effect boundary observable and prevents a runtime/driver optimization
    // from treating an otherwise empty transaction as non-locking.
    lockDb.prepare(`
      INSERT INTO ownware_migration_lock (singleton) VALUES (1)
      ON CONFLICT(singleton) DO UPDATE SET singleton = excluded.singleton
    `).run()
  } catch (error) {
    try {
      lockDb?.close()
    } catch {
      // A failed lock handle has no customer data and no further recovery.
    }
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code ?? '')
      : ''
    const contended = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    throw new MigrationSafetyError(
      contended
        ? 'Another Ownware process is currently checking or updating this data. Stop the other process or wait for it to finish, then try again.'
        : 'Ownware could not establish the exclusive database update lock, so it stopped before changing your data.',
    )
  }

  let active = true
  return {
    release(): void {
      if (!active) return
      active = false
      try {
        if (lockDb?.inTransaction) lockDb.exec('ROLLBACK')
      } catch {
        // Closing the handle below is the authoritative OS-lock release.
      }
      try {
        lockDb?.close()
      } catch {
        // Best-effort close during startup unwind; process exit also releases it.
      }
      lockDb = null
    },
  }
}

// ── Destructive-migration audit (B2) ─────────────────────────────────────
//
// Stops a NEW migration from quietly throwing away user data. Everything at or
// below the baseline already shipped to customers — auditing it changes
// nothing, so it is grandfathered. The guard's value is preventing FUTURE
// mistakes: any migration newer than the baseline that contains destructive
// SQL must carry an explicit `destructive: { reason }` acknowledgment, which
// forces a conscious decision + a written justification in code review.
//
// Baseline = the highest migration version that existed when this guard was
// introduced (2026-06-13). Never raise it to silence a new finding — either
// rewrite the migration additively (expand→contract) or acknowledge it.
export const DESTRUCTIVE_AUDIT_BASELINE = 41

const DESTRUCTIVE_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { label: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { label: 'DELETE FROM', re: /\bDELETE\s+FROM\b/i },
  { label: 'RENAME TO', re: /\bRENAME\s+TO\b/i },
  { label: 'RENAME COLUMN', re: /\bRENAME\s+COLUMN\b/i },
]

export interface DestructiveMigrationFinding {
  readonly version: number
  readonly name: string
  readonly matched: readonly string[]
}

// Remove `-- line` and `/* block */` comments so a destructive keyword inside a
// comment doesn't trigger a false positive.
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * Return every migration newer than `baseline` that contains destructive SQL
 * without an explicit `destructive` acknowledgment. Empty array = clean.
 * Pure function — used by the build-gating test (migration-audit.test.ts).
 */
export function auditMigrations(
  migrations: readonly Migration[],
  baseline: number = DESTRUCTIVE_AUDIT_BASELINE,
): DestructiveMigrationFinding[] {
  const findings: DestructiveMigrationFinding[] = []
  for (const m of migrations) {
    if (m.version <= baseline) continue // grandfathered — already shipped
    if (m.destructive) continue // author explicitly acknowledged + justified
    const sql = stripSqlComments(m.sql)
    const matched = DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(sql)).map((p) => p.label)
    if (matched.length > 0) {
      findings.push({ version: m.version, name: m.name, matched })
    }
  }
  return findings
}

// ── Backup / restore ──────────────────────────────────────────────────────

function backupDir(dbPath: string): string {
  return join(dirname(dbPath), BACKUP_DIR_NAME)
}

// A filesystem-safe timestamp. (Production runtime code — `new Date()` is fine
// here; the Date restriction only applies to workflow scripts.)
function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

const MIGRATION_FINGERPRINT_FORMAT = 'ownware-sqlite-migration-v1'

interface AppliedMigrationRow {
  readonly version: unknown
  readonly name: unknown
  readonly fingerprint: unknown
}

interface AppliedMigrationHistory {
  readonly tableExists: boolean
  readonly hasFingerprintColumn: boolean
  readonly rows: readonly AppliedMigrationRow[]
}

/** Fingerprint one immutable SQLite migration definition. */
export function migrationFingerprint(migration: Migration): string {
  const payload = JSON.stringify({
    format: MIGRATION_FINGERPRINT_FORMAT,
    version: migration.version,
    name: migration.name,
    sql: migration.sql,
    destructiveReason: migration.destructive?.reason ?? null,
    disableForeignKeysReason: migration.disableForeignKeys?.reason ?? null,
    recordsFingerprint: migration.recordsFingerprint === true,
  })
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

function migrationHistoryMismatch(): MigrationSafetyError {
  return new MigrationSafetyError(
    `Ownware stopped before changing your data because this database's update ` +
      `history does not match this version of the app. Your data is safe and ` +
      `untouched — please contact support before trying to repair or reinstall it.`,
    { userAction: 'contact-support' },
  )
}

/** Validate the compiled manifest before it can interpret or mutate a DB. */
export function validateMigrationManifest(migrations: readonly Migration[]): void {
  const names = new Set<string>()
  let fingerprintIntroducers = 0
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!
    if (migration.version !== index + 1) throw migrationHistoryMismatch()
    if (migration.name.trim().length === 0 || names.has(migration.name)) {
      throw migrationHistoryMismatch()
    }
    if (migration.sql.trim().length === 0) throw migrationHistoryMismatch()
    names.add(migration.name)
    if (migration.recordsFingerprint === true) fingerprintIntroducers += 1
  }
  if (fingerprintIntroducers > 1) throw migrationHistoryMismatch()
}

function readAppliedMigrationHistory(db: SqliteDatabase): AppliedMigrationHistory {
  // A corrupt sqlite_master query propagates to the corruption recovery path;
  // only an actually absent table means a brand-new database.
  const table = db.prepare(
    `SELECT 1 AS present FROM sqlite_master
     WHERE type = 'table' AND name = '_migrations'`,
  ).get() as { present: number } | undefined
  if (!table) return { tableExists: false, hasFingerprintColumn: false, rows: [] }

  const columns = db.prepare(`PRAGMA table_info('_migrations')`).all() as Array<{
    readonly name: unknown
  }>
  const names = new Set(columns.map((column) => column.name).filter(
    (name): name is string => typeof name === 'string',
  ))
  if (!names.has('version') || !names.has('name')) throw migrationHistoryMismatch()

  const hasFingerprintColumn = names.has('fingerprint')
  const rows = db.prepare(
    hasFingerprintColumn
      ? `SELECT version, name, fingerprint FROM _migrations ORDER BY version ASC`
      : `SELECT version, name, NULL AS fingerprint FROM _migrations ORDER BY version ASC`,
  ).all() as AppliedMigrationRow[]
  return { tableExists: true, hasFingerprintColumn, rows }
}

function validateAppliedMigrationHistory(
  history: AppliedMigrationHistory,
  migrations: readonly Migration[],
): number {
  if (!history.tableExists) return 0
  // Migration 1 creates and records this table in one transaction. An existing
  // empty audit table is therefore not a valid committed schema state.
  if (history.rows.length === 0) throw migrationHistoryMismatch()

  const targetVersion = migrations.at(-1)?.version ?? 0
  const finalRow = history.rows.at(-1)
  if (
    finalRow != null &&
    typeof finalRow.version === 'number' &&
    Number.isSafeInteger(finalRow.version) &&
    finalRow.version > targetVersion
  ) {
    throw new MigrationSafetyError(
      `Your data was last used by a newer version of Ownware (database v${finalRow.version}, ` +
        `this app supports up to v${targetVersion}). Your data is safe and untouched — ` +
        `please install the latest version of Ownware to open it.`,
    )
  }

  if (history.rows.length > migrations.length) throw migrationHistoryMismatch()
  const fingerprintsFrom = migrations.find(
    (migration) => migration.recordsFingerprint === true,
  )?.version ?? Number.POSITIVE_INFINITY

  for (let index = 0; index < history.rows.length; index += 1) {
    const row = history.rows[index]!
    const expected = migrations[index]
    if (
      expected == null ||
      typeof row.version !== 'number' ||
      !Number.isSafeInteger(row.version) ||
      row.version !== expected.version ||
      typeof row.name !== 'string' ||
      row.name !== expected.name
    ) {
      throw migrationHistoryMismatch()
    }

    if (row.fingerprint != null) {
      if (
        typeof row.fingerprint !== 'string' ||
        row.fingerprint !== migrationFingerprint(expected)
      ) {
        throw migrationHistoryMismatch()
      }
    } else if (row.version >= fingerprintsFrom) {
      throw migrationHistoryMismatch()
    }
  }

  if (
    history.rows.some((row) => (
      typeof row.version === 'number' && row.version >= fingerprintsFrom
    )) && !history.hasFingerprintColumn
  ) {
    throw migrationHistoryMismatch()
  }

  const currentVersion = history.rows.at(-1)?.version
  if (typeof currentVersion !== 'number') throw migrationHistoryMismatch()
  return currentVersion
}

/**
 * Read-only exact-history assertion for transfer/diagnostic callers.
 * It never migrates, repairs or rewrites a receipt.
 */
export function assertCurrentSqliteMigrationHistory(
  db: SqliteDatabase,
  migrations: readonly Migration[],
): number {
  validateMigrationManifest(migrations)
  const currentVersion = validateAppliedMigrationHistory(
    readAppliedMigrationHistory(db),
    migrations,
  )
  const compiledVersion = migrations.at(-1)?.version ?? 0
  if (currentVersion !== compiledVersion) throw migrationHistoryMismatch()
  return currentVersion
}

function insertAppliedMigration(db: SqliteDatabase, migration: Migration): void {
  const columns = db.prepare(`PRAGMA table_info('_migrations')`).all() as Array<{
    readonly name: unknown
  }>
  const hasFingerprintColumn = columns.some((column) => column.name === 'fingerprint')
  if (migration.recordsFingerprint === true && !hasFingerprintColumn) {
    // The opt-in migration must establish the durable receipt in the same
    // transaction as its schema change. Succeeding now and failing only on the
    // next restart would create a falsely acknowledged migration.
    throw migrationHistoryMismatch()
  }
  if (hasFingerprintColumn) {
    db.prepare(
      `INSERT INTO _migrations (version, name, fingerprint) VALUES (?, ?, ?)`,
    ).run(migration.version, migration.name, migrationFingerprint(migration))
    return
  }
  db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
    migration.version,
    migration.name,
  )
}

/**
 * Does this error mean the SQLite file on disk is damaged / not a database?
 * Covers the better-sqlite3 codes (`SQLITE_CORRUPT`, `SQLITE_NOTADB`) and the
 * message variants, so corruption can be told apart from ordinary SQL errors.
 */
export function isDatabaseCorruptError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('SQLITE_CORRUPT')) return true
  if (code === 'SQLITE_NOTADB') return true
  const message = (err as { message?: unknown }).message
  if (typeof message !== 'string') return false
  const m = message.toLowerCase()
  return (
    m.includes('malformed') ||
    m.includes('not a database') ||
    m.includes('file is encrypted or is not a database')
  )
}

/**
 * Newest backup snapshot for this DB (`<dataDir>/backups/<db>.v*.…bak`), or
 * `null` if none exists. Mirrors the filter + mtime-sort `pruneBackups` uses,
 * so the backup-naming contract stays in one file.
 */
export function findLatestBackup(dbPath: string): string | null {
  const dir = backupDir(dbPath)
  const base = basename(dbPath)
  let candidates: string[]
  try {
    candidates = readdirSync(dir).filter(
      (f) => f.startsWith(`${base}.v`) && f.endsWith('.bak'),
    )
  } catch {
    return null
  }
  if (candidates.length === 0) return null
  const newest = candidates
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  return newest ? newest.path : null
}

/**
 * Move a corrupt DB file aside (never delete it) so support / the user can
 * still attempt forensic recovery of whatever was salvageable. Best-effort:
 * if the rename fails, the subsequent `restoreSnapshot` copy overwrites it.
 * The corrupt file's stale `-wal`/`-shm` sidecars are cleared by
 * `restoreSnapshot` after the backup is copied over the live path.
 */
function setAsideCorruptFile(dbPath: string): void {
  try {
    renameSync(dbPath, `${dbPath}.corrupt.${fileStamp()}`)
  } catch {
    // Preserving the evidence is best-effort; recovery proceeds regardless.
  }
}

/**
 * Write a consistent snapshot of `db` to the backups dir, tagged with the
 * schema version it is at right now. Returns the snapshot path. Atomic: writes
 * to a `.partial` file and renames into place only on success. [R1, E2]
 */
export function snapshotDatabase(
  db: SqliteDatabase,
  dbPath: string,
  version: number,
): string {
  const dir = backupDir(dbPath)
  mkdirSync(dir, { recursive: true })

  const finalPath = join(dir, `${basename(dbPath)}.v${version}.${fileStamp()}.bak`)
  const tmpPath = `${finalPath}.partial`
  if (existsSync(tmpPath)) rmSync(tmpPath, { force: true })

  db.prepare('VACUUM INTO ?').run(tmpPath)
  chmodSync(tmpPath, 0o600) // same restriction as the DB; it may hold sensitive data
  renameSync(tmpPath, finalPath)

  pruneBackups(dir, basename(dbPath), BACKUPS_TO_KEEP)
  return finalPath
}

/**
 * Keep the newest `keep` snapshots for this DB; delete the rest. Prunes only
 * AFTER a new snapshot has landed, so we never drop a backup to make room for
 * one that hasn't been written yet. [E13]
 */
export function pruneBackups(dir: string, dbBaseName: string, keep: number): void {
  let candidates: string[]
  try {
    candidates = readdirSync(dir).filter(
      (f) => f.startsWith(`${dbBaseName}.v`) && f.endsWith('.bak'),
    )
  } catch {
    return
  }
  if (candidates.length <= keep) return

  const byNewest = candidates
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  for (const { f } of byNewest.slice(keep)) {
    rmSync(join(dir, f), { force: true })
  }
}

/**
 * Restore a snapshot over the live DB path. The caller MUST have closed the DB
 * handle first. Removes stale WAL/SHM sidecars so they can't replay over the
 * restored file. [E4]
 */
export function restoreSnapshot(backupPath: string, dbPath: string): void {
  copyFileSync(backupPath, dbPath)
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true })
  }
}

/**
 * Apply all pending migrations with a snapshot-and-restore safety net.
 *
 * - Refuses to run on a DB newer than this code understands (downgrade guard, R6).
 * - Snapshots existing data before applying anything (R1). A brand-new empty
 *   DB (version 0) has nothing to lose, so the snapshot is skipped.
 * - Each migration is its own transaction (R3) — SQLite DDL is transactional.
 * - Runs `integrity_check` after the batch (R7).
 * - On ANY failure, closes the handle, restores the snapshot, and throws a
 *   clear error. The DB is left exactly as it was before the update. [E4]
 *
 * Throws `MigrationSafetyError` on every failure path. On success the DB is at
 * the latest version and the handle is still open and usable.
 */
export function runMigrationsSafely(
  db: SqliteDatabase,
  dbPath: string,
  migrations: readonly Migration[],
): void {
  validateMigrationManifest(migrations)
  const history = readAppliedMigrationHistory(db)
  const currentVersion = validateAppliedMigrationHistory(history, migrations)
  const lastMigration = migrations.at(-1)
  const targetVersion = lastMigration ? lastMigration.version : 0

  const pending = migrations.filter((m) => m.version > currentVersion)
  if (pending.length === 0) {
    db.pragma(`user_version = ${currentVersion}`)
    return
  }

  // R1 — snapshot before touching existing data.
  let snapshotPath: string | null = null
  if (currentVersion > 0) {
    try {
      snapshotPath = snapshotDatabase(db, dbPath, currentVersion)
      console.log(`  migration [main]: snapshot saved → ${snapshotPath}`)
    } catch (err) {
      throw new MigrationSafetyError(
        `Ownware could not back up your data before updating it, so it stopped to ` +
          `keep your data safe. Check that your disk isn't full and try again.`,
        { cause: err },
      )
    }
  }

  // Per-migration lines only in verbose mode — a fresh install applies
  // the full history (~50 migrations) and the wall of log lines reads
  // like something went wrong. Upgrades (existing data, few pending)
  // stay itemized so support conversations can see exactly what ran.
  const verbose = process.env['OWNWARE_VERBOSE'] === '1' || currentVersion > 0
  try {
    for (const migration of pending) {
      // A migration that rebuilds a foreign-key PARENT (SQLite cannot widen
      // a CHECK in place) needs `foreign_keys = OFF` for its DROP of the
      // referenced table — and that pragma is a no-op inside a transaction,
      // so only this runner can grant it. The grant is narrow: enforcement
      // returns before the next migration, and `foreign_key_check` runs
      // INSIDE the transaction so a rebuild that broke referential
      // integrity rolls back instead of committing.
      const fkOff = migration.disableForeignKeys !== undefined
      if (fkOff) db.pragma('foreign_keys = OFF')
      try {
        db.transaction(() => {
          db.exec(migration.sql)
          if (fkOff) {
            const violations = db.pragma('foreign_key_check') as unknown[]
            if (violations.length > 0) {
              throw new Error(
                `migration ${migration.name} left ${violations.length} foreign-key ` +
                  `violation(s); rolling back`,
              )
            }
          }
          insertAppliedMigration(db, migration)
        })()
      } finally {
        if (fkOff) db.pragma('foreign_keys = ON')
      }
      if (verbose) console.log(`  migration [main]: applied ${migration.name}`)
    }
    if (!verbose) {
      console.log(`  database initialized (${pending.length} migrations)`)
    }

    // R7 — integrity gate. A passing batch that left a corrupt DB still fails here.
    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      throw new Error(`integrity_check returned: ${String(integrity)}`)
    }

    // R6/E15 — mirror the new version into the header for diagnostics. The
    // ordered `_migrations` history above remains the authority.
    db.pragma(`user_version = ${targetVersion}`)
  } catch (err) {
    if (!snapshotPath) {
      // No snapshot existed (brand-new DB). Nothing to restore — surface raw.
      throw new MigrationSafetyError(
        `Ownware could not finish setting up its database. Please reinstall the latest version.`,
        { cause: err },
      )
    }
    try {
      db.close()
      restoreSnapshot(snapshotPath, dbPath)
    } catch (restoreErr) {
      throw new MigrationSafetyError(
        `A database update failed and the automatic restore also failed. Your ` +
          `pre-update backup is safe at "${snapshotPath}" — do NOT delete it. ` +
          `Please contact support before reinstalling.`,
        { cause: restoreErr },
      )
    }
    throw new MigrationSafetyError(
      `A database update couldn't be completed, so Ownware automatically restored ` +
        `your data to how it was before (nothing was lost). This will fix itself when ` +
        `the next update installs. A backup is kept at "${snapshotPath}".`,
      { cause: err },
    )
  }
}

/**
 * Open the database, apply pragmas, and migrate — with automatic recovery
 * from a CORRUPT file on disk.
 *
 * This wraps `runMigrationsSafely` (which already protects against bad
 * migrations) with the missing other half: a database file that is itself
 * damaged. Mirrors the same auto-restore philosophy — recover silently from
 * the most recent backup rather than stranding the user. Before this, a
 * malformed file was misread as a brand-new v0 DB, every table re-created,
 * the migration failed, and the user was told to reinstall while their
 * backups sat unused. [E8]
 *
 * Recovery is bounded to the SINGLE most recent backup: snapshots are
 * `VACUUM INTO` (consistent + defragmented), so the latest is overwhelmingly
 * the right one. If even that fails to open, we stop and tell the user their
 * backups are safe rather than silently churning through older copies.
 *
 * `configure` runs the caller's pragmas on each freshly-opened handle (the DB
 * package owns its own pragma policy; this module owns the recovery dance).
 * Returns a live, migrated handle. Throws `MigrationSafetyError` only when
 * recovery is impossible (no backup, or the backup also won't open).
 */
function openDatabaseSafelyUnlocked(
  dbPath: string,
  configure: (db: SqliteDatabase) => void,
  migrations: readonly Migration[],
): SqliteDatabase {
  const open = (): SqliteDatabase => {
    const db = openSqliteDatabase(dbPath)
    configure(db)
    return db
  }

  let db: SqliteDatabase | null = null
  try {
    db = open()
    runMigrationsSafely(db, dbPath, migrations)
    return db
  } catch (err) {
    if (db != null) {
      try {
        db.close()
      } catch {
        // Handle is already unusable on a corrupt open; nothing to clean up.
      }
    }
    // Anything that isn't on-disk corruption (e.g. a MigrationSafetyError that
    // already ran its own restore) surfaces unchanged.
    if (!isDatabaseCorruptError(err)) throw err

    const backup = findLatestBackup(dbPath)
    if (backup == null) {
      throw new MigrationSafetyError(
        `Your Ownware data file appears to be damaged and no automatic backup ` +
          `was found to restore from. The damaged file is kept at "${dbPath}" — ` +
          `do not delete it. Please contact support before reinstalling.`,
        { cause: err },
      )
    }

    setAsideCorruptFile(dbPath)
    restoreSnapshot(backup, dbPath)

    try {
      const restored = open()
      runMigrationsSafely(restored, dbPath, migrations)
      console.warn(
        `  database: on-disk file was corrupt — recovered from backup ${backup}`,
      )
      return restored
    } catch (recoverErr) {
      throw new MigrationSafetyError(
        `Your Ownware data file was damaged and the automatic restore from backup ` +
          `"${backup}" did not succeed. Your other backups are safe — do not delete ` +
          `the "backups" folder. Please contact support before reinstalling.`,
        { cause: recoverErr },
      )
    }
  }
}

/**
 * Open, inspect, migrate and recover under the adapter's cross-process lock.
 * No main-database handle is opened until the lock is held.
 */
export function openDatabaseSafely(
  dbPath: string,
  configure: (db: SqliteDatabase) => void,
  migrations: readonly Migration[],
  options: OpenDatabaseSafelyOptions = {},
): SqliteDatabase {
  const lock = acquireSqliteMigrationLock(
    dbPath,
    options.migrationLockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  )
  try {
    return openDatabaseSafelyUnlocked(dbPath, configure, migrations)
  } finally {
    lock.release()
  }
}
