/**
 * Driver-neutral durable value codecs.
 *
 * These codecs define the values that may cross the storage boundary. They do
 * not coerce malformed customer data into something convenient for a stricter
 * backend. SQLite transfer preflight must additionally inspect SQLite's
 * `typeof(column)` so a TEXT storage class in an INTEGER column cannot pass as
 * a PostgreSQL driver's decimal string representation.
 */

export type LogicalValueKind =
  | 'text'
  | 'safe-integer'
  | 'epoch-milliseconds'
  | 'boolean'
  | 'finite-real'
  | 'iso-instant'
  | 'json-value'
  | 'json-bytes'
  | 'binary'

export type LogicalValueProjection = 'identity' | 'postgresql-text-key-v1'

export type NormalizedStorageValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | readonly NormalizedStorageValue[]
  | { readonly [key: string]: NormalizedStorageValue }

export type StorageValueErrorCode =
  | 'null_not_allowed'
  | 'type_mismatch'
  | 'integer_out_of_range'
  | 'real_not_finite'
  | 'instant_invalid'
  | 'json_invalid'
  | 'json_value_unsupported'
  | 'text_contains_nul'
  | 'text_invalid_unicode'
  | 'binary_invalid'

export const JSON_STORAGE_MAX_BYTES = 16 * 1024 * 1024
export const JSON_STORAGE_MAX_DEPTH = 128
export const JSON_STORAGE_MAX_VALUES = 1_000_000

export class StorageValueError extends Error {
  override readonly name = 'StorageValueError'

  constructor(
    readonly code: StorageValueErrorCode,
    readonly kind: LogicalValueKind,
  ) {
    super(`Stored ${kind} value is not representable (${code}).`)
  }
}

function fail(code: StorageValueErrorCode, kind: LogicalValueKind): never {
  throw new StorageValueError(code, kind)
}

function normalizeSafeInteger(
  value: unknown,
  kind: 'safe-integer' | 'epoch-milliseconds',
): number {
  let integer: bigint
  if (typeof value === 'bigint') {
    integer = value
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return fail('integer_out_of_range', kind)
    return value
  } else if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    // node-postgres returns BIGINT as a decimal string by default. SQLite
    // preflight separately rejects a TEXT storage class for INTEGER columns.
    integer = BigInt(value)
  } else {
    return fail('type_mismatch', kind)
  }

  if (
    integer < BigInt(Number.MIN_SAFE_INTEGER) ||
    integer > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return fail('integer_out_of_range', kind)
  }
  return Number(integer)
}

