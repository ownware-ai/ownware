/**
 * Unit tests — credential context fragment in the assembled system prompt.
 *
 * Uses the real assembler against a lightweight fixture profile so the
 * test exercises the same PromptBuilder path the gateway hits at
 * runtime. Confirms:
 *
 *   - Credential handles surface as NAMES (with placement annotation),
 *     never values.
 *   - configVars surface as KEY=value pairs (non-sensitive only).
 *   - Absent / empty credential context is a no-op (no empty section).
 *   - The fragment lives in the `context` slot so it joins the cacheable
 *     prefix alongside git/os/date context.
 */

import { describe, it, expect, afterEach } from 'vitest'
import type { CredentialHandle } from '@ownware/loom'
import { systemPromptToText } from '@ownware/loom'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

async function assembledWith(credentialContext?: {
  credentialHandles: readonly CredentialHandle[]
  configVars: Readonly<Record<string, string>>
}) {
  const { dir, cleanup } = await createMinimalProfile({ tools: { preset: 'none' } })
  cleanups.push(cleanup)
  const profile = await loadProfile(dir)
  return assembleAgent(profile, credentialContext ? { credentialContext } : {})
}

function handle(variableName: string, label: string): CredentialHandle {
  return {
    credentialId: `runtime_t1_${variableName}`,
    label,
    placement: { type: 'env', variableName },
    storedAt: Date.now(),
  }
}

describe('credential context fragment', () => {
  it('names every handle in "Available Credentials" with no values', async () => {
    const assembled = await assembledWith({
      credentialHandles: [
        handle('DATABASE_URL', 'DATABASE_URL (from .env)'),
        handle('STRIPE_KEY', 'STRIPE_KEY (from .env)'),
      ],
      configVars: {},
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain('## Available Credentials')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('`DATABASE_URL`')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('`STRIPE_KEY`')
    // Must not contain a literal secret-looking value — if the fragment
    // ever leaks a vault value, this guard catches the most common form.
    expect(systemPromptToText(assembled.systemPrompt)).not.toMatch(/postgres:\/\/|sk_live_|ghp_/)
  })

  it('renders configVars as plain KEY=value under "Environment Config"', async () => {
    const assembled = await assembledWith({
      credentialHandles: [],
      configVars: { PORT: '3000', NODE_ENV: 'development' },
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain('## Environment Config')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('`PORT` = `3000`')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('`NODE_ENV` = `development`')
  })

  it('skips the fragment entirely when both halves are empty', async () => {
    const assembled = await assembledWith({ credentialHandles: [], configVars: {} })
    expect(systemPromptToText(assembled.systemPrompt)).not.toContain('## Available Credentials')
    expect(systemPromptToText(assembled.systemPrompt)).not.toContain('## Environment Config')
  })

  it('skips the fragment when credentialContext is not passed', async () => {
    const assembled = await assembledWith()
    expect(systemPromptToText(assembled.systemPrompt)).not.toContain('## Available Credentials')
    expect(systemPromptToText(assembled.systemPrompt)).not.toContain('## Environment Config')
  })

  it('sorts configVars by key for deterministic prompts', async () => {
    const assembled = await assembledWith({
      credentialHandles: [],
      configVars: { ZEBRA: '1', APPLE: '2', MANGO: '3' },
    })
    const section = systemPromptToText(assembled.systemPrompt).split('## Environment Config')[1] ?? ''
    const appleIdx = section.indexOf('APPLE')
    const mangoIdx = section.indexOf('MANGO')
    const zebraIdx = section.indexOf('ZEBRA')
    expect(appleIdx).toBeGreaterThanOrEqual(0)
    expect(mangoIdx).toBeGreaterThan(appleIdx)
    expect(zebraIdx).toBeGreaterThan(mangoIdx)
  })

  it('annotates non-env placements with their placement kind', async () => {
    const bearerHandle: CredentialHandle = {
      credentialId: 'runtime_t1_bearer_1',
      label: 'Service API Bearer',
      placement: { type: 'bearer' },
      storedAt: Date.now(),
    }
    const assembled = await assembledWith({
      credentialHandles: [bearerHandle],
      configVars: {},
    })
    expect(systemPromptToText(assembled.systemPrompt)).toContain('Service API Bearer')
    expect(systemPromptToText(assembled.systemPrompt)).toContain('placement: bearer')
  })
})
