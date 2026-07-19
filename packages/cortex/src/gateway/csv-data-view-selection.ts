import type {
  CsvDataViewField,
  CsvDataViewProfile,
} from './csv-data-view.js'

export const CSV_DATA_VIEW_SELECTION_IMPLEMENTATION = 'csv_data_view_selection.v1' as const
export const CSV_DATA_VIEW_SELECTION_MAX_FIELDS = 32
export const CSV_DATA_VIEW_SELECTION_MAX_ROWS = 1_000
export const CSV_DATA_VIEW_SELECTION_MAX_CELLS = 32_000
export const CSV_DATA_VIEW_SELECTION_MAX_RESULT_BYTES = 256 * 1024
export const CSV_DATA_VIEW_SELECTION_TIMEOUT_MS = 2_000

export type CsvDataViewSelectionErrorCode =
  | 'selection_fields_invalid'
  | 'selection_field_unknown'
  | 'selection_window_invalid'
  | 'selection_field_limit_exceeded'
  | 'selection_row_limit_exceeded'
  | 'selection_cell_limit_exceeded'
  | 'selection_result_limit_exceeded'
  | 'selection_timeout'

export class CsvDataViewSelectionError extends Error {
  constructor(readonly code: CsvDataViewSelectionErrorCode) {
    super(code)
    this.name = 'CsvDataViewSelectionError'
  }
}

export interface CsvDataViewSelectionInput {
  readonly fieldIds: readonly string[]
  readonly rowOffset: number
  readonly rowCount: number
}

export interface CsvDataViewSelectionRow {
  readonly rowId: string
  readonly ordinal: number
  readonly values: readonly string[]
}

export interface CsvDataViewSelectionResult {
  readonly implementationVersion: typeof CSV_DATA_VIEW_SELECTION_IMPLEMENTATION
  readonly sourceVersionId: string
  readonly rowOffset: number
  readonly requestedRowCount: number
  readonly returnedRowCount: number
  readonly totalRowCount: number
  readonly complete: boolean
  readonly fields: readonly CsvDataViewField[]
  readonly rows: readonly CsvDataViewSelectionRow[]
}

interface CsvDataViewSelectionLimits {
  readonly maxFields: number
  readonly maxRows: number
  readonly maxCells: number
  readonly maxResultBytes: number
  readonly timeoutMs: number
}

const DEFAULT_LIMITS: CsvDataViewSelectionLimits = {
  maxFields: CSV_DATA_VIEW_SELECTION_MAX_FIELDS,
  maxRows: CSV_DATA_VIEW_SELECTION_MAX_ROWS,
  maxCells: CSV_DATA_VIEW_SELECTION_MAX_CELLS,
  maxResultBytes: CSV_DATA_VIEW_SELECTION_MAX_RESULT_BYTES,
  timeoutMs: CSV_DATA_VIEW_SELECTION_TIMEOUT_MS,
}

const FIELD_ID = /^field\.[0-9a-f]{32}$/

/**
 * Projects one explicit row window and stable field list from an already
 * verified runtime-private Data View. Cell strings remain inert data.
 */