function normalizeInstant(value: unknown): string {
  if (typeof value !== 'string') return fail('type_mismatch', 'iso-instant')

  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  const sqliteUtc = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  const match = iso ?? sqliteUtc
  if (match === null) return fail('instant_invalid', 'iso-instant')

  // Leap seconds and timezone-bearing/local strings are deliberately outside
  // the envelope. JavaScript and PostgreSQL normalize them differently.
  const second = Number(match[6])
  if (second > 59) return fail('instant_invalid', 'iso-instant')
  const milliseconds = iso === null ? '000' : (match[7] ?? '').padEnd(3, '0')
  const normalized =
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` +
    `.${milliseconds}Z`
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) {
    return fail('instant_invalid', 'iso-instant')
  }
  return normalized
}

function assertUnicodeScalarText(value: string, kind: LogicalValueKind): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        return fail('text_invalid_unicode', kind)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return fail('text_invalid_unicode', kind)
    }
  }
  return value
}

function assertPostgreSqlText(value: string, kind: LogicalValueKind): string {
  assertUnicodeScalarText(value, kind)
  // PostgreSQL text/varchar cannot store U+0000. Accepting it here would make
  // a SQLite value look transferable until the target insert failed.
  if (value.includes('\0')) return fail('text_contains_nul', kind)
  return value
}

/** Logical value transformed by the two explicitly certified PG text-key columns. */
export function normalizePostgreSqlTextKeyLogicalValue(value: unknown): string {
  if (typeof value !== 'string') return fail('type_mismatch', 'text')
  return assertUnicodeScalarText(value, 'text')
}

function canonicalDecimal(token: string): string {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token)
  if (match === null) return fail('json_invalid', 'json-value')
  const negative = match[1] === '-'
  const fraction = match[3] ?? ''
  const explicitExponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(explicitExponent) || Math.abs(explicitExponent) > 10_000) {
    return fail('json_value_unsupported', 'json-value')
  }
  let digits = `${match[2]}${fraction}`.replace(/^0+/, '')
  if (digits.length === 0) return '0'
  let exponent = explicitExponent - fraction.length
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    exponent += 1
  }
  let result: string
  if (exponent >= 0) {
    result = `${digits}${'0'.repeat(exponent)}`
  } else {
    const decimalAt = digits.length + exponent
    result = decimalAt > 0
      ? `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`
      : `0.${'0'.repeat(-decimalAt)}${digits}`
  }
  return negative ? `-${result}` : result
}

function canonicalJsonNumber(token: string): string {
  const number = Number(token)
  if (!Number.isFinite(number)) return fail('json_value_unsupported', 'json-value')
  const exact = canonicalDecimal(token)
  const roundTrip = canonicalDecimal(String(number))
  if (exact !== roundTrip) return fail('json_value_unsupported', 'json-value')
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
    return fail('json_value_unsupported', 'json-value')
  }
  return exact
}

class StrictJsonParser {
  private index = 0
  private values = 0

  constructor(private readonly source: string) {
    if (Buffer.byteLength(source, 'utf8') > JSON_STORAGE_MAX_BYTES) {
      fail('json_value_unsupported', 'json-value')
    }
  }

  parse(): string {
    this.whitespace()
    const value = this.value(0)
    this.whitespace()
    if (this.index !== this.source.length) return fail('json_invalid', 'json-value')
    return value
  }

  private whitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1
  }

  private value(depth: number): string {
    this.values += 1
    if (depth > JSON_STORAGE_MAX_DEPTH || this.values > JSON_STORAGE_MAX_VALUES) {
      return fail('json_value_unsupported', 'json-value')
    }
    const character = this.source[this.index]
    if (character === '"') return this.string().canonical
    if (character === '[') return this.array(depth)
    if (character === '{') return this.object(depth)
    if (this.source.startsWith('true', this.index)) {
      this.index += 4
      return 'true'
    }
    if (this.source.startsWith('false', this.index)) {
      this.index += 5
      return 'false'
    }
    if (this.source.startsWith('null', this.index)) {
      this.index += 4
      return 'null'
    }
    return this.number()
  }

  private string(): { readonly decoded: string; readonly canonical: string } {
    const start = this.index
    this.index += 1
    let escaped = false
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index)
      if (!escaped && code === 0x22) {
        this.index += 1
        const token = this.source.slice(start, this.index)
        try {
          const decoded = JSON.parse(token) as unknown
          if (typeof decoded !== 'string') return fail('json_invalid', 'json-value')
          return { decoded, canonical: JSON.stringify(decoded) }
        } catch {
          return fail('json_invalid', 'json-value')
        }
      }
      if (!escaped && code < 0x20) return fail('json_invalid', 'json-value')
      if (!escaped && code === 0x5c) escaped = true
      else escaped = false
      this.index += 1
    }
    return fail('json_invalid', 'json-value')
  }

  private number(): string {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y
    match.lastIndex = this.index
    const found = match.exec(this.source)
    if (found === null) return fail('json_invalid', 'json-value')
    this.index = match.lastIndex
    return canonicalJsonNumber(found[0])
  }

  private array(depth: number): string {
    this.index += 1
    this.whitespace()
    const entries: string[] = []
    if (this.source[this.index] === ']') {
      this.index += 1
      return '[]'
    }
    while (true) {
      entries.push(this.value(depth + 1))
      this.whitespace()
      const separator = this.source[this.index]
      this.index += 1
      if (separator === ']') return `[${entries.join(',')}]`
      if (separator !== ',') return fail('json_invalid', 'json-value')
      this.whitespace()
    }
  }

  private object(depth: number): string {
    this.index += 1
    this.whitespace()
    const entries: Array<readonly [string, string]> = []
    const keys = new Set<string>()
    if (this.source[this.index] === '}') {
      this.index += 1
      return '{}'
    }
    while (true) {
      if (this.source[this.index] !== '"') return fail('json_invalid', 'json-value')
      const key = this.string()
      if (keys.has(key.decoded)) return fail('json_value_unsupported', 'json-value')
      keys.add(key.decoded)
      this.whitespace()
      if (this.source[this.index] !== ':') return fail('json_invalid', 'json-value')
      this.index += 1
      this.whitespace()
      entries.push([key.canonical, this.value(depth + 1)])
      this.whitespace()
      const separator = this.source[this.index]
      this.index += 1
      if (separator === '}') {
        entries.sort((left, right) => (
          left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
        ))
        return `{${entries.map(([name, value]) => `${name}:${value}`).join(',')}}`
      }
      if (separator !== ',') return fail('json_invalid', 'json-value')
      this.whitespace()
    }
  }
}

/** Canonical parsed-value JSON used only for comparison/digests. */
export function canonicalizeJsonStorageText(value: unknown): string {
  if (typeof value !== 'string') return fail('type_mismatch', 'json-value')
  return new StrictJsonParser(value).parse()
}

export function normalizeStorageValue(
  kind: LogicalValueKind,
  value: unknown,
): NormalizedStorageValue {
  switch (kind) {
    case 'text':
    case 'json-bytes':
      if (typeof value !== 'string') return fail('type_mismatch', kind)
      return assertUnicodeScalarText(value, kind)
    case 'safe-integer':
    case 'epoch-milliseconds':
      return normalizeSafeInteger(value, kind)
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 0) return false
      if (value === 1) return true
      return fail('type_mismatch', kind)
    case 'finite-real':
      if (typeof value !== 'number') return fail('type_mismatch', kind)
      if (!Number.isFinite(value)) return fail('real_not_finite', kind)
      return Object.is(value, -0) ? 0 : value
    case 'iso-instant':
      return normalizeInstant(value)
    case 'json-value':
      if (typeof value !== 'string') return fail('type_mismatch', kind)
      canonicalizeJsonStorageText(value)
      return JSON.parse(value) as NormalizedStorageValue
    case 'binary':
      if (!(value instanceof Uint8Array)) return fail('binary_invalid', kind)
      return new Uint8Array(value)
  }
}

export function normalizeNullableStorageValue(
  kind: LogicalValueKind,
  nullable: boolean,
  value: unknown,
): NormalizedStorageValue {
  if (value === null) {
    if (!nullable) return fail('null_not_allowed', kind)
    return null
  }
  return normalizeStorageValue(kind, value)
}

export function normalizeProjectedStorageValue(
  kind: LogicalValueKind,
  nullable: boolean,
  projection: LogicalValueProjection,
  value: unknown,
): NormalizedStorageValue {
  if (value === null) return normalizeNullableStorageValue(kind, nullable, value)
  if (projection === 'postgresql-text-key-v1') {
    if (kind !== 'text') return fail('type_mismatch', kind)
    return normalizePostgreSqlTextKeyLogicalValue(value)
  }
  const normalized = normalizeStorageValue(kind, value)
  if (kind === 'text' || kind === 'json-bytes') {
    return assertPostgreSqlText(normalized as string, kind)
  }
  return normalized
}

/**
 * Unambiguous one-value encoding for cross-adapter row streams. JSON values
 * compare by parsed meaning; json-bytes/text compare exactly.
 */
export function encodeCanonicalStorageValue(
  kind: LogicalValueKind,
  nullable: boolean,
  value: unknown,
  projection: LogicalValueProjection = 'identity',
): string {
  if (value === null) {
    normalizeNullableStorageValue(kind, nullable, value)
    return '["null"]'
  }
  if (kind === 'json-value') {
    return JSON.stringify(['json-value', canonicalizeJsonStorageText(value)])
  }
  const normalized = normalizeProjectedStorageValue(kind, nullable, projection, value)
  if (kind === 'binary') {
    return JSON.stringify([
      'binary',
      Buffer.from(normalized as Uint8Array).toString('base64'),
    ])
  }
  return JSON.stringify([
    projection === 'identity' ? kind : projection,
    normalized,
  ])
}
