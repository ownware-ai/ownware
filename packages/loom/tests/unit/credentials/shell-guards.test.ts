/**
 * Unit tests — shell credential guards (pre-execution + redaction).
 *
 * These exercise the pure functions in `shell-credential-guards.ts`
 * without spawning a real child process. The integration test for
 * shell_execute (env injection + block behavior end-to-end) lives
 * alongside the existing shell tests.
 */

import { describe, it, expect } from 'vitest'
import type { CredentialValue, EnvCredentialEntry } from '../../../src/credentials/types.js'
import {
  buildSubprocessEnv,
  commandContainsInlineCredentialValue,
  commandTargetsEnvFile,
  redactShellOutput,
} from '../../../src/tools/builtins/shell-credential-guards.js'

describe('commandTargetsEnvFile', () => {
  it('detects cat/less/more/head/tail/bat/xxd/od on .env', () => {
    const hits = [
      'cat .env',
      'less .env',
      'more .env',
      'head .env',
      'tail .env',
      'bat .env',
      'xxd .env',
      'od -c .env',
      'cat ./.env',
      'cat ./config/.env',
      'cat .env.local',
      'cat .env.production',
      'head -n 5 .env',
      'tail -f .env.development',
    ]
    for (const cmd of hits) {
      expect(commandTargetsEnvFile(cmd)).toBe(true)
    }
  })

  it('detects grep on .env', () => {
    expect(commandTargetsEnvFile('grep SECRET .env')).toBe(true)
    expect(commandTargetsEnvFile('grep -i api_key .env.local')).toBe(true)
  })

  it('detects source/. .env forms', () => {
    expect(commandTargetsEnvFile('source .env')).toBe(true)
    expect(commandTargetsEnvFile('source ./.env')).toBe(true)
    expect(commandTargetsEnvFile('. .env')).toBe(true)
    expect(commandTargetsEnvFile('bash -c "source .env && node app.js"')).toBe(true)
  })

  it('detects export $(cat .env) and $(< .env) forms', () => {
    expect(commandTargetsEnvFile('export $(cat .env)')).toBe(true)
    expect(commandTargetsEnvFile('export $(< .env)')).toBe(true)
    expect(commandTargetsEnvFile('export $(cat ./config/.env)')).toBe(true)
  })

  it('detects sed/awk/cut/tr/perl on .env', () => {
    expect(commandTargetsEnvFile('sed -n 1,5p .env')).toBe(true)
    expect(commandTargetsEnvFile('awk "{print}" .env')).toBe(true)
    expect(commandTargetsEnvFile("cut -d= -f2 .env")).toBe(true)
    // Input-redirect with tr IS caught — the `<` redirect shape has its
    // own pattern in addition to the verb list.
    expect(commandTargetsEnvFile('tr "\\n" " " < .env')).toBe(true)
  })

  it('does not flag benign commands', () => {
    const benign = [
      'cat package.json',
      'ls src',
      'echo hello',
      'npm test',
      'cat src/env.ts',
      'cat env.example.md',
      'grep SECRET src/config.ts',
      'node scripts/envoy.js',
      'echo "DATABASE_URL is set"',
    ]
    for (const cmd of benign) {
      expect(commandTargetsEnvFile(cmd)).toBe(false)
    }
  })
})

describe('commandContainsInlineCredentialValue', () => {
  const values: readonly CredentialValue[] = [
    { credentialId: 'c1', value: 'supersecret12345', label: 'API Token' },
    { credentialId: 'c2', value: 'postgres://user:pw@host/db', label: 'DB URL' },
    { credentialId: 'c3', value: 'ab', label: 'TooShort' }, // under min length
  ]

  it('returns the matching credential when present inline', () => {
    const hit = commandContainsInlineCredentialValue(
      'curl -H "Authorization: Bearer supersecret12345" example.com',
      values,
    )
    expect(hit?.credentialId).toBe('c1')
  })

  it('returns the LONGER credential when two match (deterministic)', () => {
    // Contrived: a shorter value is a prefix of a longer one.
    const v: readonly CredentialValue[] = [
      { credentialId: 'short', value: 'abcd1234', label: 'short' },
      { credentialId: 'long', value: 'abcd1234efgh5678', label: 'long' },
    ]
    expect(
      commandContainsInlineCredentialValue('echo abcd1234efgh5678', v)?.credentialId,
    ).toBe('long')
  })

  it('does not flag values shorter than the minimum length', () => {
    // "ab" alone appears in many normal commands (tokens, flags).
    // Blocking on 2-char matches would be a DoS on the agent.
    expect(commandContainsInlineCredentialValue('echo ab', values)).toBeNull()
    expect(commandContainsInlineCredentialValue('cat absolute', values)).toBeNull()
  })

  it('returns null when no credentials inline', () => {
    expect(commandContainsInlineCredentialValue('echo hi', values)).toBeNull()
  })

  it('returns null on an empty credential list', () => {
    expect(commandContainsInlineCredentialValue('echo hi', [])).toBeNull()
  })
})

