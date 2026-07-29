import { describe, expect, it } from 'vitest'
import { positiveDerSerial } from '../../../src/gateway/tls.js'

describe('positiveDerSerial', () => {
  it.each([
    [[0x7f], '7f'],
    [[0x80], '0080'],
    [[0x00, 0x7f], '7f'],
    [[0x00, 0x80], '0080'],
    [[0x00, 0x00], '01'],
  ])('encodes %j as one minimal positive DER integer', (bytes, expected) => {
    expect(positiveDerSerial(Uint8Array.from(bytes))).toBe(expected)
  })

  it('rejects missing entropy', () => {
    expect(() => positiveDerSerial(new Uint8Array())).toThrow(
      'Certificate serial entropy is empty.',
    )
  })
})
