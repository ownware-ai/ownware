import { describe, expect, it } from 'vitest'
import {
  CSV_DATA_VIEW_SELECTION_MAX_CELLS,
  CsvDataViewSelectionError,
  selectCsvDataView,
} from '../../../src/gateway/csv-data-view-selection.js'
import {
  csvDataViewOrdinalId,
  profileCsvDataView,
} from '../../../src/gateway/csv-data-view.js'

const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const CHECKSUM = `sha256:${'a'.repeat(64)}`

describe('bounded CSV Data View selection', () => {
  const profile = profileCsvDataView({
    bytes: Buffer.from('name,formula,city\nAda,=2+2,London\nBob,@SUM(A1),Sydney'),
    sourceVersionId: VERSION_ID,
    sourceChecksum: CHECKSUM,
  })
  const nameId = csvDataViewOrdinalId('field', VERSION_ID, 0)
  const formulaId = csvDataViewOrdinalId('field', VERSION_ID, 1)

  it('selects stable field IDs and a bounded row window in deterministic order', () => {
    const input = {
      fieldIds: [formulaId, nameId],
      rowOffset: 1,
      rowCount: 1,
    } as const

    const first = selectCsvDataView(profile, input)
    const replay = selectCsvDataView(profile, input)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      implementationVersion: 'csv_data_view_selection.v1',
      sourceVersionId: VERSION_ID,
      rowOffset: 1,
      requestedRowCount: 1,
      returnedRowCount: 1,
      totalRowCount: 2,
      complete: true,
      fields: [
        { fieldId: formulaId, ordinal: 1, label: 'formula' },
        { fieldId: nameId, ordinal: 0, label: 'name' },
      ],
      rows: [{
        rowId: csvDataViewOrdinalId('row', VERSION_ID, 1),
        ordinal: 1,
        values: ['@SUM(A1)', 'Bob'],
      }],
    })
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(first.rows[0]!.values[0]).toBe('@SUM(A1)')
  })

  it('reports incomplete windows without returning a whole-table fallback', () => {
    expect(selectCsvDataView(profile, {
      fieldIds: [nameId],
      rowOffset: 0,
      rowCount: 1,
    })).toMatchObject({
      returnedRowCount: 1,
      totalRowCount: 2,
      complete: false,
      rows: [{ ordinal: 0, values: ['Ada'] }],
    })
  })

  it.each([
    [{ fieldIds: [], rowOffset: 0, rowCount: 1 }, 'selection_fields_invalid'],
    [{ fieldIds: [nameId, nameId], rowOffset: 0, rowCount: 1 }, 'selection_fields_invalid'],
    [{ fieldIds: ['field.00000000000000000000000000000000'], rowOffset: 0, rowCount: 1 }, 'selection_field_unknown'],
    [{ fieldIds: [nameId], rowOffset: -1, rowCount: 1 }, 'selection_window_invalid'],
    [{ fieldIds: [nameId], rowOffset: 0, rowCount: 0 }, 'selection_window_invalid'],
    [{ fieldIds: [nameId], rowOffset: 3, rowCount: 1 }, 'selection_window_invalid'],
  ] as const)('fails closed for invalid selection %#', (input, code) => {
    expect(() => selectCsvDataView(profile, input)).toThrowError(
      expect.objectContaining({ code }),
    )
  })

  it('enforces field, row, cell, result-byte and deadline limits', () => {
    expect(() => selectCsvDataView(profile, {
      fieldIds: [nameId, formulaId], rowOffset: 0, rowCount: 2,
    }, { maxFields: 1 })).toThrowError(expect.objectContaining({
      code: 'selection_field_limit_exceeded',
    }))
    expect(() => selectCsvDataView(profile, {
      fieldIds: [nameId], rowOffset: 0, rowCount: 2,
    }, { maxRows: 1 })).toThrowError(expect.objectContaining({
      code: 'selection_row_limit_exceeded',
    }))
    expect(() => selectCsvDataView(profile, {
      fieldIds: [nameId, formulaId], rowOffset: 0,
      rowCount: Math.floor(CSV_DATA_VIEW_SELECTION_MAX_CELLS / 2) + 1,
    })).toThrowError(expect.objectContaining({
      code: 'selection_row_limit_exceeded',
    }))
    expect(() => selectCsvDataView(profile, {
      fieldIds: [nameId, formulaId], rowOffset: 0, rowCount: 2,
    }, { maxCells: 3 })).toThrowError(expect.objectContaining({
      code: 'selection_cell_limit_exceeded',
    }))
    expect(() => selectCsvDataView(profile, {
      fieldIds: [formulaId], rowOffset: 0, rowCount: 1,
    }, { maxResultBytes: 4 })).toThrowError(expect.objectContaining({
      code: 'selection_result_limit_exceeded',
    }))

    let ticks = 0
    expect(() => selectCsvDataView(profile, {
      fieldIds: [nameId], rowOffset: 0, rowCount: 2,
    }, { timeoutMs: 1 }, () => ticks++ * 2)).toThrowError(
      expect.objectContaining({ code: 'selection_timeout' }),
    )
  })

  it('uses one closed error type for every private selection rejection', () => {
    expect(() => selectCsvDataView(profile, {
      fieldIds: [], rowOffset: 0, rowCount: 1,
    })).toThrowError(CsvDataViewSelectionError)
  })
})
