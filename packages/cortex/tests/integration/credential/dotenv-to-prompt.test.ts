/**
 * Integration test — `.env` → vault → assembled system prompt.
 *
 * End-to-end flow without spinning up the HTTP gateway:
 *
 *   1. Write a representative workspace `.env` (mixed sensitive + config).
 *   2. Run `ThreadCredentialRuntime.importFromWorkspace`.
 *   3. Assemble a session with the resulting credentialContext.
 *   4. Prove:
 *        a. Sensitive .env values live in the vault (encrypted).
 *        b. Sensitive values are NOT in the system prompt.
 *        c. Credential NAMES are in the system prompt.
 *        d. Config values (PORT, NODE_ENV) ARE in the system prompt.
 *        e. `resolveValue` returns the vault value for a known id.
 *        f. `listAllCredentialValues` returns values with labels for the
 *           shell output redactor.
 *
 * Everything below runs against the real Loom bundle (dist) — no
 * provider mocking. The assembler is pure so this is fast and
 * deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ThreadCredentialRuntime,
  makeRuntimeCredentialId,
} from '../../../src/credential/runtime.js'
import {
  credentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'
import { systemPromptToText } from '@ownware/loom'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

let tmpHome: string
let tmpWorkspace: string
let prevHome: string | undefined
const cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-int-cred-'))
  tmpWorkspace = mkdtempSync(join(tmpdir(), 'cortex-int-ws-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
})

afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpWorkspace, { recursive: true, force: true })
})

describe('integration: .env auto-import → assembled system prompt', () => {
  it('stores sensitive values in vault, names them in prompt, value-leaks safe config only', async () => {
    // 1. Representative workspace .env.
    writeFileSync(join(tmpWorkspace, '.env'), [
      '# App config',
      'NODE_ENV=development',
      'PORT=3000',
      'LOG_LEVEL=debug',
      '',
      '# Secrets',
      'DATABASE_URL=postgres://user:pw@host:5432/db',
      'JWT_SECRET=sk_live_abcdef1234567890',
      'STRIPE_SECRET_KEY=sk_live_XXXXXXXX',
    ].join('\n'), 'utf-8')

    // 2. Runtime import.
    const threadId = 'integration-t1'
    const runtime = new ThreadCredentialRuntime(threadId, credentialVault)
    const imported = await runtime.importFromWorkspace(tmpWorkspace)

    // 3. Assemble with the resulting context.
    const { dir, cleanup } = await createMinimalProfile({ tools: { preset: 'none' } })
    cleanups.push(cleanup)
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile, {
      credentialContext: {
        credentialHandles: runtime.listHandles(),
        configVars: imported.configVars,
      },
    })

    // 4a. Sensitive values live in vault (decryptable).
    const dbBundle = await credentialVault.load(makeRuntimeCredentialId(threadId, 'DATABASE_URL'))
    expect(dbBundle?.env.DATABASE_URL).toBe('postgres://user:pw@host:5432/db')

    // 4b. Sensitive values NOT in system prompt. This is the whole
    // point of the isolation story — a regression here is a direct
    // credential-leak bug.
    const prompt = systemPromptToText(assembled.systemPrompt)
    expect(prompt).not.toContain('postgres://user:pw@host:5432/db')
    expect(prompt).not.toContain('sk_live_abcdef1234567890')
    expect(prompt).not.toContain('sk_live_XXXXXXXX')

    // 4c. Credential names ARE in the system prompt.
    expect(prompt).toContain('## Available Credentials')
    expect(prompt).toContain('DATABASE_URL')
    expect(prompt).toContain('JWT_SECRET')
    expect(prompt).toContain('STRIPE_SECRET_KEY')

    // 4d. Config values ARE visible.
    expect(prompt).toContain('## Environment Config')
    expect(prompt).toContain('`NODE_ENV` = `development`')
    expect(prompt).toContain('`PORT` = `3000`')
    expect(prompt).toContain('`LOG_LEVEL` = `debug`')

    // 4e. resolveValue returns the vault value synchronously (cache
    // was pre-populated by import, so no await).
    const dbId = makeRuntimeCredentialId(threadId, 'DATABASE_URL')
    expect(runtime.resolveValue(dbId)).toBe('postgres://user:pw@host:5432/db')

    // 4f. Redaction manifest — the shell output redactor calls this
    // per-spawn and must see every known value alongside its label.
    const redactionValues = runtime.listAllCredentialValues()
    const byLabel = new Map(redactionValues.map(v => [v.label, v.value]))
    expect(byLabel.get('DATABASE_URL (from .env)')).toBe('postgres://user:pw@host:5432/db')
    expect(byLabel.get('JWT_SECRET (from .env)')).toBe('sk_live_abcdef1234567890')

    // 4g. Env-injection manifest — shell reads this to know which vars
    // to auto-inject into every subprocess.
    const envEntries = runtime.listEnvCredentials()
    expect(envEntries.map(e => e.variableName).sort()).toEqual([
      'DATABASE_URL', 'JWT_SECRET', 'STRIPE_SECRET_KEY',
    ])

    // Cleanup: runtime_-scoped entries disappear, otherwise vault is
    // unchanged. Simulates deleteThread path.
    await runtime.cleanup()
    expect(await credentialVault.load(dbId)).toBeNull()
  })

  it('scopes cleanup to runtime_<threadId>_* — leaves MCP credentials untouched', async () => {
    // Seed an MCP-style (non-runtime) credential first.
    await credentialVault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_xxx' })

    // Then run an import.
    writeFileSync(join(tmpWorkspace, '.env'), 'DATABASE_URL=postgres://x', 'utf-8')
    const runtime = new ThreadCredentialRuntime('t-isolation', credentialVault)
    await runtime.importFromWorkspace(tmpWorkspace)

    await runtime.cleanup()

    // Runtime credential gone.
    expect(
      await credentialVault.load(makeRuntimeCredentialId('t-isolation', 'DATABASE_URL')),
    ).toBeNull()
    // MCP credential untouched.
    const mcp = await credentialVault.load('mcp-server-github')
    expect(mcp?.env.GITHUB_TOKEN).toBe('ghp_xxx')
  })

  it('is a no-op end-to-end when the workspace has no .env', async () => {
    const runtime = new ThreadCredentialRuntime('t-empty', credentialVault)
    const imported = await runtime.importFromWorkspace(tmpWorkspace)

    const { dir, cleanup } = await createMinimalProfile({ tools: { preset: 'none' } })
    cleanups.push(cleanup)
    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile, {
      credentialContext: {
        credentialHandles: runtime.listHandles(),
        configVars: imported.configVars,
      },
    })

    expect(imported.imported).toEqual([])
    expect(imported.configVars).toEqual({})
    expect(assembled.systemPrompt).not.toContain('## Available Credentials')
    expect(assembled.systemPrompt).not.toContain('## Environment Config')
  })
})
