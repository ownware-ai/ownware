import { afterEach, beforeEach, describe, expect, it } from 'vitest'

export interface ContractRow {
  readonly id: string
  readonly parentId: string
  readonly ordinal: number
  readonly flag: boolean
  readonly epochMilliseconds: number
  readonly instant: string
  readonly payload: unknown
  readonly jsonBytes: string
  readonly bytes: Uint8Array
  readonly amount: number
  readonly note: string | null
}

export type ContractFilter =
  | { readonly column: 'parentId'; readonly value: string }
  | { readonly column: 'ordinal'; readonly value: number }
  | { readonly column: 'flag'; readonly value: boolean }
  | { readonly column: 'epochMilliseconds'; readonly value: number }
  | { readonly column: 'instant'; readonly value: string }
  | { readonly column: 'payload'; readonly value: unknown }
  | { readonly column: 'jsonBytes'; readonly value: string }
  | { readonly column: 'bytes'; readonly value: Uint8Array }
  | { readonly column: 'amount'; readonly value: number }
  | { readonly column: 'note'; readonly value: string | null }

export interface ContractRepository {
  createParent(id: string): Promise<void>
  insert(row: ContractRow): Promise<void>
  get(id: string): Promise<ContractRow | null>
  filterIds(filter: ContractFilter): Promise<readonly string[]>
  list(limit: number): Promise<readonly ContractRow[]>
  count(): Promise<number>
}

export interface ContractTransaction {
  readonly rows: ContractRepository
  savepoint<T>(fn: (nested: ContractTransaction) => Promise<T>): Promise<T>
}