describe('buildSubprocessEnv', () => {
  it('merges every env credential value into the parent env', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/u' }
    const list: readonly EnvCredentialEntry[] = [
      { credentialId: 'c1', variableName: 'DATABASE_URL' },
      { credentialId: 'c2', variableName: 'USER_JWT' },
    ]
    const resolve = (id: string) => id === 'c1' ? 'postgres://x' : id === 'c2' ? 'jwt-token' : null
    const env = buildSubprocessEnv(parent, () => list, resolve)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/u')
    expect(env.DATABASE_URL).toBe('postgres://x')
    expect(env.USER_JWT).toBe('jwt-token')
  })

  it('overrides parent env when a credential variable collides', () => {
    const parent: NodeJS.ProcessEnv = { DATABASE_URL: 'old-value' }
    const env = buildSubprocessEnv(
      parent,
      () => [{ credentialId: 'c1', variableName: 'DATABASE_URL' }],
      () => 'new-vault-value',
    )
    expect(env.DATABASE_URL).toBe('new-vault-value')
  })

  it('skips credentials that resolve to null', () => {
    const parent: NodeJS.ProcessEnv = {}
    const env = buildSubprocessEnv(
      parent,
      () => [{ credentialId: 'c1', variableName: 'MISSING' }],
      () => null,
    )
    expect('MISSING' in env).toBe(false)
  })

  it('returns a fresh object — does not mutate the parent env', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/x' }
    const env = buildSubprocessEnv(
      parent,
      () => [{ credentialId: 'c1', variableName: 'NEW' }],
      () => 'v',
    )
    expect(parent).toEqual({ PATH: '/x' })
    expect(env).not.toBe(parent)
  })

  it('returns parent env verbatim (copy) when no env credentials', () => {
    const parent: NodeJS.ProcessEnv = { PATH: '/x', HOME: '/h' }
    const env = buildSubprocessEnv(parent, () => [], () => null)
    expect(env).toEqual(parent)
    expect(env).not.toBe(parent)
  })
})

describe('redactShellOutput — credential values', () => {
  it('replaces plaintext values with ***REDACTED::<label>***', () => {
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: 'supersecret12345', label: 'API Token' },
    ]
    const result = redactShellOutput('auth: Bearer supersecret12345', values)
    expect(result.redacted).toBe('auth: Bearer ***REDACTED::API Token***')
    expect(result.redactedCount).toBe(1)
    expect(result.redactedLabels).toEqual(['API Token'])
  })

  it('redacts base64-encoded values', () => {
    const raw = 'plaintextvalue123'
    const b64 = Buffer.from(raw).toString('base64')
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: raw, label: 'Thing' },
    ]
    const out = `encoded: ${b64}`
    const result = redactShellOutput(out, values)
    expect(result.redacted).toContain('***REDACTED::Thing***')
    expect(result.redacted).not.toContain(b64)
  })

  it('redacts URL-encoded values', () => {
    const raw = 'postgres://user:p@ss@host/db'
    const enc = encodeURIComponent(raw)
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: raw, label: 'DB URL' },
    ]
    const result = redactShellOutput(`redirect?dsn=${enc}`, values)
    expect(result.redacted).toContain('***REDACTED::DB URL***')
    expect(result.redacted).not.toContain(enc)
  })

  it('handles multiple values in a single output (longest-first)', () => {
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: 'abcd', label: 'Short' },
      { credentialId: 'c2', value: 'abcdefghij', label: 'Long' },
    ]
    // Input contains the long value; longest-first must win so we end up
    // with a single "Long" redaction, not a partial "Short" replacement
    // leaving behind "efghij".
    const result = redactShellOutput('token=abcdefghij', values)
    expect(result.redacted).toBe('token=***REDACTED::Long***')
    expect(result.redactedCount).toBe(1)
  })

  it('emits no redactions when output carries no known values', () => {
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: 'supersecret', label: 'X' },
    ]
    const result = redactShellOutput('hello world', values)
    expect(result.redacted).toBe('hello world')
    expect(result.redactedCount).toBe(0)
  })

  it('emits no redactions for an empty credential list', () => {
    const result = redactShellOutput('env output', [])
    expect(result.redacted).toBe('env output')
    expect(result.redactedCount).toBe(0)
  })
})

describe('redactShellOutput — sensitive KEY=VALUE env lines', () => {
  it('collapses every sensitive-keyed env line', () => {
    const input = [
      'PATH=/usr/bin',
      'HOME=/home/u',
      'STRIPE_SECRET_KEY=sk_live_abcdef',
      'DATABASE_URL=postgres://x',
      'NODE_ENV=production',
    ].join('\n')
    const result = redactShellOutput(input, [])
    expect(result.redacted).toContain('PATH=/usr/bin')
    expect(result.redacted).toContain('HOME=/home/u')
    expect(result.redacted).toContain('NODE_ENV=production')
    expect(result.redacted).toContain('STRIPE_SECRET_KEY=***REDACTED::SENSITIVE_ENV***')
    expect(result.redacted).toContain('DATABASE_URL=***REDACTED::SENSITIVE_ENV***')
    expect(result.envLineRedactionCount).toBe(2)
  })

  it('does not double-redact lines where the value was a known credential', () => {
    const values: readonly CredentialValue[] = [
      { credentialId: 'c1', value: 'postgres://x', label: 'DB' },
    ]
    const input = 'DATABASE_URL=postgres://x\nNODE_ENV=prod'
    const result = redactShellOutput(input, values)
    expect(result.redacted).toContain('DATABASE_URL=***REDACTED::DB***')
    expect(result.redacted).toContain('NODE_ENV=prod')
    // Only the value-match pass counts here — the env-line pass skips
    // lines already containing a REDACTED marker.
    expect(result.redactedCount).toBe(1)
    expect(result.envLineRedactionCount).toBe(0)
  })

  it('leaves an empty value untouched', () => {
    const result = redactShellOutput('FOO_TOKEN=\nPORT=3000', [])
    expect(result.redacted).toContain('FOO_TOKEN=\n')
    expect(result.envLineRedactionCount).toBe(0)
  })

  it('anchors to line boundaries (does not redact inside JSON)', () => {
    const input = 'response: {"PATH":"/x","SECRET_KEY":"abc"}'
    const result = redactShellOutput(input, [])
    // The `SECRET_KEY":"abc"` text is not a line-anchored KEY=VALUE,
    // so the env-line pass leaves it alone.
    expect(result.redacted).toBe(input)
  })
})
