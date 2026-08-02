'use strict'

const Database = require('better-sqlite3')

const lockPath = process.argv[2]
if (!lockPath) throw new Error('lock path argument is required')

const db = new Database(lockPath, { timeout: 1_000 })
db.exec(`
  CREATE TABLE IF NOT EXISTS ownware_migration_lock (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
  )
`)
db.exec('BEGIN IMMEDIATE')
db.prepare(`
  INSERT INTO ownware_migration_lock (singleton) VALUES (1)
  ON CONFLICT(singleton) DO UPDATE SET singleton = excluded.singleton
`).run()
process.stdout.write(`locked:${lockPath}\n`)

// The contention test kills this process abruptly. SQLite/OS—not cleanup code—
// must release the write reservation, which is the production crash contract.
setInterval(() => {
  // Capture the handle so V8 cannot collect it and release the native lock.
  void db.inTransaction
}, 1_000)
