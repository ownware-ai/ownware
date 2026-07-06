/**
 * Unit tests — credential classification patterns.
 *
 * Covers:
 *   - Env key classifier: known-sensitive substrings redact,
 *     known-safe-only substrings pass, unknown = sensitive (safe default).
 *   - Blocked file path matcher: spec-listed sensitive files caught,
 *     the common false-positive targets (package.json, src/env.ts,
 *     env.example.md) explicitly not caught.
 *   - filterBlockedPaths: drops blocked entries, preserves order.
 *   - BLOCKED_FILE_GLOBS: shape sanity (ripgrep consumes these).
 */

import { describe, it, expect } from 'vitest'
import {
  BLOCKED_FILE_GLOBS,
  classifyEnvKey,
  filterBlockedPaths,
  isBlockedFilePath,
  isSensitiveEnvKey,
} from '../../../src/credentials/patterns.js'

describe('classifyEnvKey', () => {
  it('flags every sensitive substring as sensitive', () => {
    const sensitive = [
      'STRIPE_SECRET_KEY',
      'STRIPE_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'DATABASE_URL',
      'MONGO_URI',
      'REDIS_URL',
      'SMTP_PASSWORD',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'JWT_SECRET',
      'SESSION_TOKEN',
      'USER_PASSWORD',
      'USER_PASS',
      'PRIVATE_CERT',
      'ENCRYPTION_KEY',
      'MASTER_KEY',
      'WEBHOOK_SECRET',
      'RSA_PRIVATE',
      'GPG_KEY',
      'SIGNING_CERT',
      'SALT_VALUE',
      'HASH_SEED',
    ]
    for (const key of sensitive) {
      expect(classifyEnvKey(key)).toBe('sensitive')
    }
  })

  it('flags safe substrings as safe', () => {
    const safe = [
      'PORT',
      'NODE_ENV',
      'HOST',
      'HOSTNAME',
      'DEBUG',
      'LOG_LEVEL',
      'APP_NAME',
      'REGION',
      'TZ',
      'LANG',
      'PATH',
      'HOME',
      'DISPLAY',
      'TERM',
      'EDITOR',
    ]
    for (const key of safe) {
      expect(classifyEnvKey(key)).toBe('safe')
    }
  })

  it('gives sensitive precedence on overlap (safe-default)', () => {
    // HOST is safe, KEY is sensitive — combined means sensitive.
    expect(classifyEnvKey('HOST_API_KEY')).toBe('sensitive')
    expect(classifyEnvKey('PORT_SECRET')).toBe('sensitive')
    expect(classifyEnvKey('PATH_TO_KEY')).toBe('sensitive')
  })

  it('is case-insensitive', () => {
    expect(classifyEnvKey('database_url')).toBe('sensitive')
    expect(classifyEnvKey('Node_Env')).toBe('safe')
    expect(classifyEnvKey('jwt_SECRET')).toBe('sensitive')
  })

  it('returns unknown for keys matching no pattern', () => {
    expect(classifyEnvKey('FOO_BAR_BAZ')).toBe('unknown')
    expect(classifyEnvKey('MY_COMPANY_FEATURE_FLAG')).toBe('unknown')
  })

  it('isSensitiveEnvKey: unknown is treated as sensitive (secure default)', () => {
    expect(isSensitiveEnvKey('FOO_BAR_BAZ')).toBe(true)
    expect(isSensitiveEnvKey('PORT')).toBe(false)
    expect(isSensitiveEnvKey('STRIPE_SECRET_KEY')).toBe(true)
  })
})

describe('isBlockedFilePath', () => {
  it('blocks dotenv family', () => {
    const blocked = [
      '/project/.env',
      '/project/.env.local',
      '/project/.env.production',
      '/project/.env.staging',
      '/project/.env.test',
      '/project/.env.development',
      '/project/subdir/.env',
    ]
    for (const p of blocked) {
      expect(isBlockedFilePath(p)).toBe(true)
    }
  })

  it('blocks key/cert material', () => {
    const blocked = [
      '/project/certs/server.pem',
      '/project/keys/server.key',
      '/project/keystore.p12',
      '/project/bundle.pfx',
      '/project/keys/store.jks',
    ]
    for (const p of blocked) {
      expect(isBlockedFilePath(p)).toBe(true)
    }
  })

  it('blocks SSH private keys (all common names)', () => {
    const blocked = [
      '/home/user/.ssh/id_rsa',
      '/home/user/.ssh/id_ed25519',
      '/home/user/.ssh/id_ecdsa',
      '/home/user/.ssh/id_dsa',
    ]
    for (const p of blocked) {
      expect(isBlockedFilePath(p)).toBe(true)
    }
  })

  it('blocks credential JSON blobs', () => {
    expect(isBlockedFilePath('/project/credentials.json')).toBe(true)
    expect(isBlockedFilePath('/project/secrets.json')).toBe(true)
    expect(isBlockedFilePath('/project/.credentials/foo')).toBe(true)
    expect(isBlockedFilePath('/project/.secrets/foo')).toBe(true)
  })

  it('blocks tool-specific secret stores', () => {
    expect(isBlockedFilePath('/home/user/.netrc')).toBe(true)
    expect(isBlockedFilePath('/home/user/.npmrc')).toBe(true)
    expect(isBlockedFilePath('/home/user/.pgpass')).toBe(true)
    expect(isBlockedFilePath('/home/user/.my.cnf')).toBe(true)
  })

  it('does NOT block common false-positive targets', () => {
    const allowed = [
      '/project/package.json',
      '/project/package-lock.json',
      '/project/tsconfig.json',
      '/project/src/env.ts',
      '/project/.env.d.ts',
      '/project/env.example.md',
      '/project/env.example',
      '/project/src/config/environment.ts',
      '/project/src/config.ts',
      '/project/README.md',
    ]
    for (const p of allowed) {
      expect(isBlockedFilePath(p)).toBe(false)
    }
  })
})

describe('filterBlockedPaths', () => {
  it('drops blocked entries and preserves relative order', () => {
    const input = [
      'src/app.ts',
      '.env',
      'README.md',
      'id_rsa',
      'package.json',
      'keys/server.pem',
    ]
    expect(filterBlockedPaths(input)).toEqual([
      'src/app.ts',
      'README.md',
      'package.json',
    ])
  })

  it('returns an empty array when every entry is blocked', () => {
    expect(filterBlockedPaths(['.env', 'id_rsa', 'server.pem'])).toEqual([])
  })

  it('returns the input unchanged when nothing is blocked', () => {
    const input = ['a.ts', 'b.ts', 'c.ts']
    expect(filterBlockedPaths(input)).toEqual(input)
  })
})

describe('BLOCKED_FILE_GLOBS', () => {
  it('contains the canonical secret-file patterns ripgrep should exclude', () => {
    // Smoke test: every glob starts with `!` so ripgrep treats it as an
    // exclusion, and the canonical targets are all present.
    for (const glob of BLOCKED_FILE_GLOBS) {
      expect(glob.startsWith('!')).toBe(true)
    }
    const mustInclude = ['!.env', '!.env.*', '!*.pem', '!*.key', '!id_rsa', '!credentials.json']
    for (const expected of mustInclude) {
      expect(BLOCKED_FILE_GLOBS).toContain(expected)
    }
  })
})
