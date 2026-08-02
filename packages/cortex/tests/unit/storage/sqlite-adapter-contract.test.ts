import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeStorageValue,
} from '../../../src/storage/value-codec.js'
import type { TransactionStorage } from '../../../src/storage/contracts.js'
import {
  SqliteStorageAdapter,
  type SqliteRootRepositoryContext,
  type SqliteTransactionRepositoryContext,
} from '../../../src/storage/sqlite-adapter.js'
import {
  runStorageAdapterContract,
  type ContractAdapter,
  type ContractFilter,
  type ContractRepository,
  type ContractResource,
  type ContractRow,
  type ContractTransaction,
} from '../../storage/adapter-contract.js'

interface ContractSqliteRow {
  readonly id: string
  readonly parent_id: string
  readonly ordinal: number
  readonly flag: number
  readonly epoch_milliseconds: number
  readonly instant: string
  readonly payload: string
  readonly json_bytes: string
  readonly bytes: Uint8Array
  readonly amount: number
  readonly note: string | null
}

interface ContractRepositories {
  readonly rows: ContractRepository
}

function normalizeInput(input: ContractRow): ContractRow {
  const payloadText = JSON.stringify(input.payload)
  normalizeStorageValue('json-value', payloadText)
  return {
    id: normalizeStorageValue('text', input.id) as string,
    parentId: normalizeStorageValue('text', input.parentId) as string,
    ordinal: normalizeStorageValue('safe-integer', input.ordinal) as number,
    flag: normalizeStorageValue('boolean', input.flag) as boolean,
    epochMilliseconds: normalizeStorageValue(
      'epoch-milliseconds',
      input.epochMilliseconds,
    ) as number,
    instant: normalizeStorageValue('iso-instant', input.instant) as string,
    payload: JSON.parse(payloadText) as unknown,
    jsonBytes: normalizeStorageValue('json-bytes', input.jsonBytes) as string,
    bytes: normalizeStorageValue('binary', input.bytes) as Uint8Array,
    amount: normalizeStorageValue('finite-real', input.amount) as number,
    note: input.note === null
      ? null
      : normalizeStorageValue('text', input.note) as string,
  }
}

function mapRow(row: ContractSqliteRow): ContractRow {
  return {
    id: row.id,
    parentId: row.parent_id,
    ordinal: normalizeStorageValue('safe-integer', row.ordinal) as number,
    flag: normalizeStorageValue('boolean', row.flag) as boolean,
    epochMilliseconds: normalizeStorageValue(
      'epoch-milliseconds',
      row.epoch_milliseconds,
    ) as number,
    instant: normalizeStorageValue('iso-instant', row.instant) as string,
    payload: normalizeStorageValue('json-value', row.payload),
    jsonBytes: normalizeStorageValue('json-bytes', row.json_bytes) as string,
    bytes: normalizeStorageValue('binary', row.bytes) as Uint8Array,
    amount: normalizeStorageValue('finite-real', row.amount) as number,
    note: row.note,
  }
}

class SqliteContractRepository implements ContractRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly assertScopeActive: () => void,
  ) {}

  private assertActive(): void {
    this.assertScopeActive()
  }

  async createParent(id: string): Promise<void> {
    this.assertActive()
    this.db.prepare(`INSERT INTO contract_parents (id) VALUES (?)`).run(id)
  }

  async insert(input: ContractRow): Promise<void> {
    this.assertActive()
    const row = normalizeInput(input)
    this.db.prepare(`
      INSERT INTO contract_values (
        id, parent_id, ordinal, flag, epoch_milliseconds,
        instant, payload, json_bytes, bytes, amount, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.parentId,
      row.ordinal,
      row.flag ? 1 : 0,
      row.epochMilliseconds,
      row.instant,
      JSON.stringify(row.payload),
      row.jsonBytes,
      row.bytes,
      row.amount,
      row.note,
    )
  }

  async get(id: string): Promise<ContractRow | null> {
    this.assertActive()
    const row = this.db.prepare(
      `SELECT * FROM contract_values WHERE id = ?`,
    ).get(id) as ContractSqliteRow | undefined
    return row === undefined ? null : mapRow(row)
  }

  async filterIds(filter: ContractFilter): Promise<readonly string[]> {
    this.assertActive()
    const [column, value] = normalizeFilter(filter)
    const operator = filter.column === 'note' ? 'IS' : '='
    return (this.db.prepare(`
      SELECT id FROM contract_values
      WHERE ${column} ${operator} ?
      ORDER BY id ASC
    `).all(value) as Array<{ id: string }>).map((row) => row.id)
  }

  async list(limit: number): Promise<readonly ContractRow[]> {
    this.assertActive()
    const rows = this.db.prepare(`
      SELECT * FROM contract_values
      ORDER BY ordinal ASC, id ASC
      LIMIT ?
    `).all(limit) as ContractSqliteRow[]
    return rows.map(mapRow)
  }

  async count(): Promise<number> {
    this.assertActive()
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM contract_values`).get() as {
      count: number
    }
    return row.count
  }
}

