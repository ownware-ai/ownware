/**
 * Unit tests for `assertProfileIsSupported` — the guard that converts
 * schema-declared-but-runtime-unwired fields (F-04 workspace, F-06
 * hooks, F-08 sandbox, F-05 permissionMode, F-01 memory.sources/
 * isolation, F-20 postgres checkpoint) into loud, actionable errors.
 *
 * Each test asserts:
 *   - The specific field path is named in the error message.
 *   - The profile name is named in the error message.
 *   - A clean profile (schema defaults) passes without throwing.
 */

import { describe, it, expect } from 'vitest'
import {
  assertProfileIsSupported,
  UnsupportedProfileFieldError,
} from '../../../src/profile/unsupported.js'
import { ProfileSchema } from '../../../src/profile/schema.js'
import type { LoadedProfile } from '../../../src/profile/loader.js'

function makeProfile(overrides: Record<string, unknown> = {}): LoadedProfile {
  const config = ProfileSchema.parse({ name: 'guard-test', ...overrides })
  return {
    config,
    soulMd: null,
    agentsMd: null,
    skills: [],
    basePath: '/tmp/guard-test',
    timeoutMs: 1_800_000,
  }
}

describe('assertProfileIsSupported — clean path', () => {
  it('passes for a minimal default profile', () => {
    expect(() => assertProfileIsSupported(makeProfile())).not.toThrow()
  })

  it('passes with memory.enabled=false (newly wired, supported)', () => {
    const p = makeProfile({ memory: { enabled: false } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })

  it('passes with zone overrides (security.zones is fully wired)', () => {
    const p = makeProfile({
      security: {
        zones: {
          enabled: true,
          maxAutoZone: 'safe',
          overrides: [{ tool: 'fs_write', zone: 'workspace' }],
        },
      },
    })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('assertProfileIsSupported — workspace.* (F-04)', () => {
  it('rejects workspace.mode !== "cwd"', () => {
    const p = makeProfile({ workspace: { mode: 'managed' } })
    expect(() => assertProfileIsSupported(p)).toThrow(UnsupportedProfileFieldError)
    try { assertProfileIsSupported(p) } catch (e) {
      const err = e as UnsupportedProfileFieldError
      expect(err.field).toContain('workspace.mode')
      expect(err.profileName).toBe('guard-test')
      expect(err.message).toContain('guard-test')
    }
  })

  it('rejects workspace.isolation !== "shared"', () => {
    const p = makeProfile({ workspace: { isolation: 'per_run' } })
    expect(() => assertProfileIsSupported(p)).toThrow(/workspace\.isolation/)
  })

  it('rejects non-empty workspace.dirs', () => {
    const p = makeProfile({ workspace: { dirs: ['/tmp/some-dir'] } })
    expect(() => assertProfileIsSupported(p)).toThrow(/workspace\.dirs/)
  })
})

describe('assertProfileIsSupported — hooks.* (F-06)', () => {
  // All five buckets are wired now (profile/hooks.ts compiles them into
  // the engine HookRuntime: onStart→session.start, onToolCall→tool.pre,
  // onToolEnd→tool.post, onComplete→session.end, onError→error), so the
  // guard accepts every bucket — action-level validation happens loudly
  // in buildHookBinding at assembly.

  it('accepts every hook bucket (all wired)', () => {
    const p = makeProfile({
      hooks: {
        onStart: [{ action: 'log' }],
        onToolCall: [{ action: 'log' }],
        onToolEnd: [{ action: 'log' }],
        onComplete: [{ action: 'webhook', url: 'https://x' }],
        onError: [{ action: 'log' }],
      },
    })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })

  it('accepts empty hook buckets (the default)', () => {
    const p = makeProfile({ hooks: { onStart: [], onComplete: [] } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('assertProfileIsSupported — sandbox (F-08)', () => {
  it('rejects security.sandbox.enabled=true with docker provider', () => {
    const p = makeProfile({
      security: { sandbox: { enabled: true, provider: 'docker' } },
    })
    expect(() => assertProfileIsSupported(p)).toThrow(/sandbox\.enabled/)
  })

  it('accepts explicit sandbox.enabled=false (default)', () => {
    const p = makeProfile({
      security: { sandbox: { enabled: false, provider: 'local' } },
    })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('assertProfileIsSupported — permissionMode (F-05)', () => {
  // Post-2026-05-14 redesign: 'auto' is the real bypass mode (S2), so
  // it must be accepted at load time. 'deny' and 'allowlist' are
  // semantically dead (S1 made them coerce to 'ask') and still
  // rejected so operators don't think they're getting blocking
  // behaviour. 'ask' remains the default.

  it('accepts permissionMode="auto" (real bypass, S2)', () => {
    const p = makeProfile({ security: { permissionMode: 'auto' } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })

  it('rejects permissionMode="deny" (deprecated, was a silent-deny mode pre-redesign)', () => {
    const p = makeProfile({ security: { permissionMode: 'deny' } })
    expect(() => assertProfileIsSupported(p)).toThrow(/permissionMode/)
  })

  it('accepts permissionMode="ask" (default)', () => {
    const p = makeProfile({ security: { permissionMode: 'ask' } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('assertProfileIsSupported — memory (F-01)', () => {
  it('rejects non-default memory.sources', () => {
    const p = makeProfile({ memory: { sources: ['AGENTS.md', 'notes.md'] } })
    expect(() => assertProfileIsSupported(p)).toThrow(/memory\.sources/)
  })

  it('rejects empty memory.sources (schema default expanded to ["AGENTS.md"] is the only honored shape)', () => {
    const p = makeProfile({ memory: { sources: [] } })
    expect(() => assertProfileIsSupported(p)).toThrow(/memory\.sources/)
  })

  it('rejects memory.isolation="per_session"', () => {
    const p = makeProfile({ memory: { isolation: 'per_session' } })
    expect(() => assertProfileIsSupported(p)).toThrow(/memory\.isolation/)
  })

  it('rejects memory.isolation="per_thread"', () => {
    const p = makeProfile({ memory: { isolation: 'per_thread' } })
    expect(() => assertProfileIsSupported(p)).toThrow(/memory\.isolation/)
  })

  it('accepts default memory config', () => {
    const p = makeProfile({ memory: { enabled: true } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('assertProfileIsSupported — checkpoint (F-20)', () => {
  it('rejects checkpoint.store="postgres"', () => {
    const p = makeProfile({ checkpoint: { store: 'postgres' } })
    expect(() => assertProfileIsSupported(p)).toThrow(/checkpoint\.store/)
  })

  it('accepts checkpoint.store="memory"', () => {
    const p = makeProfile({ checkpoint: { store: 'memory' } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })

  it('accepts checkpoint.store="file" with a dir', () => {
    const p = makeProfile({ checkpoint: { store: 'file', dir: '/tmp/ckpt' } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })

  it('accepts checkpoint.store="none"', () => {
    const p = makeProfile({ checkpoint: { store: 'none' } })
    expect(() => assertProfileIsSupported(p)).not.toThrow()
  })
})

describe('UnsupportedProfileFieldError', () => {
  it('carries both the profile name and field on the error instance', () => {
    const p = makeProfile({ security: { sandbox: { enabled: true } } })
    try {
      assertProfileIsSupported(p)
      throw new Error('expected guard to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedProfileFieldError)
      const err = e as UnsupportedProfileFieldError
      expect(err.name).toBe('UnsupportedProfileFieldError')
      expect(err.profileName).toBe('guard-test')
      expect(err.field).toContain('sandbox.enabled')
      expect(err.message).toContain('"guard-test"')
      expect(err.message).toContain('not yet enforced by the runtime')
    }
  })
})
