#!/usr/bin/env node

/**
 * Generate the immutable PostgreSQL introduction baseline from a fresh,
 * migration-certified SQLite v82 database plus the logical column classifier.
 *
 * Run after `bun run build` from packages/cortex. The generated production file
 * contains no customer data and has no runtime dependency on SQLite.
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CORTEX_ROOT = join(SCRIPT_DIR, '..')
const OUTPUT_PATH = join(CORTEX_ROOT, 'src/storage/postgresql-baseline.ts')
const BASELINE_VERSION = 82
const require = createRequire(join(CORTEX_ROOT, 'package.json'))
const Database = require('better-sqlite3')

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalHash(value) {
  return hash(JSON.stringify(value))
}

function extractChecks(createSql) {
  const checks = []
  const upper = createSql.toUpperCase()
  let cursor = 0
  while (cursor < createSql.length) {
    const index = upper.indexOf('CHECK', cursor)
    if (index < 0) break
    const before = index === 0 ? '' : createSql[index - 1]
    const after = createSql[index + 5] ?? ''
    if (/\w/.test(before) || /\w/.test(after)) {
      cursor = index + 5
      continue
    }
    let open = index + 5
    while (/\s/.test(createSql[open] ?? '')) open += 1
    if (createSql[open] !== '(') throw new Error('CHECK without opening parenthesis')
    let depth = 0
    let quote = null
    let close = -1
    for (let position = open; position < createSql.length; position += 1) {
      const char = createSql[position]
      if (quote !== null) {
        if (char === quote) {
          if (createSql[position + 1] === quote) position += 1
          else quote = null
        }
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
      } else if (char === '(') {
        depth += 1
      } else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          close = position
          break
        }
      }
    }
    if (close < 0) throw new Error('Unbalanced CHECK expression')
    checks.push(createSql.slice(open + 1, close).trim())
    cursor = close + 1
  }
  return checks
}

function transformGlob(expression) {
  let transformed = expression.replace(
    /(substr\([^)]*\)|[a-z_][a-z0-9_]*)\s+NOT\s+GLOB\s+'\*\[\^([^']+)\]\*'/gi,
    (_match, value, characters) => `${value} !~ '[^${characters}]'`,
  )
  transformed = transformed.replace(
    /([a-z_][a-z0-9_]*)\s+GLOB\s+'sha256:\[0-9a-f\]\*'/gi,
    (_match, value) => `${value} ~ '^sha256:[0-9a-f]+$'`,
  )
  if (/\bGLOB\b/i.test(transformed)) {
    throw new Error(`Unsupported SQLite GLOB expression: ${expression}`)
  }
  return transformed
}

function transformCheck(expression) {
  let transformed = transformGlob(expression)
  transformed = transformed.replace(
    /json_type\(\s*([a-z_][a-z0-9_]*)\s*\)\s*=\s*'(array|object)'/gi,
    (_match, value, kind) => `(${value} IS JSON ${String(kind).toUpperCase()})`,
  )
  transformed = transformed.replace(
    /json_valid\(\s*([a-z_][a-z0-9_]*)\s*\)/gi,
    '($1 IS JSON)',
  )
  transformed = transformed.replace(
    /json_array_length\(\s*([a-z_][a-z0-9_]*)\s*\)/gi,
    'json_array_length(($1)::json)',
  )
  return transformed
}

function defaultSql(column) {
  if (column.defaultValue === null) return ''
  const raw = String(column.defaultValue).trim().replace(/^\((.*)\)$/s, '$1')
  if (/^datetime\(\s*'now'\s*\)$/i.test(raw)) {
    return " DEFAULT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')"
  }
  if (column.kind === 'boolean') {
    if (raw === '0') return ' DEFAULT FALSE'
    if (raw === '1') return ' DEFAULT TRUE'
    throw new Error(`Unsupported boolean default: ${column.key}`)
  }
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw) || /^'(?:[^']|'')*'$/.test(raw)) {
    return ` DEFAULT ${raw}`
  }
  throw new Error(`Unsupported SQLite default: ${column.key}=${raw}`)
}

function constraintName(prefix, table, ordinal) {
  const base = `${prefix}_${table}_${ordinal}`
  if (base.length <= 63) return base
  return `${base.slice(0, 50)}_${hash(base).slice(7, 18)}`
}

function groupForeignKeys(rows) {
  const groups = new Map()
  for (const row of rows) {
    const group = groups.get(row.id) ?? []
    group.push(row)
    groups.set(row.id, group)
  }
  return [...groups.values()].map((group) => group.sort((left, right) => left.seq - right.seq))
}

function collectManifest(db) {
  const tableRows = db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all()
  const indexSql = new Map(db.prepare(`
    SELECT name, sql
    FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => [row.name, row.sql]))
  return tableRows.map((table) => {
    const quoted = quoteIdentifier(table.name)
    return {
      name: table.name,
      createSql: table.sql,
      columns: db.prepare(`PRAGMA table_xinfo(${quoted})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quoted})`).all(),
      indexes: db.prepare(`PRAGMA index_list(${quoted})`).all().map((index) => ({
        ...index,
        createSql: indexSql.get(index.name) ?? null,
        columns: db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all(),
      })),
    }
  })
}

function buildBaseline(tables, classifyLogicalColumns) {
  const physicalColumns = tables.flatMap((table) => table.columns.map((column) => ({
    table: table.name,
    name: column.name,
    declaredType: column.type,
    notNull: column.notnull === 1,
    defaultValue: column.dflt_value,
    pkPosition: column.pk,
    hidden: column.hidden,
  })))
  const logicalColumns = classifyLogicalColumns(physicalColumns)
  const byTable = Map.groupBy(logicalColumns, (column) => column.table)
  const statements = []
  statements.push(`CREATE OR REPLACE FUNCTION ${quoteIdentifier('ownware')}.${quoteIdentifier('_is_iso_instant')}(value TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value !~ '^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?Z|[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})$' THEN
    RETURN FALSE;
  END IF;
  PERFORM value::timestamp;
  RETURN TRUE;
EXCEPTION WHEN others THEN
  RETURN FALSE;
END
$$`)

  const primaryKeys = []
  const uniqueConstraints = []
  const foreignKeys = []
  const explicitIndexes = []

  for (const table of tables) {
    const columns = byTable.get(table.name) ?? []
    const definitions = []
    for (const column of columns) {
      const identity = column.pkPosition > 0 && columns.filter((entry) => entry.pkPosition > 0).length === 1 &&
        column.postgresqlType === 'BIGINT'
        ? ' GENERATED BY DEFAULT AS IDENTITY'
        : ''
      const nullable = column.nullable ? '' : ' NOT NULL'
      definitions.push(
        `  ${quoteIdentifier(column.name)} ${column.postgresqlType}${identity}${nullable}${defaultSql(column)}`,
      )
    }

    const pk = columns
      .filter((column) => column.pkPosition > 0)
      .sort((left, right) => left.pkPosition - right.pkPosition)
    if (pk.length > 0) {
      definitions.push(`  PRIMARY KEY (${pk.map((column) => quoteIdentifier(column.name)).join(', ')})`)
      primaryKeys.push({ table: table.name, columns: pk.map((column) => column.name) })
    }

    const unique = table.indexes
      .filter((index) => index.origin === 'u')
      .sort((left, right) => left.name.localeCompare(right.name))
    unique.forEach((index, ordinal) => {
      const columnNames = index.columns
        .filter((column) => column.key === 1)
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name)
      definitions.push(
        `  CONSTRAINT ${quoteIdentifier(constraintName('uq', table.name, ordinal + 1))} ` +
        `UNIQUE (${columnNames.map(quoteIdentifier).join(', ')})`,
      )
      uniqueConstraints.push({ table: table.name, columns: columnNames })
    })

    extractChecks(table.createSql).forEach((check, ordinal) => {
      definitions.push(
        `  CONSTRAINT ${quoteIdentifier(constraintName('ck_sqlite', table.name, ordinal + 1))} ` +
        `CHECK (${transformCheck(check)})`,
      )
    })

    let semanticOrdinal = 0
    for (const column of columns) {
      let expression = null
      if (column.kind === 'safe-integer' || column.kind === 'epoch-milliseconds') {
        expression = `${quoteIdentifier(column.name)} BETWEEN -9007199254740991 AND 9007199254740991`
      } else if (column.kind === 'finite-real') {
        expression = `${quoteIdentifier(column.name)} NOT IN ('Infinity'::DOUBLE PRECISION, '-Infinity'::DOUBLE PRECISION, 'NaN'::DOUBLE PRECISION)`
      } else if (column.kind === 'iso-instant') {
        expression = `${quoteIdentifier('ownware')}.${quoteIdentifier('_is_iso_instant')}(${quoteIdentifier(column.name)})`
      } else if (column.kind === 'json-value') {
        expression = `${quoteIdentifier(column.name)} IS JSON`
      }
      if (expression !== null) {
        semanticOrdinal += 1
        definitions.push(
          `  CONSTRAINT ${quoteIdentifier(constraintName('ck_semantic', table.name, semanticOrdinal))} ` +
          `CHECK (${quoteIdentifier(column.name)} IS NULL OR (${expression}))`,
        )
      }
    }

    statements.push(`CREATE TABLE ${quoteIdentifier(table.name)} (\n${definitions.join(',\n')}\n)`)

    for (const group of groupForeignKeys(table.foreignKeys)) {
      const first = group[0]
      const from = group.map((row) => row.from)
      const to = group.map((row) => row.to)
      const descriptor = {
        table: table.name,
        columns: from,
        referencedTable: first.table,
        referencedColumns: to,
        onUpdate: first.on_update,
        onDelete: first.on_delete,
        deferred: table.name === 'access_grants' && first.table === 'access_grant_revisions',
      }
      foreignKeys.push(descriptor)
    }

    for (const index of table.indexes.filter((entry) => entry.origin === 'c')) {
      if (index.createSql === null) throw new Error(`Missing SQL for index ${index.name}`)
      const columns = index.columns
        .filter((column) => column.key === 1)
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => ({ name: column.name, descending: column.desc === 1 }))
      if (columns.some((column) => column.name === null)) {
        throw new Error(`Expression index is not supported: ${index.name}`)
      }
      const whereMatch = /\bWHERE\b([\s\S]*)$/i.exec(index.createSql)
      const predicate = whereMatch === null ? null : transformCheck(whereMatch[1].trim())
      explicitIndexes.push({
        table: table.name,
        name: index.name,
        unique: index.unique === 1,
        columns,
        predicate,
      })
    }
  }

  // Unique indexes referenced by a foreign key must exist before PostgreSQL
  // accepts the FK constraint. SQLite permitted these to be created in either
  // order across its migration history.
  explicitIndexes.sort((left, right) => left.name.localeCompare(right.name))
  for (const index of explicitIndexes) {
    statements.push(
      `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(index.name)} ` +
      `ON ${quoteIdentifier(index.table)} (` +
      `${index.columns.map((column) => `${quoteIdentifier(column.name)}${column.descending ? ' DESC' : ''}`).join(', ')})` +
      `${index.predicate === null ? '' : ` WHERE ${index.predicate}`}`,
    )
  }

  foreignKeys.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  foreignKeys.forEach((foreignKey, ordinal) => {
    const update = foreignKey.onUpdate === 'NO ACTION' ? '' : ` ON UPDATE ${foreignKey.onUpdate}`
    const deletion = foreignKey.onDelete === 'NO ACTION' ? '' : ` ON DELETE ${foreignKey.onDelete}`
    const deferred = foreignKey.deferred ? ' DEFERRABLE INITIALLY DEFERRED' : ''
    statements.push(
      `ALTER TABLE ${quoteIdentifier(foreignKey.table)} ADD CONSTRAINT ` +
      `${quoteIdentifier(constraintName('fk', foreignKey.table, ordinal + 1))} ` +
      `FOREIGN KEY (${foreignKey.columns.map(quoteIdentifier).join(', ')}) ` +
      `REFERENCES ${quoteIdentifier(foreignKey.referencedTable)} ` +
      `(${foreignKey.referencedColumns.map(quoteIdentifier).join(', ')})${update}${deletion}${deferred}`,
    )
  })

  // SQLite's six effect-boundary triggers collapse onto three PostgreSQL
  // trigger functions while retaining six named trigger events. These are
  // invariants, not optional repository behavior: direct SQL cannot mutate
  // immutable grant history/receipts or move a grant head non-monotonically.
  statements.push(`CREATE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23000', MESSAGE = 'immutable storage record';
END
$$`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('access_grant_revisions_no_delete')}
BEFORE DELETE ON ${quoteIdentifier('access_grant_revisions')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('access_grant_revisions_no_update')}
BEFORE UPDATE ON ${quoteIdentifier('access_grant_revisions')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()`)
  statements.push(`CREATE FUNCTION ${quoteIdentifier('_validate_access_grant_head')}()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.current_revision <> OLD.current_revision + 1
    OR NOT EXISTS (
      SELECT 1 FROM ${quoteIdentifier('ownware')}.${quoteIdentifier('access_grant_revisions')} AS revision
      WHERE revision.grant_id = OLD.grant_id
        AND revision.revision = NEW.current_revision
        AND revision.workspace_id = OLD.workspace_id
        AND revision.profile_id = OLD.profile_id
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23000', MESSAGE = 'invalid access grant head transition';
  END IF;
  RETURN NEW;
END
$$`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('access_grants_monotonic_head')}
BEFORE UPDATE ON ${quoteIdentifier('access_grants')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_validate_access_grant_head')}()`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('access_grants_no_delete')}
BEFORE DELETE ON ${quoteIdentifier('access_grants')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('channel_receipts_no_delete')}
BEFORE DELETE ON ${quoteIdentifier('channel_receipts')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()`)
  statements.push(`CREATE TRIGGER ${quoteIdentifier('channel_receipts_no_update')}
BEFORE UPDATE ON ${quoteIdentifier('channel_receipts')}
FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier('_reject_immutable_mutation')}()`)

  const ddl = `${statements.join(';\n\n')};\n`
  const schemaManifest = {
    columns: logicalColumns.map((column) => ({
      table: column.table,
      name: column.name,
      type: column.postgresqlType,
      nullable: column.nullable,
      pkPosition: column.pkPosition,
    })),
    primaryKeys: primaryKeys.sort((left, right) => left.table.localeCompare(right.table)),
    uniqueConstraints: uniqueConstraints.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    foreignKeys,
    explicitIndexes,
  }
  return {
    ddl,
    ddlHash: hash(ddl),
    schemaHash: canonicalHash(schemaManifest),
    schemaManifest,
    summary: {
      tableCount: tables.length,
      columnCount: logicalColumns.length,
      foreignKeyCount: foreignKeys.length,
      uniqueConstraintCount: uniqueConstraints.length,
      explicitIndexCount: explicitIndexes.length,
      triggerCount: 6,
    },
  }
}

const schemaModule = await import(pathToFileURL(join(CORTEX_ROOT, 'dist/gateway/db/schema.js')).href)
const safetyModule = await import(pathToFileURL(join(CORTEX_ROOT, 'dist/gateway/db/migration-safety.js')).href)
const logicalModule = await import(pathToFileURL(join(CORTEX_ROOT, 'dist/storage/logical-schema.js')).href)

const tempDir = mkdtempSync(join(tmpdir(), 'ownware-postgresql-baseline-'))
const dbPath = join(tempDir, 'source.db')
const db = new Database(dbPath)
try {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  const originalLog = console.log
  try {
    console.log = () => {}
    safetyModule.runMigrationsSafely(
      db,
      dbPath,
      schemaModule.MIGRATIONS.filter((migration) => migration.version <= BASELINE_VERSION),
    )
  } finally {
    console.log = originalLog
  }
  const tables = collectManifest(db)
  const baseline = buildBaseline(tables, logicalModule.classifyLogicalColumns)
  const source = `// Generated by scripts/generate-postgresql-baseline.mjs. Do not hand-edit.\n` +
    `// Source authority: fresh SQLite migration 82 + storage/logical-schema.ts.\n\n` +
    `export const POSTGRESQL_BASELINE_VERSION = ${BASELINE_VERSION} as const\n` +
    `export const POSTGRESQL_BASELINE_NAME = 'postgresql_baseline_v${BASELINE_VERSION}' as const\n` +
    `export const POSTGRESQL_BASELINE_DDL_HASH = '${baseline.ddlHash}' as const\n` +
    `export const POSTGRESQL_BASELINE_SCHEMA_HASH = '${baseline.schemaHash}' as const\n` +
    `export const POSTGRESQL_BASELINE_SUMMARY = ${JSON.stringify(baseline.summary, null, 2)} as const\n\n` +
    `export const POSTGRESQL_BASELINE_MANIFEST = ${JSON.stringify(baseline.schemaManifest, null, 2)} as const\n\n` +
    `export const POSTGRESQL_BASELINE_SQL = String.raw\`${baseline.ddl}\`\n`
  writeFileSync(OUTPUT_PATH, source, { encoding: 'utf8', mode: 0o644 })
  console.log(JSON.stringify({ output: OUTPUT_PATH, ...baseline.summary, ddlHash: baseline.ddlHash, schemaHash: baseline.schemaHash }, null, 2))
} finally {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
}
