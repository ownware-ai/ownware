/**
 * Unit tests — Cortex credential patterns wrapper.
 *
 * The heavy classification tests live in Loom; this file locks the
 * Cortex-side adapter rule: .env auto-import collapses the three-way
 * classifier into `sensitive` | `config` with UNKNOWN = sensitive.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyEnvKey,
  classifyImportedDotenvKey,
  isSensitiveEnvKey,
} from '../../../src/credential/patterns.js'

describe('classifyImportedDotenvKey', () => {
  it('returns `sensitive` for known-secret substrings', () => {
    expect(classifyImportedDotenvKey('STRIPE_SECRET_KEY')).toBe('sensitive')
    expect(classifyImportedDotenvKey('DATABASE_URL')).toBe('sensitive')
    expect(classifyImportedDotenvKey('JWT_SECRET')).toBe('sensitive')
    expect(classifyImportedDotenvKey('MONGO_URI')).toBe('sensitive')
  })

  it('returns `config` for known-safe substrings', () => {
    expect(classifyImportedDotenvKey('NODE_ENV')).toBe('config')
    expect(classifyImportedDotenvKey('PORT')).toBe('config')
    expect(classifyImportedDotenvKey('LOG_LEVEL')).toBe('config')
    expect(classifyImportedDotenvKey('APP_NAME')).toBe('config')
  })

  it('secure default: UNKNOWN → sensitive', () => {
    expect(classifyImportedDotenvKey('FOO_BAR_BAZ')).toBe('sensitive')
    expect(classifyImportedDotenvKey('MY_COMPANY_FLAG')).toBe('sensitive')
  })

  it('sensitive wins on overlap', () => {
    // HOST is safe, KEY is sensitive — combined should go to vault.
    expect(classifyImportedDotenvKey('HOST_API_KEY')).toBe('sensitive')
  })
})

describe('Cortex re-exports', () => {
  it('exposes classifyEnvKey + isSensitiveEnvKey from Loom (smoke test)', () => {
    // Cortex callers that want the raw three-way should still get it.
    expect(classifyEnvKey('PORT')).toBe('safe')
    expect(classifyEnvKey('FOO_BAR')).toBe('unknown')
    expect(isSensitiveEnvKey('PORT')).toBe(false)
    expect(isSensitiveEnvKey('FOO_BAR')).toBe(true)
  })
})
