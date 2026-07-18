import { describe, expect, it } from 'vitest'
import {
  CSV_DATA_VIEW_IMPLEMENTATION,
  CsvDataViewError,
  profileCsvDataView,
  type CsvDataViewLimits,
} from '../../../src/gateway/csv-data-view.js'

const VERSION_A = '11111111-1111-4111-8111-111111111111'
const VERSION_B = '22222222-2222-4222-8222-222222222222'
const CHECKSUM = `sha256:${'a'.repeat(64)}`
const encoder = new TextEncoder()

describe('strict CSV Data View profiling', () => {
  it('profiles LF/CRLF records and RFC-style quoted string values', () => {
    const result = profile('Name,Note,Formula\r\nAda,"hello,\r\nworld","=2+2"\r\nBob,"said ""hi""",plain')

    expect(result).toMatchObject({
      implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
      sourceVersionId: VERSION_A,
      sourceChecksum: CHECKSUM,
      fieldCount: 3,
      rowCount: 2,
      fields: [
        { ordinal: 0, label: 'Name' },
        { ordinal: 1, label: 'Note' },
        { ordinal: 2, label: 'Formula' },
      ],
    })
    expect(result.rows.map((row) => row.values)).toEqual([
      ['Ada', 'hello,\r\nworld', '=2+2'],
      ['Bob', 'said "hi"', 'plain'],
    ])
    expect(result.fields.every((field) => /^field\.[0-9a-f]{32}$/.test(field.fieldId)))
      .toBe(true)
    expect(result.rows.every((row) => /^row\.[0-9a-f]{32}$/.test(row.rowId)))
      .toBe(true)
  })

  it('allows a header-only empty Data View and ignores one terminal record break', () => {
    expect(profile('left,right\n')).toMatchObject({ fieldCount: 2, rowCount: 0 })
  })

  it('derives stable identities within a version and different identities across versions', () => {
    const first = profile('name\nAda')
    const replay = profile('name\nAda')
    const later = profile('name\nAda', VERSION_B)

    expect(replay.fields[0]!.fieldId).toBe(first.fields[0]!.fieldId)
    expect(replay.rows[0]!.rowId).toBe(first.rows[0]!.rowId)
    expect(later.fields[0]!.fieldId).not.toBe(first.fields[0]!.fieldId)
    expect(later.rows[0]!.rowId).not.toBe(first.rows[0]!.rowId)
  })

  it.each([
    ['empty header', ',b\n1,2', 'csv_header_empty'],
    ['trim/case duplicate header', ' Name ,name\n1,2', 'csv_header_duplicate'],
    ['NFKC duplicate header', '\uff2eame,Name\n1,2', 'csv_header_duplicate'],
    ['quote in unquoted cell', 'a\nnot"valid', 'csv_quoting_invalid'],
    ['content after closing quote', 'a\n"value"tail', 'csv_quoting_invalid'],
    ['unclosed quote', 'a\n"value', 'csv_quoting_invalid'],
    ['bare carriage return', 'a\rb', 'csv_bare_carriage_return'],
    ['ragged row', 'a,b\n1', 'csv_row_ragged'],
  ])('rejects %s', (_label, csv, code) => {
    expectCsvError(() => profile(csv), code)
  })

  it('rejects invalid UTF-8 before returning any table', () => {
    expectCsvError(() => profileCsvDataView({
      bytes: Uint8Array.from([0x61, 0x0a, 0xc3, 0x28]),
      sourceVersionId: VERSION_A,
      sourceChecksum: CHECKSUM,
    }), 'csv_invalid_utf8')
  })

  it('enforces input, field, row, cell, total-cell and time limits', () => {
    expectCsvError(() => profile('a,b', VERSION_A, { maxBytes: 2 }),
      'csv_input_oversized')
    expectCsvError(() => profile('a,b', VERSION_A, { maxFields: 1 }),
      'csv_field_limit_exceeded')
    expectCsvError(() => profile('a\n1\n2', VERSION_A, { maxRows: 1 }),
      'csv_row_limit_exceeded')
    expectCsvError(() => profile('a\n123', VERSION_A, { maxCellBytes: 2 }),
      'csv_cell_limit_exceeded')
    expectCsvError(() => profile('a,b\n1,2', VERSION_A, { maxCells: 1 }),
      'csv_total_cell_limit_exceeded')

    let tick = 0
    expectCsvError(() => profileCsvDataView({
      bytes: encoder.encode('a\n1'),
      sourceVersionId: VERSION_A,
      sourceChecksum: CHECKSUM,
    }, limits({ timeoutMs: 1 }), () => tick++), 'csv_preparation_timeout')
  })

  it('rejects invalid immutable lineage identity', () => {
    expectCsvError(() => profileCsvDataView({
      bytes: encoder.encode('a'),
      sourceVersionId: 'not-a-version',
      sourceChecksum: CHECKSUM,
    }), 'csv_identity_invalid')
  })

  it('does not let an internal caller raise a fixed first-release bound', () => {
    expectCsvError(() => profile('a', VERSION_A, { maxFields: 257 }),
      'csv_identity_invalid')
  })
})

function profile(
  csv: string,
  sourceVersionId = VERSION_A,
  overrides: Partial<CsvDataViewLimits> = {},
) {
  return profileCsvDataView({
    bytes: encoder.encode(csv),
    sourceVersionId,
    sourceChecksum: CHECKSUM,
  }, limits(overrides))
}

function limits(overrides: Partial<CsvDataViewLimits>): CsvDataViewLimits {
  return {
    maxBytes: 16 * 1024 * 1024,
    maxFields: 256,
    maxRows: 100_000,
    maxCellBytes: 64 * 1024,
    maxCells: 1_000_000,
    timeoutMs: 5_000,
    ...overrides,
  }
}

function expectCsvError(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected CSV profiling to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(CsvDataViewError)
    expect((error as CsvDataViewError).code).toBe(code)
  }
}