export function selectCsvDataView(
  profile: CsvDataViewProfile,
  input: CsvDataViewSelectionInput,
  limitOverrides: Partial<CsvDataViewSelectionLimits> = {},
  now: () => number = Date.now,
): CsvDataViewSelectionResult {
  const limits = validatedLimits(limitOverrides)
  const startedAt = now()
  const checkDeadline = (): void => {
    if (now() - startedAt > limits.timeoutMs) {
      throw new CsvDataViewSelectionError('selection_timeout')
    }
  }

  if (!Array.isArray(input.fieldIds) || input.fieldIds.length < 1 ||
      input.fieldIds.some((fieldId) => typeof fieldId !== 'string' || !FIELD_ID.test(fieldId)) ||
      new Set(input.fieldIds).size !== input.fieldIds.length) {
    throw new CsvDataViewSelectionError('selection_fields_invalid')
  }
  if (input.fieldIds.length > limits.maxFields) {
    throw new CsvDataViewSelectionError('selection_field_limit_exceeded')
  }
  if (!Number.isSafeInteger(input.rowOffset) || input.rowOffset < 0 ||
      input.rowOffset > profile.rowCount || !Number.isSafeInteger(input.rowCount) ||
      input.rowCount < 1) {
    throw new CsvDataViewSelectionError('selection_window_invalid')
  }
  if (input.rowCount > limits.maxRows) {
    throw new CsvDataViewSelectionError('selection_row_limit_exceeded')
  }
  if (input.fieldIds.length * input.rowCount > limits.maxCells) {
    throw new CsvDataViewSelectionError('selection_cell_limit_exceeded')
  }

  const fieldsById = new Map(profile.fields.map((field) => [field.fieldId, field]))
  const fields = input.fieldIds.map((fieldId) => {
    checkDeadline()
    const field = fieldsById.get(fieldId)
    if (!field) throw new CsvDataViewSelectionError('selection_field_unknown')
    return field
  })
  const rowEnd = Math.min(profile.rowCount, input.rowOffset + input.rowCount)
  const rows: CsvDataViewSelectionRow[] = []
  const returnedRowCount = rowEnd - input.rowOffset
  const complete = rowEnd >= profile.rowCount
  let projectedByteCount = utf8Bytes(JSON.stringify({
    implementationVersion: CSV_DATA_VIEW_SELECTION_IMPLEMENTATION,
    sourceVersionId: profile.sourceVersionId,
    rowOffset: input.rowOffset,
    requestedRowCount: input.rowCount,
    returnedRowCount,
    totalRowCount: profile.rowCount,
    complete,
    fields,
    rows: [],
  }))
  assertResultLimit(projectedByteCount, limits)

  for (let ordinal = input.rowOffset; ordinal < rowEnd; ordinal += 1) {
    checkDeadline()
    const sourceRow = profile.rows[ordinal]
    if (!sourceRow) throw new CsvDataViewSelectionError('selection_window_invalid')
    const values = fields.map((field) => {
      checkDeadline()
      const value = sourceRow.values[field.ordinal]
      if (typeof value !== 'string') {
        throw new CsvDataViewSelectionError('selection_field_unknown')
      }
      return value
    })
    const projectedRow = Object.freeze({
      rowId: sourceRow.rowId,
      ordinal: sourceRow.ordinal,
      values: Object.freeze(values),
    })
    projectedByteCount += utf8Bytes(JSON.stringify(projectedRow)) + (rows.length === 0 ? 0 : 1)
    assertResultLimit(projectedByteCount, limits)
    rows.push(projectedRow)
  }
  checkDeadline()

  return Object.freeze({
    implementationVersion: CSV_DATA_VIEW_SELECTION_IMPLEMENTATION,
    sourceVersionId: profile.sourceVersionId,
    rowOffset: input.rowOffset,
    requestedRowCount: input.rowCount,
    returnedRowCount,
    totalRowCount: profile.rowCount,
    complete,
    fields: Object.freeze(fields),
    rows: Object.freeze(rows),
  })
}

function validatedLimits(
  overrides: Partial<CsvDataViewSelectionLimits>,
): CsvDataViewSelectionLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const values: ReadonlyArray<readonly [number, number]> = [
    [limits.maxFields, DEFAULT_LIMITS.maxFields],
    [limits.maxRows, DEFAULT_LIMITS.maxRows],
    [limits.maxCells, DEFAULT_LIMITS.maxCells],
    [limits.maxResultBytes, DEFAULT_LIMITS.maxResultBytes],
    [limits.timeoutMs, DEFAULT_LIMITS.timeoutMs],
  ]
  if (values.some(([value, ceiling]) =>
    !Number.isSafeInteger(value) || value < 1 || value > ceiling)) {
    throw new CsvDataViewSelectionError('selection_window_invalid')
  }
  return limits
}

function assertResultLimit(
  projectedByteCount: number,
  limits: CsvDataViewSelectionLimits,
): void {
  if (projectedByteCount > limits.maxResultBytes) {
    throw new CsvDataViewSelectionError('selection_result_limit_exceeded')
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
