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
  it('profile-default model without credentials falls back to the available provider', async () => {
    const res = await fetch(`${baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: 'test-agent', prompt: 'hello' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { model: string; threadId: string }
    // NOT the profile's anthropic pin — the available provider's default.
    expect(body.model).toBe('openai:gpt-5.5')
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
    // Whatever the failure surface is (immediate error or a started run
    // that dies on provider resolution), the response must never claim
    // a DIFFERENT model than the one explicitly requested.
    if (res.status === 200) {
      const body = (await res.json()) as { model: string }
      expect(body.model).toBe('anthropic:claude-sonnet-4-6')
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400)
    }
  })
})
