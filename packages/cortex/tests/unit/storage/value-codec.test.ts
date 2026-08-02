import { describe, expect, it } from 'vitest'
import {
  StorageValueError,
  canonicalizeJsonStorageText,
  encodeCanonicalStorageValue,
  normalizeNullableStorageValue,
  normalizeStorageValue,
  type LogicalValueKind,
} from '../../../src/storage/value-codec.js'

describe('storage value codecs', () => {
  it('normalizes safe integer driver representations without accepting unsafe values', () => {
    for (const value of [
      Number.MIN_SAFE_INTEGER,
      -1,
      0,
      Number.MAX_SAFE_INTEGER,
      BigInt(Number.MAX_SAFE_INTEGER),
      String(Number.MIN_SAFE_INTEGER),
    ]) {
      expect(normalizeStorageValue('safe-integer', value)).toBe(Number(value))
    }
    for (const value of [
      Number.MAX_SAFE_INTEGER + 1,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      '01',
      '7.0',
      'seven',
      true,
    ]) {
      expect(() => normalizeStorageValue('safe-integer', value)).toThrow(
        StorageValueError,
      )
    }
  })

  it('keeps epoch milliseconds tagged separately from ordinary integers', () => {
    expect(normalizeStorageValue('epoch-milliseconds', '1785662400123'))
      .toBe(1_785_662_400_123)
    expect(encodeCanonicalStorageValue('epoch-milliseconds', false, 7))
      .not.toBe(encodeCanonicalStorageValue('safe-integer', false, 7))
  })

  it('accepts only real booleans or the SQLite 0/1 representation', () => {
    expect(normalizeStorageValue('boolean', false)).toBe(false)
    expect(normalizeStorageValue('boolean', true)).toBe(true)
    expect(normalizeStorageValue('boolean', 0)).toBe(false)
    expect(normalizeStorageValue('boolean', 1)).toBe(true)
    for (const value of ['0', 'false', -1, 2, null]) {
      expect(() => normalizeStorageValue('boolean', value)).toThrow(StorageValueError)
    }
  })

  it('accepts finite reals, canonicalizes negative zero, and rejects non-finite values', () => {
    expect(normalizeStorageValue('finite-real', 1.25)).toBe(1.25)
    expect(Object.is(normalizeStorageValue('finite-real', -0), -0)).toBe(false)
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => normalizeStorageValue('finite-real', value)).toThrow(
        expect.objectContaining<Partial<StorageValueError>>({ code: 'real_not_finite' }),
      )
    }
  })

  it('normalizes only the two declared UTC timestamp formats', () => {
    expect(normalizeStorageValue('iso-instant', '2026-08-02T04:05:06Z'))
      .toBe('2026-08-02T04:05:06.000Z')
    expect(normalizeStorageValue('iso-instant', '2026-08-02T04:05:06.1Z'))
      .toBe('2026-08-02T04:05:06.100Z')
    expect(normalizeStorageValue('iso-instant', '2026-08-02 04:05:06'))
      .toBe('2026-08-02T04:05:06.000Z')

    for (const value of [
      '2026-02-30T04:05:06.000Z',
      '2026-08-02T04:05:60.000Z',
      '2026-08-02T14:05:06+10:00',
      '2026-08-02T04:05:06.0000Z',
      '2026-08-02',
      1_785_662_400_123,
    ]) {
      expect(() => normalizeStorageValue('iso-instant', value)).toThrow(
        StorageValueError,
      )
    }
  })

  it('is timezone/DST independent because accepted values identify UTC', () => {
    expect(normalizeStorageValue('iso-instant', '2026-10-04T15:30:00.000Z'))
      .toBe('2026-10-04T15:30:00.000Z')
    expect(normalizeStorageValue('iso-instant', '2026-04-05 15:30:00'))
      .toBe('2026-04-05T15:30:00.000Z')
  })

  it('compares semantic JSON by parsed value while preserving array order', () => {
    const left = ' { "z": 1, "a": { "second": 2, "first": true } } '
    const right = '{"a":{"first":true,"second":2},"z":1}'
    expect(canonicalizeJsonStorageText(left)).toBe(canonicalizeJsonStorageText(right))
    expect(canonicalizeJsonStorageText(left))
      .toBe('{"a":{"first":true,"second":2},"z":1}')
    expect(canonicalizeJsonStorageText('[1,2]'))
      .not.toBe(canonicalizeJsonStorageText('[2,1]'))
  })

  it('rejects JSON that would lose numeric or object-key meaning in JavaScript', () => {
    for (const value of [
      '1e400',
      '9007199254740992',
      '0.10000000000000001',
      '{"same":1,"same":2}',
      '{"a":1,"\\u0061":2}',
    ]) {
      expect(() => canonicalizeJsonStorageText(value)).toThrow(
        expect.objectContaining<Partial<StorageValueError>>({
          code: 'json_value_unsupported',
        }),
      )
    }
    expect(canonicalizeJsonStorageText('1.0')).toBe('1')
    expect(canonicalizeJsonStorageText('1e-1')).toBe('0.1')
    expect(() => canonicalizeJsonStorageText(
      `${'['.repeat(130)}null${']'.repeat(130)}`,
    )).toThrow(expect.objectContaining<Partial<StorageValueError>>({
      code: 'json_value_unsupported',
    }))
  })

  it('rejects malformed JSON and non-text JSON driver leakage', () => {
    for (const value of ['{', '{"x":NaN}', '', { x: 1 }, undefined]) {
      expect(() => normalizeStorageValue('json-value', value)).toThrow(StorageValueError)
    }
  })

  it('keeps JSON bytes exact when a future column declares that semantic', () => {
    expect(encodeCanonicalStorageValue('json-bytes', false, '{ "a": 1 }'))
      .not.toBe(encodeCanonicalStorageValue('json-bytes', false, '{"a":1}'))
    expect(encodeCanonicalStorageValue('json-value', false, '{ "a": 1 }'))
      .toBe(encodeCanonicalStorageValue('json-value', false, '{"a":1}'))
  })

  it('encodes text and binary without delimiter ambiguity', () => {
    expect(encodeCanonicalStorageValue('text', false, 'line 1\nline 2'))
      .toBe('["text","line 1\\nline 2"]')
    expect(encodeCanonicalStorageValue('binary', false, new Uint8Array([0, 1, 255])))
      .toBe('["binary","AAH/"]')
    expect(() => normalizeStorageValue('binary', 'AAH/')).toThrow(StorageValueError)
  })

  it('rejects U+0000 from values mapped to PostgreSQL TEXT', () => {
    for (const kind of ['text', 'json-bytes'] as const) {
      // SQLite retains this text; cross-adapter canonicalization must reject it
      // before an ordinary PostgreSQL TEXT insert can fail mid-transfer.
      expect(normalizeStorageValue(kind, 'before\0after')).toBe('before\0after')
      expect(() => encodeCanonicalStorageValue(kind, false, 'before\0after')).toThrow(
        expect.objectContaining<Partial<StorageValueError>>({ code: 'text_contains_nul' }),
      )
    }
    // An escaped JSON code point is ASCII storage and remains representable.
    expect(canonicalizeJsonStorageText('{"value":"\\u0000"}'))
      .toBe('{"value":"\\u0000"}')
  })

  it('rejects lone UTF-16 surrogates before UTF-8 transport can replace them', () => {
    for (const value of ['\ud800', '\udc00', `ok\ud800x`]) {
      expect(() => normalizeStorageValue('text', value)).toThrow(
        expect.objectContaining<Partial<StorageValueError>>({ code: 'text_invalid_unicode' }),
      )
    }
    expect(normalizeStorageValue('text', 'ok 😀')).toBe('ok 😀')
  })

  it('distinguishes null from every value and enforces logical nullability', () => {
    expect(normalizeNullableStorageValue('text', true, null)).toBeNull()
    expect(encodeCanonicalStorageValue('text', true, null)).toBe('["null"]')
    expect(encodeCanonicalStorageValue('text', false, 'null')).not.toBe('["null"]')
    expect(() => normalizeNullableStorageValue('text', false, null)).toThrow(
      expect.objectContaining<Partial<StorageValueError>>({ code: 'null_not_allowed' }),
    )
  })

  it('has a valid representative for every declared logical kind', () => {
    const examples: Record<LogicalValueKind, unknown> = {
      text: 'value',
      'safe-integer': 7,
      'epoch-milliseconds': 1_785_662_400_123,
      boolean: true,
      'finite-real': 1.5,
      'iso-instant': '2026-08-02T00:00:00.000Z',
      'json-value': '{"ok":true}',
      'json-bytes': '{ "ok": true }',
      binary: new Uint8Array([1]),
    }
    for (const [kind, value] of Object.entries(examples)) {
      expect(() => encodeCanonicalStorageValue(
        kind as LogicalValueKind,
        false,
        value,
      )).not.toThrow()
    }
  })

  it('does not place rejected customer values in error messages', () => {
    const canary = 'customer-secret-canary'
    let error: unknown
    try {
      normalizeStorageValue('safe-integer', canary)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StorageValueError)
    expect(String(error)).not.toContain(canary)
  })
})
