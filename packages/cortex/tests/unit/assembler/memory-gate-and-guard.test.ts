/**
 * Targeted tests for three related fixes in `assembleAgent()`:
 *
 *   - F-01: `memory.enabled` is now honored. When `false`, the AGENTS.md
 *     file is NOT injected into the system prompt even if the file exists
 *     on disk. When `true` (the default), the pre-existing behaviour
 *     is preserved.
 *
 *   - F-04/F-05/F-06/F-08/F-20: `assertProfileIsSupported()` runs at the
 *     top of assemble; opting into any dead-at-runtime field (workspace,
 *     hooks, sandbox, non-"ask" permissionMode, postgres checkpoint,
 *     custom memory sources/isolation) throws a clear error instead of
 *     silently no-oping.
 *
 * These tests go through the real `assembleAgent()` and the real loader
 * — no mocks — but avoid provider initialisation cost by using the
 * anthropic provider name string; no network calls are made at assembly.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { systemPromptToText } from '@ownware/loom'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { UnsupportedProfileFieldError } from '../../../src/profile/unsupported.js'
import { createMinimalProfile, createTempProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

const AGENTS_SENTINEL = '__MEMORY_SENTINEL_8F3A__'

describe('assembleAgent: memory.enabled gate (F-01)', () => {
  it('injects AGENTS.md when memory.enabled=true (default)', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'mem-on' }),
      'SOUL.md': '# On\n',
      'AGENTS.md': `# Memory\n\n${AGENTS_SENTINEL}\n`,
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).toContain(AGENTS_SENTINEL)
  })

  it('omits AGENTS.md when memory.enabled=false', async () => {
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'mem-off', memory: { enabled: false } }),
      'SOUL.md': '# Off\n',
      'AGENTS.md': `# Memory\n\n${AGENTS_SENTINEL}\n`,
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).not.toContain(AGENTS_SENTINEL)
  })

  it('omits memory cleanly even when AGENTS.md is missing on disk and enabled=true', async () => {
    // No AGENTS.md at all — the gate should not crash.
    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({ name: 'no-agents-md' }),
      'SOUL.md': '# Solo\n',
    }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(systemPromptToText(agent.systemPrompt)).not.toContain(AGENTS_SENTINEL)
  })
})

describe('assembleAgent: unsupported-field guard is wired (F-04/05/06/08/20)', () => {
  it('throws on workspace.mode="managed"', async () => {
    const { dir } = track(await createMinimalProfile({ workspace: { mode: 'managed' } }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toBeInstanceOf(UnsupportedProfileFieldError)
  })

  it('accepts non-empty hooks (all buckets wired via profile/hooks.ts)', async () => {
    // All five buckets compile into the engine HookRuntime now — the
    // guard accepts them (see hooks-wiring.test.ts for the positive
    // wiring assertions; malformed hooks still fail loudly there).
    const wired = track(await createMinimalProfile({
      hooks: {
        onStart: [{ action: 'log' }],
        onComplete: [{ action: 'log' }],
        onError: [{ action: 'log' }],
      },
    }))
    const wiredProfile = await loadProfile(wired.dir)
    await expect(assembleAgent(wiredProfile)).resolves.toBeDefined()
  })

  it('throws on security.sandbox.enabled=true', async () => {
    const { dir } = track(await createMinimalProfile({
      security: { sandbox: { enabled: true, provider: 'docker' } },
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/sandbox\.enabled/)
  })

  it('accepts security.permissionMode="auto" as a policy-aware fallback', async () => {
    // 'auto' was previously rejected by the unsupported-field guard
    // because pre-redesign the value had unpredictable interactions
    // with the zone-as-safety-rule pipeline. `auto` now controls only the
    // fallback after the host's wired closure runs. The guard now
    // accepts it; only the truly-unwired modes ('deny', 'allowlist')
    // are rejected.
    const { dir } = track(await createMinimalProfile({
      security: { permissionMode: 'auto' },
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).resolves.toBeDefined()
  })

  it('throws on security.permissionMode="deny" (semantically dead after redesign)', async () => {
    const { dir } = track(await createMinimalProfile({
      security: { permissionMode: 'deny' },
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/permissionMode/)
  })

  it('throws on memory.isolation="per_thread"', async () => {
    const { dir } = track(await createMinimalProfile({
      memory: { isolation: 'per_thread' },
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/memory\.isolation/)
  })

  it('throws on checkpoint.store="postgres"', async () => {
    const { dir } = track(await createMinimalProfile({
      checkpoint: { store: 'postgres' },
    }))
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).rejects.toThrow(/checkpoint\.store/)
  })

  it('assembles cleanly for a minimal profile (guard is conservative, not blocking)', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    await expect(assembleAgent(profile)).resolves.toBeDefined()
  })
})