function createContractTables(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_parents (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS contract_values (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES contract_parents(id),
      ordinal INTEGER NOT NULL,
      flag INTEGER NOT NULL CHECK (flag IN (0, 1)),
      epoch_milliseconds INTEGER NOT NULL,
      instant TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      json_bytes TEXT NOT NULL,
      bytes BLOB NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      UNIQUE (parent_id, ordinal)
    );
  `)
}

function repositories(
  context: SqliteRootRepositoryContext | SqliteTransactionRepositoryContext,
): ContractRepositories {
  return {
    rows: new SqliteContractRepository(context.database, context.assertActive),
  }
}

function transactionView(
  transaction: TransactionStorage<ContractRepositories>,
): ContractTransaction {
  return {
    rows: transaction.repositories.rows,
    savepoint: async <T>(fn: (nested: ContractTransaction) => Promise<T>): Promise<T> =>
      transaction.savepoint(async (nested) => fn(transactionView(nested))),
  }
}

class SqliteContractResource implements ContractResource {
  private readonly dir = mkdtempSync(join(tmpdir(), 'cortex-sqlite-contract-'))
  private readonly dbPath = join(this.dir, 'contract.db')

  async open(): Promise<ContractAdapter> {
    const storage = new SqliteStorageAdapter<ContractRepositories, ContractRepositories>({
      dbPath: this.dbPath,
      openMode: 'on-initialize',
      repositories: {
        createRoot(context) {
          createContractTables(context.database)
          return repositories(context)
        },
        createTransaction: repositories,
      },
    })
    await storage.initialize()
    return {
      rows: storage.repositories.rows,
      transaction: async <T>(fn: (tx: ContractTransaction) => Promise<T>): Promise<T> =>
        storage.transaction({
          mode: 'write',
          isolation: 'serializable',
          retry: 'never',
        }, async (transaction) => fn(transactionView(transaction))),
      close: async () => storage.close(),
    }
  }

  async dispose(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

function normalizeFilter(filter: ContractFilter): readonly [string, unknown] {
  switch (filter.column) {
    case 'parentId': return ['parent_id', normalizeStorageValue('text', filter.value)]
    case 'ordinal': return ['ordinal', normalizeStorageValue('safe-integer', filter.value)]
    case 'flag': return ['flag', normalizeStorageValue('boolean', filter.value) ? 1 : 0]
    case 'epochMilliseconds': return [
      'epoch_milliseconds',
      normalizeStorageValue('epoch-milliseconds', filter.value),
    ]
    case 'instant': return ['instant', normalizeStorageValue('iso-instant', filter.value)]
    case 'payload': {
      const value = JSON.stringify(filter.value)
      normalizeStorageValue('json-value', value)
      return ['payload', value]
    }
    case 'jsonBytes': return [
      'json_bytes',
      normalizeStorageValue('json-bytes', filter.value),
    ]
    case 'bytes': return ['bytes', normalizeStorageValue('binary', filter.value)]
    case 'amount': return ['amount', normalizeStorageValue('finite-real', filter.value)]
    case 'note': return [
      'note',
      filter.value === null ? null : normalizeStorageValue('text', filter.value),
    ]
  }
}

runStorageAdapterContract('SQLite', async () => new SqliteContractResource())
