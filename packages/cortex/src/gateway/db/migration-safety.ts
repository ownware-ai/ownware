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
 * - The two-instances-racing case (E5) cannot happen on desktop: the client holds
 *   `app.requestSingleInstanceLock()`, so exactly one gateway process runs.
 * - Schema version is recorded in BOTH `_migrations` (audit trail / source of
 *   truth) and the DB header `PRAGMA user_version` (instant read for the
 *   downgrade guard, no query needed). [R6/E15]
 */

import Database from 'better-sqlite3'
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
import type { Migration } from './schema.js'
import type { ErrorCategory, UserAction } from '../../errors/categories.js'

const BACKUP_DIR_NAME = 'backups'
const BACKUPS_TO_KEEP = 5

/**
 * A migration could not be applied safely. Carries a `category` so it routes
 * through the standard error surface (Principle 21). The message is written
 * to be shown to a non-technical user as-is.
 */
export class MigrationSafetyError extends Error {
  readonly category: ErrorCategory = 'sqlite'
  readonly userAction: UserAction = 'restart-app'
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'MigrationSafetyError'
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

function readSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as v FROM _migrations')
      .get() as { v: number | null } | undefined
    return row?.v ?? 0
  } catch (err) {
    // A genuinely brand-new database has no `_migrations` table yet → v0.
    // But a CORRUPT file also fails this read, and masking that as "v0"
    // is dangerous: the runner would then try to re-create every table on
    // a malformed file, fail, and tell the user to reinstall — destroying
    // recoverable data. Only the missing-table case means "fresh"; any
    // other failure (corruption) must propagate so the caller can recover.
    if (isMissingTableError(err)) return 0
    throw err
  }
}

/** better-sqlite3's "no such table: _migrations" — a brand-new, empty DB. */
function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return msg.includes('no such table')
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
  db: Database.Database,
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
  db: Database.Database,
  dbPath: string,
  migrations: readonly Migration[],
): void {
  const currentVersion = readSchemaVersion(db)
  const lastMigration = migrations.at(-1)
  const targetVersion = lastMigration ? lastMigration.version : 0

  // R6 — DB written by a NEWER app than this code. Never write to it.
  if (currentVersion > targetVersion) {
    throw new MigrationSafetyError(
      `Your data was last used by a newer version of Ownware (database v${currentVersion}, ` +
        `this app supports up to v${targetVersion}). Your data is safe and untouched — ` +
        `please install the latest version of Ownware to open it.`,
    )
  }

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
      db.transaction(() => {
        db.exec(migration.sql)
        db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
          migration.version,
          migration.name,
        )
      })()
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

    // R6/E15 — mirror the new version into the header for instant downgrade checks.
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
export function openDatabaseSafely(
  dbPath: string,
  configure: (db: Database.Database) => void,
  migrations: readonly Migration[],
): Database.Database {
  const open = (): Database.Database => {
    const db = new Database(dbPath)
    configure(db)
    return db
  }

  let db: Database.Database | null = null
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