export interface ContractAdapter {
  readonly rows: ContractRepository
  transaction<T>(fn: (tx: ContractTransaction) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export interface ContractResource {
  open(): Promise<ContractAdapter>
  dispose(): Promise<void>
}

export type ContractResourceFactory = () => Promise<ContractResource>

function row(id: string, overrides: Partial<ContractRow> = {}): ContractRow {
  return {
    id,
    parentId: 'parent-a',
    ordinal: 1,
    flag: true,
    epochMilliseconds: 1_785_662_400_123,
    instant: '2026-08-02T04:00:00.123Z',
    payload: { z: 1, a: ['first', { ok: true }] },
    jsonBytes: '{ "order": [2, 1] }',
    bytes: new Uint8Array([0, 1, 255]),
    amount: 1.25,
    note: null,
    ...overrides,
  }
}

/**
 * The same durable behaviour contract is invoked for every production adapter.
 * Adapter-specific setup/DDL remains in the resource factory.
 */
export function runStorageAdapterContract(
  name: string,
  createResource: ContractResourceFactory,
): void {
  describe(`storage adapter contract — ${name}`, () => {
    let resource: ContractResource
    let adapter: ContractAdapter

    beforeEach(async () => {
      resource = await createResource()
      adapter = await resource.open()
    })

    afterEach(async () => {
      await adapter.close()
      await resource.dispose()
    })

    it('round-trips every common value category and null', async () => {
      await adapter.rows.createParent('parent-a')
      const input = row('value-a', {
        ordinal: Number.MAX_SAFE_INTEGER,
        flag: false,
        payload: { unordered: { z: 1, a: 2 }, array: [2, 1] },
        amount: -0,
        note: 'line 1\nline 2\0',
      })
      await adapter.rows.insert(input)
      const result = await adapter.rows.get(input.id)
      expect(result).toEqual({ ...input, amount: 0 })
    })

    it('filters every common value category through the adapter boundary', async () => {
      const target = row('filter-target', { note: 'present' })
      await adapter.rows.createParent(target.parentId)
      await adapter.rows.insert(target)

      const cases: ReadonlyArray<{
        readonly filter: ContractFilter
        readonly changed: Partial<ContractRow>
      }> = [
        { filter: { column: 'parentId', value: target.parentId }, changed: { parentId: 'changed' } },
        { filter: { column: 'ordinal', value: target.ordinal }, changed: { ordinal: 2 } },
        { filter: { column: 'flag', value: target.flag }, changed: { flag: false } },
        {
          filter: { column: 'epochMilliseconds', value: target.epochMilliseconds },
          changed: { epochMilliseconds: target.epochMilliseconds + 1 },
        },
        {
          filter: { column: 'instant', value: target.instant },
          changed: { instant: '2026-08-02T04:00:00.124Z' },
        },
        { filter: { column: 'payload', value: target.payload }, changed: { payload: { changed: true } } },
        {
          filter: { column: 'jsonBytes', value: target.jsonBytes },
          changed: { jsonBytes: '{"order":[2,1]}' },
        },
        {
          filter: { column: 'bytes', value: target.bytes },
          changed: { bytes: new Uint8Array([0, 1, 254]) },
        },
        { filter: { column: 'amount', value: target.amount }, changed: { amount: 1.5 } },
        { filter: { column: 'note', value: target.note }, changed: { note: null } },
      ]

      for (const [index, entry] of cases.entries()) {
        const id = `filter-changed-${index}`
        const changed = row(id, {
          ...target,
          id,
          parentId: `filter-parent-${index}`,
          ...entry.changed,
        })
        await adapter.rows.createParent(changed.parentId)
        await adapter.rows.insert(changed)
        const matches = await adapter.rows.filterIds(entry.filter)
        expect(matches).toContain(target.id)
        expect(matches).not.toContain(id)
      }
    })

    it('makes committed state durable across close and reopen', async () => {
      await adapter.rows.createParent('parent-a')
      await adapter.rows.insert(row('durable'))
      await adapter.close()
      adapter = await resource.open()
      expect(await adapter.rows.get('durable')).toEqual(row('durable'))
    })

    it('commits a successful transaction and fully rolls back a failure', async () => {
      await adapter.rows.createParent('parent-a')
      await adapter.transaction(async (tx) => {
        await tx.rows.insert(row('committed-1', { ordinal: 1 }))
        await tx.rows.insert(row('committed-2', { ordinal: 2 }))
      })
      expect(await adapter.rows.count()).toBe(2)

      await expect(adapter.transaction(async (tx) => {
        await tx.rows.insert(row('rolled-back-1', { ordinal: 3 }))
        await tx.rows.insert(row('rolled-back-2', { ordinal: 4 }))
        throw new Error('synthetic transaction failure')
      })).rejects.toThrow('synthetic transaction failure')
      expect(await adapter.rows.count()).toBe(2)
      expect(await adapter.rows.get('rolled-back-1')).toBeNull()
    })

    it('uses explicit savepoints and keeps the outer transaction usable', async () => {
      await adapter.rows.createParent('parent-a')
      await adapter.transaction(async (tx) => {
        await tx.rows.insert(row('outer-before', { ordinal: 1 }))
        await expect(tx.savepoint(async (nested) => {
          await nested.rows.insert(row('inner-rollback', { ordinal: 2 }))
          throw new Error('synthetic savepoint failure')
        })).rejects.toThrow('synthetic savepoint failure')
        await tx.rows.insert(row('outer-after', { ordinal: 3 }))
      })
      expect((await adapter.rows.list(10)).map((entry) => entry.id))
        .toEqual(['outer-before', 'outer-after'])
      expect(await adapter.rows.get('inner-rollback')).toBeNull()
    })

    it('expires transaction repositories after commit', async () => {
      await adapter.rows.createParent('parent-a')
      let captured: ContractRepository | undefined
      await adapter.transaction(async (tx) => {
        captured = tx.rows
        await tx.rows.insert(row('inside'))
      })
      await expect(captured!.get('inside')).rejects.toThrow()
    })

    it('enforces primary, foreign-key and unique constraints', async () => {
      await adapter.rows.createParent('parent-a')
      await adapter.rows.insert(row('one', { ordinal: 1 }))
      await expect(adapter.rows.insert(row('one', { ordinal: 2 }))).rejects.toThrow()
      await expect(adapter.rows.insert(row('two', { ordinal: 1 }))).rejects.toThrow()
      await expect(adapter.rows.insert(row('orphan', {
        parentId: 'missing-parent',
        ordinal: 3,
      }))).rejects.toThrow()
      expect(await adapter.rows.count()).toBe(1)
    })

    it('orders and limits by the declared ordinal/id tuple', async () => {
      await adapter.rows.createParent('parent-a')
      await adapter.rows.createParent('parent-b')
      await adapter.rows.insert(row('z-last-tie', { ordinal: 2 }))
      await adapter.rows.insert(row('a-first-tie', {
        parentId: 'parent-b',
        ordinal: 2,
      }))
      await adapter.rows.insert(row('middle', { ordinal: 1 }))
      await adapter.rows.insert(row('first', { ordinal: -1 }))
      expect((await adapter.rows.list(3)).map((entry) => entry.id))
        .toEqual(['first', 'middle', 'a-first-tie'])
    })

    it('rejects malformed values before they become durable', async () => {
      await adapter.rows.createParent('parent-a')
      await expect(adapter.rows.insert(row('unsafe-integer', {
        ordinal: Number.MAX_SAFE_INTEGER + 1,
      }))).rejects.toThrow()
      await expect(adapter.rows.insert(row('bad-instant', {
        instant: '2026-08-02T04:00:60Z',
      }))).rejects.toThrow()
      await expect(adapter.rows.insert(row('bad-real', {
        amount: Number.NaN,
      }))).rejects.toThrow()
      expect(await adapter.rows.count()).toBe(0)
    })

    it('closes idempotently and rejects use after close', async () => {
      await adapter.close()
      await adapter.close()
      await expect(adapter.rows.count()).rejects.toThrow()
    })
  })
}
