import { describe, it, expect } from 'vitest'
import { ConnectionCheckResultSchema } from '../../../../src/connector/completion/types.js'

describe('ConnectionCheckResultSchema', () => {
  it('validates every variant', () => {
    expect(ConnectionCheckResultSchema.parse({ status: 'pending' })).toMatchObject({ status: 'pending' })
    expect(ConnectionCheckResultSchema.parse({ status: 'ready' })).toMatchObject({ status: 'ready' })
    expect(ConnectionCheckResultSchema.parse({ status: 'failed', errorReason: 'x' })).toMatchObject({ status: 'failed' })
    expect(ConnectionCheckResultSchema.parse({ status: 'not_found' })).toMatchObject({ status: 'not_found' })
  })

  it('rejects failed without errorReason', () => {
    expect(() => ConnectionCheckResultSchema.parse({ status: 'failed' })).toThrow()
  })

  it('rejects unknown status', () => {
    expect(() => ConnectionCheckResultSchema.parse({ status: 'weird' })).toThrow()
  })

  it('rejects arbitrary completion metadata', () => {
    expect(() => ConnectionCheckResultSchema.parse({
      status: 'ready', completedMetadata: { token: 'must-not-persist' },
    })).toThrow()
  })
})
