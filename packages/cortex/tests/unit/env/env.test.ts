/**
 * Unit tests for environment variable resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  resolveEnvVars,
  resolveEnvString,
  resolveEnvVarsWithFallback,
  resolveEnvStringWithFallback,
} from '../../../src/profile/env.js'

// Save and restore env to avoid test pollution
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string) {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}

function unsetEnv(key: string) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

// ---------------------------------------------------------------------------
// resolveEnvVars
// ---------------------------------------------------------------------------

describe('resolveEnvVars', () => {
  it('resolves a single env var', () => {
    setEnv('TEST_KEY', 'value123')
    const result = resolveEnvVars({ key: '${TEST_KEY}' })
    expect(result['key']).toBe('value123')
  })

  it('resolves multiple vars in one string', () => {
    setEnv('HOST', 'localhost')
    setEnv('PORT', '8080')
    const result = resolveEnvVars({ url: 'http://${HOST}:${PORT}' })
    expect(result['url']).toBe('http://localhost:8080')
  })

  it('resolves vars across multiple keys', () => {
    setEnv('USER', 'admin')
    setEnv('PASS', 'secret')
    const result = resolveEnvVars({
      username: '${USER}',
      password: '${PASS}',
    })
    expect(result['username']).toBe('admin')
    expect(result['password']).toBe('secret')
  })

  it('passes through strings without env refs', () => {
    const result = resolveEnvVars({ key: 'plain-value', other: '123' })
    expect(result['key']).toBe('plain-value')
    expect(result['other']).toBe('123')
  })

  it('handles empty record', () => {
    const result = resolveEnvVars({})
    expect(result).toEqual({})
  })

  it('handles empty string value', () => {
    const result = resolveEnvVars({ key: '' })
    expect(result['key']).toBe('')
  })

  it('resolves env var set to empty string', () => {
    setEnv('EMPTY_VAR', '')
    const result = resolveEnvVars({ key: '${EMPTY_VAR}' })
    expect(result['key']).toBe('')
  })

  // Error cases
  it('throws on missing env var', () => {
    unsetEnv('DEFINITELY_MISSING_XYZ')
    expect(() =>
      resolveEnvVars({ key: '${DEFINITELY_MISSING_XYZ}' }),
    ).toThrow('DEFINITELY_MISSING_XYZ')
  })

  it('throws with context info', () => {
    unsetEnv('MISSING_VAR')
    expect(() =>
      resolveEnvVars({ key: '${MISSING_VAR}' }, "MCP server 'chrome'"),
    ).toThrow("MCP server 'chrome'")
  })

  it('throws on first missing var even if others are set', () => {
    setEnv('SET_VAR', 'ok')
    unsetEnv('MISSING_VAR')
    expect(() =>
      resolveEnvVars({
        good: '${SET_VAR}',
        bad: '${MISSING_VAR}',
      }),
    ).toThrow('MISSING_VAR')
  })

  it('error message suggests .env file', () => {
    unsetEnv('MY_KEY')
    try {
      resolveEnvVars({ k: '${MY_KEY}' })
    } catch (e) {
      expect((e as Error).message).toContain('.env')
    }
  })
})

// ---------------------------------------------------------------------------
// resolveEnvString
// ---------------------------------------------------------------------------

describe('resolveEnvString', () => {
  it('resolves a single var in string', () => {
    setEnv('TOKEN', 'abc123')
    expect(resolveEnvString('Bearer ${TOKEN}')).toBe('Bearer abc123')
  })

  it('returns plain string unchanged', () => {
    expect(resolveEnvString('no refs here')).toBe('no refs here')
  })

  it('throws for missing var', () => {
    unsetEnv('NOPE')
    expect(() => resolveEnvString('${NOPE}')).toThrow('NOPE')
  })

  it('includes context in error', () => {
    unsetEnv('NOPE')
    expect(() =>
      resolveEnvString('${NOPE}', 'server.env.API_KEY'),
    ).toThrow('server.env.API_KEY')
  })
})

// ---------------------------------------------------------------------------
// resolveEnvVarsWithFallback — credential-store integration path
// ---------------------------------------------------------------------------
//
// These tests lock in the audit Hazard 1 fix: ${VAR} references in MCP
// configs are resolved against a per-call `fallback` map (the credential
// store) FIRST, then process.env. Without this, credentials saved via the
// client's Tools page would never reach the running MCP child process.

describe('resolveEnvVarsWithFallback', () => {
  it('uses fallback when var is not in process.env', () => {
    unsetEnv('CRED_ONLY_KEY')
    const result = resolveEnvVarsWithFallback(
      { token: '${CRED_ONLY_KEY}' },
      { CRED_ONLY_KEY: 'from-credential-store' },
    )
    expect(result['token']).toBe('from-credential-store')
  })

  it('fallback wins over process.env', () => {
    setEnv('OVERLAP_KEY', 'from-process-env')
    const result = resolveEnvVarsWithFallback(
      { token: '${OVERLAP_KEY}' },
      { OVERLAP_KEY: 'from-credential-store' },
    )
    expect(result['token']).toBe('from-credential-store')
  })

  it('falls back to process.env when fallback lacks the key', () => {
    setEnv('PROCESS_ONLY_KEY', 'shell-export')
    const result = resolveEnvVarsWithFallback(
      { token: '${PROCESS_ONLY_KEY}' },
      { OTHER_KEY: 'unrelated' },
    )
    expect(result['token']).toBe('shell-export')
  })

  it('throws if neither fallback nor process.env has the var', () => {
    unsetEnv('TRULY_MISSING_KEY')
    expect(() =>
      resolveEnvVarsWithFallback(
        { token: '${TRULY_MISSING_KEY}' },
        { UNRELATED: 'x' },
      ),
    ).toThrow('TRULY_MISSING_KEY')
  })

  it('error message points users at the Tools page first', () => {
    unsetEnv('MISSING_FOR_HINT')
    try {
      resolveEnvVarsWithFallback({ k: '${MISSING_FOR_HINT}' }, undefined)
    } catch (e) {
      expect((e as Error).message).toContain('Tools page')
    }
  })

  it('treats empty-string fallback values as absent (defers to process.env)', () => {
    setEnv('FALLBACK_THEN_PROC', 'shell-value')
    const result = resolveEnvVarsWithFallback(
      { token: '${FALLBACK_THEN_PROC}' },
      { FALLBACK_THEN_PROC: '' },
    )
    expect(result['token']).toBe('shell-value')
  })

  it('undefined fallback behaves identical to legacy resolveEnvVars', () => {
    setEnv('LEGACY_KEY', 'legacy-value')
    const a = resolveEnvVars({ k: '${LEGACY_KEY}' })
    const b = resolveEnvVarsWithFallback({ k: '${LEGACY_KEY}' }, undefined)
    expect(a).toEqual(b)
  })
})

describe('resolveEnvStringWithFallback', () => {
  it('respects fallback first', () => {
    unsetEnv('S_KEY')
    expect(
      resolveEnvStringWithFallback('Bearer ${S_KEY}', { S_KEY: 'tok' }),
    ).toBe('Bearer tok')
  })

  it('mixes fallback and process.env in one string', () => {
    setEnv('HOST_VAR', 'localhost')
    unsetEnv('PORT_VAR')
    expect(
      resolveEnvStringWithFallback(
        '${HOST_VAR}:${PORT_VAR}',
        { PORT_VAR: '5432' },
      ),
    ).toBe('localhost:5432')
  })
})
