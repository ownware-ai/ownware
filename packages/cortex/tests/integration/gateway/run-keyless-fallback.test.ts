/**
 * POST /api/v1/run keyless fallback (F1) — the run path swaps a
 * profile-default model whose provider has no credentials for one that
 * can actually answer, and ONLY then.
 *
 * Scope pinned here:
 *   1. Profile pins a cloud model with no credentials + another
 *      provider IS available → the run dispatches the available
 *      provider's default (response.model tells the truth).
 *   2. An EXPLICIT body.model with an unavailable provider is never
 *      second-guessed — it must not silently fall back.
 *   3. An install default seeds independent threads; a later explicit
 *      choice changes only that thread and remains authoritative next turn.
 *
 * Real gateway, temp profilesDir + dataDir (per gateway CLAUDE.md).
 * Provider availability is driven through Loom's registry — a fake
 * `openai` adapter stands in for "the user saved an OpenAI key".
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProviders, registerProvider, unregisterProvider } from '@ownware/loom'
import type { ProviderAdapter } from '@ownware/loom'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-fallback-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-fallback-data-'))

  const profileDir = join(profilesDir, 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'agent.json'),
    JSON.stringify(
      {
        name: 'test-agent',
        description: 'Keyless-fallback fixture',
        // A provider this test env has NO credentials for.
        model: 'anthropic:claude-sonnet-4-6',
      },
      null,
      2,
    ),
  )
  await writeFile(join(profileDir, 'SOUL.md'), '# Fixture\n')

  // Empty Loom's registry (test env vars may have auto-registered
  // providers), then stand up exactly one "available" provider.
  for (const name of listProviders()) unregisterProvider(name)
  registerProvider({ name: 'openai' } as unknown as ProviderAdapter)

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 15_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
  for (const name of listProviders()) unregisterProvider(name)
})

describe('POST /run keyless fallback', () => {
  it('profile fallback returns the same truthful receipt on idempotent replay', async () => {
    const request = () => fetch(`${baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '14141414-1414-4141-8141-141414141414',
      },
      body: JSON.stringify({ profileId: 'test-agent', prompt: 'hello' }),
    })
    const res = await request()
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      model: string
      threadId: string
      modelSubstitution?: Record<string, unknown>
    }
    // NOT the profile's anthropic pin — the available provider's default.
    expect(body.model).toBe('openai:gpt-5.5')
    expect(body.modelSubstitution).toEqual({
      configuredModel: 'anthropic:claude-sonnet-4-6',
      effectiveModel: 'openai:gpt-5.5',
      configuredSource: 'profile',
      reason: 'profile_default_unavailable',
    })

    const replay = await request()
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(await replay.json()).toEqual(body)
  })

  it('uses the async install default without reporting a substitution', async () => {
    await gateway.state.setSetting('defaults.defaultModel', '  openai:gpt-5.5  ')
    const res = await fetch(`${baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'test-agent', prompt: 'use install default' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      model: string
      modelSubstitution?: unknown
    }
    expect(body.model).toBe('openai:gpt-5.5')
    expect(body.modelSubstitution).toBeUndefined()
  })

  it('keeps an explicit override on only its thread after the install default seeds both', async () => {
    registerProvider({ name: 'google' } as unknown as ProviderAdapter)

    const start = async (prompt: string, input: { threadId?: string; model?: string } = {}) => {
      const res = await fetch(`${baseUrl}/api/v1/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: 'test-agent', prompt, ...input }),
      })
      expect(res.status).toBe(200)
      return await res.json() as { threadId: string; model: string }
    }

    const first = await start('first install-default thread')
    const second = await start('second install-default thread')
    expect(first.model).toBe('openai:gpt-5.5')
    expect(second.model).toBe('openai:gpt-5.5')
    await Promise.all([waitForRun(first.threadId), waitForRun(second.threadId)])

    const overridden = await start('change only this thread', {
      threadId: first.threadId,
      model: 'google:gemini-2.5-flash',
    })
    expect(overridden.model).toBe('google:gemini-2.5-flash')
    await waitForRun(first.threadId)

    const firstContinued = await start('keep the override', { threadId: first.threadId })
    const secondContinued = await start('keep the install choice', { threadId: second.threadId })
    expect(firstContinued.model).toBe('google:gemini-2.5-flash')
    expect(secondContinued.model).toBe('openai:gpt-5.5')
  })

  it('an explicit body.model with an unavailable provider is not silently swapped', async () => {
    const res = await fetch(`${baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: 'test-agent',
        prompt: 'hello',
        model: 'anthropic:claude-sonnet-4-6',
      }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'model_unavailable' })
  })
})

async function waitForRun(threadId: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (gateway.runner.isRunning(threadId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(gateway.runner.isRunning(threadId)).toBe(false)
}
