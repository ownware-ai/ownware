---
title: Gateway storage
description: Choose SQLite or tenant-owned PostgreSQL, provision it safely, back it up, restore it, and perform an offline transfer.
type: guide
---

# Gateway storage

Ownware has one durable storage authority per running gateway:

| Backend | Best fit | What you operate |
|---|---|---|
| SQLite (default) | One process, smallest operational footprint, local or single-host deployments | One database file; no database service or PostgreSQL package |
| PostgreSQL | A tenant already operates PostgreSQL and wants Ownware records in that infrastructure | PostgreSQL 16.14+, 17.10+, or 18.4+; the optional `pg` driver; TLS, roles, backups, and availability |

Both choices implement the same supported domain and HTTP/SSE behavior. This
does not make one gateway horizontally scalable: live sessions and the live
event bus remain process-local. Shared PostgreSQL is not a claim of active-active
gateway support.

The selected backend never changes automatically. A failed PostgreSQL
connection cannot fall back to SQLite, and a running gateway never reads one
backend while writing another.

## SQLite: the zero-configuration default

Omit `storage` and Ownware opens `<dataDir>/ownware.db`:

```ts
import { OwnwareGateway } from 'ownware'

const gateway = new OwnwareGateway({
  profilesDir: './profiles',
  dataDir: './data',
})
await gateway.start()
```

An explicit path is also supported:

```ts
const gateway = new OwnwareGateway({
  profilesDir: './profiles',
  dataDir: './data',
  storage: { kind: 'sqlite', path: '/srv/ownware/ownware.db' },
})
```

Do not combine `storage` with the older `dbPath` option. Unknown or conflicting
storage fields fail before the gateway listens.

## PostgreSQL: explicit library configuration

Install the optional peer only in deployments that select PostgreSQL:

```bash
npm install ownware pg@^8.22.0
```

The default SQLite install does not need `pg`. `ownware serve` continues to use
SQLite; PostgreSQL is currently selected through `OwnwareGateway`, so a
deployment normally keeps a small checked-in `serve.mjs`:

```js
import { OwnwareGateway } from 'ownware'

const gateway = new OwnwareGateway({
  profilesDir: './profiles',
  dataDir: './data',
  host: '127.0.0.1',
  storage: {
    kind: 'postgresql',
    runtimeConnection: { source: 'environment' }, // OWNWARE_POSTGRES_URL
    migrationConnection: {
      source: 'environment',
      variable: 'OWNWARE_POSTGRES_MIGRATION_URL',
    },
    tls: { mode: 'verify-full', ca: { source: 'system' } },
    pool: { maxConnections: 10 },
  },
})

await gateway.start()
```

Set the two URLs in the process's secret manager. They must be
`postgresql://user:password@host/database` URLs with a username, database, and
no query string or fragment. TLS is configured structurally so URL parameters
cannot silently replace the verified TLS policy. Connection URLs and driver
messages are discarded at Ownware's error boundary; do not print them in your
launcher.

For a private CA, use a local CA file:

```js
tls: { mode: 'verify-full', ca: { source: 'file', path: '/run/secrets/postgres-ca.pem' } }
```

Plaintext PostgreSQL is accepted only for a literal loopback host and requires
an explicit acknowledgement. It is for local development, not a remote server:

```js
tls: { mode: 'disable', allowInsecureLoopback: true }
```

If `migrationConnection` is omitted, the runtime connection owns migrations as
well. Production deployments should use separate roles.

## Provision separate migration and runtime roles

Run equivalent administration through your managed PostgreSQL service. One
straightforward self-managed setup is:

```sql
CREATE ROLE ownware_migration LOGIN;
CREATE ROLE ownware_runtime LOGIN;
CREATE DATABASE ownware OWNER ownware_migration;
GRANT CONNECT ON DATABASE ownware TO ownware_runtime;
```

Set passwords through your secret manager or an interactive PostgreSQL
facility rather than committing them in SQL. The migration URL uses
`ownware_migration`; the runtime URL uses `ownware_runtime`.

On startup, the migration role must own the fixed `ownware` schema (or be able
to create it in a fresh database). Ownware takes a PostgreSQL advisory migration
lock, validates the exact immutable history, applies pending migrations inside
a transaction, and grants the runtime role data-plane privileges. The runtime
role can read migration history but cannot mutate it or create schema objects.
Startup refuses an unknown schema, wrong owner, unsupported server, missing
privilege, database/user mismatch, or TLS-policy mismatch.

The current server envelope is PostgreSQL 16.14+, 17.10+, and 18.4+. A newer
major is unknown, not assumed compatible. Test it in a disposable environment
after Ownware explicitly adds support.

## Local files still matter with PostgreSQL

PostgreSQL replaces the gateway's relational database, not the entire
`dataDir`. The directory still holds source bytes and derived artifacts,
channel configuration, the gateway token, TLS material, and—depending on your
setup—the key material needed to decrypt credential ciphertext stored in
PostgreSQL.

