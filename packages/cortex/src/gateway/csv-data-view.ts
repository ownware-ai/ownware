import { createHash } from 'node:crypto'

export const CSV_DATA_VIEW_IMPLEMENTATION = 'csv_data_view.v1' as const
export const CSV_DATA_VIEW_MAX_BYTES = 16 * 1024 * 1024
export const CSV_DATA_VIEW_MAX_FIELDS = 256
export const CSV_DATA_VIEW_MAX_ROWS = 100_000
export const CSV_DATA_VIEW_MAX_CELL_BYTES = 64 * 1024
export const CSV_DATA_VIEW_MAX_CELLS = 1_000_000
export const CSV_DATA_VIEW_TIMEOUT_MS = 5_000

export type CsvDataViewErrorCode =
  | 'csv_identity_invalid'
  | 'csv_input_oversized'
  | 'csv_invalid_utf8'
  | 'csv_header_empty'
  | 'csv_header_duplicate'
  | 'csv_quoting_invalid'
  | 'csv_bare_carriage_return'
  | 'csv_row_ragged'
  | 'csv_field_limit_exceeded'
  | 'csv_row_limit_exceeded'
  | 'csv_cell_limit_exceeded'
  | 'csv_total_cell_limit_exceeded'
  | 'csv_preparation_timeout'

export class CsvDataViewError extends Error {
  constructor(readonly code: CsvDataViewErrorCode) {
    super(code)
    this.name = 'CsvDataViewError'
  }
}

export interface CsvDataViewField {
  readonly fieldId: string
  readonly ordinal: number
  readonly label: string
}

export interface CsvDataViewRow {
  readonly rowId: string
  readonly ordinal: number
  readonly values: readonly string[]
}

export interface CsvDataViewProfile {
  readonly implementationVersion: typeof CSV_DATA_VIEW_IMPLEMENTATION
  readonly sourceVersionId: string
  readonly sourceChecksum: string
  readonly fieldCount: number
  readonly rowCount: number
  readonly fields: readonly CsvDataViewField[]
  readonly rows: readonly CsvDataViewRow[]
}

export interface CsvDataViewLimits {
  readonly maxBytes: number
  readonly maxFields: number
  readonly maxRows: number
  readonly maxCellBytes: number
  readonly maxCells: number
  readonly timeoutMs: number
}

export interface ProfileCsvDataViewInput {
  readonly bytes: Uint8Array
  readonly sourceVersionId: string
  readonly sourceChecksum: string
}

