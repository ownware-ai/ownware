import { describe, expect, it } from 'vitest'
import {
  CanonicalStorageDigestError,
  CanonicalTableDigest,
  digestCanonicalDatabase,
} from '../../../src/storage/canonical-storage-digest.js'
import type { LogicalColumnDescriptor } from '../../../src/storage/logical-schema.js'
import type { LogicalValueKind } from '../../../src/storage/value-codec.js'

function column(
  name: string,
  kind: LogicalValueKind,
  options: { readonly nullable?: boolean; readonly pkPosition?: number } = {},
): LogicalColumnDescriptor {
  const nullable = options.nullable ?? false
  const pkPosition = options.pkPosition ?? 0
  return {
    table: 'probe',
    name,
    key: `probe.${name}`,
    declaredType: kind === 'finite-real'
      ? 'REAL'
      : kind === 'safe-integer' || kind === 'epoch-milliseconds' || kind === 'boolean'
        ? 'INTEGER'
        : kind === 'binary' ? 'BLOB' : 'TEXT',
    notNull: !nullable,
    nullable,
    defaultValue: null,
    pkPosition,
    hidden: 0,
    kind,
    postgresqlType: kind === 'finite-real'
      ? 'DOUBLE PRECISION'
      : kind === 'safe-integer' || kind === 'epoch-milliseconds'
        ? 'BIGINT'
        : kind === 'boolean'
          ? 'BOOLEAN'
          : kind === 'binary' ? 'BYTEA' : 'TEXT',
    postgresqlProjection: 'identity',
  }
}

const columns = [
  column('id', 'text', { pkPosition: 1 }),
  column('integer', 'safe-integer'),
  column('flag', 'boolean'),
  column('real', 'finite-real'),
  column('instant', 'iso-instant'),
  column('json', 'json-value'),
  column('exact', 'json-bytes'),
  column('bytes', 'binary'),
  column('note', 'text', { nullable: true }),
] as const

function digest(rows: readonly (readonly unknown[])[]) {
  const builder = new CanonicalTableDigest(columns)
  rows.forEach((row, rowOrdinal) => builder.append(rowOrdinal, row))
  return builder.finish()
}

function row(overrides: Partial<Record<number, unknown>> = {}): readonly unknown[] {
  const value: unknown[] = [
    'row-a',
    7,
    true,
    1.25,
    '2026-08-02T00:00:00.000Z',
    '{"a":1,"b":[true,null]}',
    '{ "exact": true }',
    new Uint8Array([0, 1, 255]),
    null,
  ]
  for (const [index, replacement] of Object.entries(overrides)) {
    value[Number(index)] = replacement
  }
  return value
}

describe('canonical storage digest', () => {
  it('matches equivalent SQLite/PostgreSQL driver values without exposing rows', () => {
    const sqlite = digest([row({ 1: 7n, 2: 1, 5: '{ "b": [true,null], "a": 1 }' })])
    const postgresql = digest([row({ 1: '7', 2: true, 5: '{"a":1,"b":[true,null]}' })])
    expect(sqlite).toEqual(postgresql)
    expect(sqlite).toMatchObject({ table: 'probe', rowCount: 1, cellCount: columns.length })
    expect(JSON.stringify(sqlite)).not.toContain('row-a')
    expect(JSON.stringify(sqlite)).not.toContain('exact')
  })

  it('distinguishes null, type, framing, exact bytes and row order adversaries', () => {
    const base = digest([row()]).digest
    for (const changed of [
      row({ 1: 8 }),
      row({ 7: new Uint8Array([0, 1, 254]) }),
      row({ 8: 'null' }),
      row({ 6: '{"exact":true}' }),
    ]) {
      expect(digest([changed]).digest).not.toBe(base)
    }
    expect(digest([row({ 0: 'ab', 8: 'c' })]).digest)
      .not.toBe(digest([row({ 0: 'a', 8: 'bc' })]).digest)
    expect(digest([row({ 0: 'a' }), row({ 0: 'b' })]).digest)
      .not.toBe(digest([row({ 0: 'b' }), row({ 0: 'a' })]).digest)
  })

  it('preserves JSON array order but ignores semantic object-key order', () => {
    expect(digest([row({ 5: '{"z":2,"a":1}' })]).digest)
      .toBe(digest([row({ 5: '{ "a": 1, "z": 2 }' })]).digest)
    expect(digest([row({ 5: '[1,2]' })]).digest)
      .not.toBe(digest([row({ 5: '[2,1]' })]).digest)
  })

  it('streams a large table while retaining only counts and one hash state', () => {
    const builder = new CanonicalTableDigest(columns)
    for (let index = 0; index < 20_000; index += 1) {
      builder.append(index, row({ 0: `row-${String(index).padStart(5, '0')}` }))
    }
    expect(builder.finish()).toMatchObject({
      rowCount: 20_000,
      cellCount: 20_000 * columns.length,
    })
    expect(builder.finish()).toEqual(builder.finish())
  })

  it('fails content-free for invalid values, schema, ordinals and cell counts', () => {
    const canary = 'customer-secret-canary'
    const builder = new CanonicalTableDigest(columns)
    let error: unknown
    try {
      builder.append(0, row({ 1: canary }))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      code: 'value_invalid',
      table: 'probe',
      column: 'integer',
      rowOrdinal: 0,
      reason: 'type_mismatch',
    })
    expect(String(error)).not.toContain(canary)
    expect(() => builder.append(1, row())).toThrow(CanonicalStorageDigestError)
    expect(() => new CanonicalTableDigest(columns).append(0, row().slice(1)))
      .toThrow(CanonicalStorageDigestError)
    expect(() => new CanonicalTableDigest([])).toThrow(CanonicalStorageDigestError)
  })

  it('combines exact unique table receipts without raw data', () => {
    const first = digest([row()])
    const second = { ...digest([]), table: 'second' }
    const receipt = digestCanonicalDatabase([second, first])
    expect(receipt).toMatchObject({
      tableCount: 2,
      rowCount: 1,
      cellCount: columns.length,
    })
    expect(() => digestCanonicalDatabase([first, first])).toThrow(
      CanonicalStorageDigestError,
    )
  })
})