Back up PostgreSQL and `dataDir` as one deployment. Deleting only `dataDir` can
make encrypted PostgreSQL credential rows unusable. Tests must always provide
an isolated temporary `dataDir`; they must never touch a real `~/.ownware/`.

## Backup and restore

### SQLite

For a complete, simple backup, stop the gateway and copy the entire `dataDir`.
If `storage.path` points outside it, copy that stopped SQLite database as well.
Preserve any externally supplied `OWNWARE_MASTER_KEY` in your secret manager.

SQLite migrations also create bounded pre-upgrade snapshots and restore one if
a migration fails. Those snapshots protect schema upgrades; they are not a
replacement for an operator backup of the full deployment.

Restore into a stopped gateway, verify file ownership/permissions, restore the
same master key, then start the same or newer Ownware version. Ownware refuses
an unknown or newer migration history rather than attempting a downgrade.

### PostgreSQL

Stop the gateway so the database and filesystem artifacts form one quiescent
deployment, then back up both:

```bash
pg_dump --format=custom --schema=ownware --file=ownware-postgres.dump "$OWNWARE_POSTGRES_MIGRATION_URL"
```

Copy `dataDir` through your normal encrypted backup system and preserve the
master key separately. For restore, create a new empty database owned by the
migration role, restore the dump as that role, restore `dataDir`, and only then
start Ownware with the restored URLs. Do not restore over an ambiguous live
database.

PostgreSQL backup scheduling, point-in-time recovery, replication, and failover
remain the operator's responsibility. Ownware's transactional migration
recovery is not a database backup service.

After either restore, verify `/api/v1/health`, a known thread and replay, a
credential-gated operation, and a source read/query before accepting new work.

## Offline SQLite-to-PostgreSQL transfer

The public transfer API is deliberately offline and one-way. It proves one
writer-fenced SQLite snapshot is representable, copies all business tables into
one locked PostgreSQL transaction, verifies canonical equality before and after
commit, and returns `ready-for-explicit-cutover`. It never changes gateway
configuration for you.

Before transfer:

1. Stop the SQLite gateway and keep its database and `dataDir` unchanged.
2. Create an empty PostgreSQL database and roles.
3. Start and stop an empty PostgreSQL-selected gateway once so the current
   schema and runtime privileges exist. The target must contain no business
   rows.
4. Connect two `pg` clients—migration and runtime—even when one combined role
   supplies both.

```js
import { Client } from 'pg'
import {
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
} from 'ownware'

const migration = new Client({
  connectionString: process.env.OWNWARE_POSTGRES_MIGRATION_URL,
  ssl: { rejectUnauthorized: true },
})
const runtime = new Client({
  connectionString: process.env.OWNWARE_POSTGRES_URL,
  ssl: { rejectUnauthorized: true },
})

await migration.connect()
await runtime.connect()
try {
  const expectedSource = preflightSqliteTransferSource('./data/ownware.db')
  const expectedTarget = await preflightPostgreSqlTransferTarget(migration, runtime)
  const receipt = await transferOfflineSqliteToPostgreSql({
    sourcePath: './data/ownware.db',
    expectedSource,
    expectedTarget,
    targetMigration: migration,
    targetRuntime: runtime,
    onProgress: ({ phase, ...counts }) => console.log(phase, counts),
  })
  console.log(receipt.status) // ready-for-explicit-cutover
} finally {
  await migration.end()
  await runtime.end()
}
```

The source must have the exact current, supported migration and value history;
the target must remain the exact empty database observed by preflight. A changed
source, non-empty target, malformed value, cancelled copy, lost connection, or
uncertain commit is non-success. Never infer success from equal row counts or a
driver return flag.

After a success receipt, explicitly start a PostgreSQL-selected gateway against
the same local `dataDir` and drive health, thread/replay, credential, and source
checks. SQLite remains the authority until that explicit cutover. Rollback means
reselecting the untouched SQLite source before PostgreSQL accepts new writes;
there is no reverse merge after the target receives new work.

## Failure behavior and limits

- A storage write is committed before its event is published live.
- Transaction callbacks are never replayed automatically after a database
  error, even when the driver calls the error retryable.
- If storage disappears mid-run, committed events remain replayable. A run
  whose terminal outcome could not be committed is recovered as
  `indeterminate`; Ownware does not fabricate completion or rerun the provider.
- PostgreSQL pool, statement, lock, migration, and shutdown timeouts are bounded
  through `storage.pool`.
- Multi-gateway live sessions/SSE, automatic failover, online dual-write/CDC,
  reverse transfer, replicas, sharding, and databases other than SQLite and the
  supported PostgreSQL versions are not supported by this release.

See [Storage performance](storage-performance.md) for reproducible measurements
and [Troubleshooting](../troubleshooting.md#data-migrations-backups-and-storage) for
failure codes and recovery checks.
