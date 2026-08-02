/**
 * The single production dependency boundary for the SQLite driver.
 *
 * SQLite physical repositories may depend on the handle aliases below, but
 * no other production module imports `better-sqlite3` directly. Keeping the
 * constructor here prevents a new gateway/domain caller from quietly making
 * the native driver part of its own contract.
 */
import Database from 'better-sqlite3'

export type SqliteDatabase = Database.Database
export type SqliteStatement<
  BindParameters extends unknown[] | object = unknown[],
  Result = unknown,
> = Database.Statement<BindParameters, Result>

export interface SqliteOpenOptions {
  readonly readonly?: boolean
  readonly fileMustExist?: boolean
  readonly timeout?: number
  readonly verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void
  readonly nativeBinding?: string
}

/** Open one physical SQLite handle. Lifecycle ownership stays with the caller. */
export function openSqliteDatabase(
  filename: string | Buffer,
  options?: SqliteOpenOptions,
): SqliteDatabase {
  return new Database(filename, options)
}