const DEFAULT_LIMITS: CsvDataViewLimits = {
  maxBytes: CSV_DATA_VIEW_MAX_BYTES,
  maxFields: CSV_DATA_VIEW_MAX_FIELDS,
  maxRows: CSV_DATA_VIEW_MAX_ROWS,
  maxCellBytes: CSV_DATA_VIEW_MAX_CELL_BYTES,
  maxCells: CSV_DATA_VIEW_MAX_CELLS,
  timeoutMs: CSV_DATA_VIEW_TIMEOUT_MS,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHECKSUM = /^sha256:[0-9a-f]{64}$/

/**
 * Mechanically profiles one exact immutable CSV source version.
 *
 * The returned cells are runtime-private preparation state. Callers must not
 * persist them in the control database or expose them without the Data View
 * query/grant boundary. No type inference or formula interpretation occurs.
 */
export function profileCsvDataView(
  input: ProfileCsvDataViewInput,
  limits: CsvDataViewLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): CsvDataViewProfile {
  validateIdentity(input)
  validateLimits(limits)
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new CsvDataViewError('csv_input_oversized')
  }

  const startedAt = now()
  let csv: string
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)
  } catch {
    throw new CsvDataViewError('csv_invalid_utf8')
  }

  const fields: CsvDataViewField[] = []
  const rows: CsvDataViewRow[] = []
  let headerKeys: Set<string> | null = null
  let dataCells = 0
  let record: string[] = []
  let cell: string[] = []
  let cellCodeUnits = 0
  let state: 'start' | 'unquoted' | 'quoted' | 'after_quote' = 'start'
  let endedWithRecordBreak = false

  const checkTime = (): void => {
    if (now() - startedAt > limits.timeoutMs) {
      throw new CsvDataViewError('csv_preparation_timeout')
    }
  }
  const append = (value: string): void => {
    cellCodeUnits += value.length
    if (cellCodeUnits > limits.maxCellBytes) {
      throw new CsvDataViewError('csv_cell_limit_exceeded')
    }
    cell.push(value)
  }
  const finishCell = (): void => {
    const value = cell.join('')
    if (Buffer.byteLength(value, 'utf8') > limits.maxCellBytes) {
      throw new CsvDataViewError('csv_cell_limit_exceeded')
    }
    record.push(value)
    cell = []
    cellCodeUnits = 0
    state = 'start'
    if (headerKeys === null && record.length > limits.maxFields) {
      throw new CsvDataViewError('csv_field_limit_exceeded')
    }
  }
  const finishRecord = (): void => {
    finishCell()
    if (headerKeys === null) {
      headerKeys = new Set<string>()
      for (let ordinal = 0; ordinal < record.length; ordinal += 1) {
        const label = record[ordinal]!
        const key = normalizeHeader(label)
        if (key.length === 0) throw new CsvDataViewError('csv_header_empty')
        if (headerKeys.has(key)) throw new CsvDataViewError('csv_header_duplicate')
        headerKeys.add(key)
        fields.push(Object.freeze({
          fieldId: deriveOrdinalId('field', input.sourceVersionId, ordinal),
          ordinal,
          label,
        }))
      }
    } else {
      if (record.length !== fields.length) {
        throw new CsvDataViewError('csv_row_ragged')
      }
      if (rows.length >= limits.maxRows) {
        throw new CsvDataViewError('csv_row_limit_exceeded')
      }
      dataCells += record.length
      if (dataCells > limits.maxCells) {
        throw new CsvDataViewError('csv_total_cell_limit_exceeded')
      }
      const ordinal = rows.length
      rows.push(Object.freeze({
        rowId: deriveOrdinalId('row', input.sourceVersionId, ordinal),
        ordinal,
        values: Object.freeze(record),
      }))
    }
    record = []
    endedWithRecordBreak = true
    checkTime()
  }

  for (let index = 0; index < csv.length; index += 1) {
    if ((index & 1023) === 0) checkTime()
    const character = csv[index]!
    endedWithRecordBreak = false
    if (state === 'quoted') {
      if (character === '"') state = 'after_quote'
      else append(character)
      continue
    }
    if (state === 'after_quote') {
      if (character === '"') {
        append('"')
        state = 'quoted'
        continue
      }
      if (character === ',') {
        finishCell()
        continue
      }
      if (character === '\n') {
        finishRecord()
        continue
      }
      if (character === '\r') {
        if (csv[index + 1] !== '\n') {
          throw new CsvDataViewError('csv_bare_carriage_return')
        }
        index += 1
        finishRecord()
        continue
      }
      throw new CsvDataViewError('csv_quoting_invalid')
    }
    if (character === '"') {
      if (state !== 'start') throw new CsvDataViewError('csv_quoting_invalid')
      state = 'quoted'
      continue
    }
    if (character === ',') {
      finishCell()
      continue
    }
    if (character === '\n') {
      finishRecord()
      continue
    }
    if (character === '\r') {
      if (csv[index + 1] !== '\n') {
        throw new CsvDataViewError('csv_bare_carriage_return')
      }
      index += 1
      finishRecord()
      continue
    }
    append(character)
    state = 'unquoted'
  }

  if (state === 'quoted') throw new CsvDataViewError('csv_quoting_invalid')
  if (!endedWithRecordBreak) finishRecord()
  if (headerKeys === null) throw new CsvDataViewError('csv_header_empty')
  checkTime()

  return Object.freeze({
    implementationVersion: CSV_DATA_VIEW_IMPLEMENTATION,
    sourceVersionId: input.sourceVersionId,
    sourceChecksum: input.sourceChecksum,
    fieldCount: fields.length,
    rowCount: rows.length,
    fields: Object.freeze(fields),
    rows: Object.freeze(rows),
  })
}

function normalizeHeader(label: string): string {
  return label.trim().normalize('NFKC').toLowerCase()
}

function deriveOrdinalId(
  kind: 'field' | 'row',
  sourceVersionId: string,
  ordinal: number,
): string {
  const digest = createHash('sha256')
    .update(`${CSV_DATA_VIEW_IMPLEMENTATION}\0${kind}\0${sourceVersionId}\0${ordinal}`)
    .digest('hex')
    .slice(0, 32)
  return `${kind}.${digest}`
}

function validateIdentity(input: ProfileCsvDataViewInput): void {
  if (!UUID.test(input.sourceVersionId) || !CHECKSUM.test(input.sourceChecksum)) {
    throw new CsvDataViewError('csv_identity_invalid')
  }
}

function validateLimits(limits: CsvDataViewLimits): void {
  const values: ReadonlyArray<readonly [number, number]> = [
    [limits.maxBytes, DEFAULT_LIMITS.maxBytes],
    [limits.maxFields, DEFAULT_LIMITS.maxFields],
    [limits.maxRows, DEFAULT_LIMITS.maxRows],
    [limits.maxCellBytes, DEFAULT_LIMITS.maxCellBytes],
    [limits.maxCells, DEFAULT_LIMITS.maxCells],
    [limits.timeoutMs, DEFAULT_LIMITS.timeoutMs],
  ]
  if (values.some(([value, ceiling]) =>
    !Number.isSafeInteger(value) || value < 1 || value > ceiling)) {
    throw new CsvDataViewError('csv_identity_invalid')
  }
}
