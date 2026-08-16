import { describe, expect, it } from 'vitest'
import {
  isOpaqueSensitiveInputHandle,
  unsafeCreateSensitiveInputHandle,
} from '../../../src/sensitive-input/types.js'

describe('opaque sensitive-input handles', () => {
  it('constructs and recognizes a non-empty opaque token', () => {
    const handle = unsafeCreateSensitiveInputHandle('one-use-token')
    expect(handle.token).toBe('one-use-token')
    expect(isOpaqueSensitiveInputHandle(handle)).toBe(true)
  })

  it.each([null, '', {}, { token: '' }, { token: 7 }])(
    'rejects malformed shape %#',
    (value) => {
      expect(isOpaqueSensitiveInputHandle(value)).toBe(false)
    },
  )

  it('rejects empty construction', () => {
    expect(() => unsafeCreateSensitiveInputHandle('')).toThrow(TypeError)
  })
})

