/**
 * Journey 01: Onboarding flow
 *
 * Mirrors what a user does on first launch:
 *   1. Fresh state — no session, no settings
 *   2. Set display name + role
 *   3. Save Anthropic API key
 *   4. (If key) validate it works
 *   5. Mark onboarding complete
 *   6. Verify everything persisted
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

describe('Journey: 01 Onboarding', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: Fresh state — no local profile yet', async () => {
    const profile = gw.state.getLocalProfile()
    expect(profile).toBeUndefined()
  })

  it('Step 2: POST /onboarding/role creates local profile', async () => {
    const r = await gw.client.post<{ role: string; displayName: string }>(
      '/api/v1/onboarding/role',
      { name: 'Sam', role: 'developer' },
    )
    expect(r.status).toBe(200)
    expect(r.body.role).toBe('developer')
    expect(r.body.displayName).toBe('Sam')

    // Verify local profile was created
    const profile = gw.state.getLocalProfile()
    expect(profile).toBeDefined()
    expect(profile!.displayName).toBe('Sam')
  })

  it('Step 3: POST /providers saves API key', async () => {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? 'sk-ant-test12345678901234567890'
    const r = await gw.client.post<{ provider: string; keyHint: string }>(
      '/api/v1/providers',
      { provider: 'anthropic', key: apiKey },
    )
    expect(r.status).toBe(200)
    expect(r.body.provider).toBe('anthropic')
    expect(r.body.keyHint).toBeTruthy()
  })

  it.skipIf(!HAS_KEY)('Step 4: POST /providers/validate confirms key works', async () => {
    const r = await gw.client.post<{ isValid: boolean }>(
      '/api/v1/providers/validate',
      { provider: 'anthropic', key: process.env['ANTHROPIC_API_KEY'] },
    )
    expect(r.status).toBe(200)
    expect(r.body.isValid).toBe(true)
  }, 30_000)

  it('Step 5: POST /onboarding/complete marks done', async () => {
    const r = await gw.client.post<{ completed: boolean }>('/api/v1/onboarding/complete', {})
    expect(r.status).toBe(200)
    expect(r.body.completed).toBe(true)
  })

  it('Step 6: All onboarding state persisted', async () => {
    // Local profile
    const profile = gw.state.getLocalProfile()
    expect(profile?.displayName).toBe('Sam')

    // Onboarding role setting
    const role = gw.state.getSetting('onboarding.role')
    expect(role?.value).toBe('developer')

    // Onboarding completed app state
    const completed = gw.state.getAppState('onboarding_completed')
    expect(completed?.value).toBe('true')

    // Provider key stored — verify via the public API (unified credentials store)
    const r = await gw.client.get<readonly { provider: string; keyHint: string }[]>('/api/v1/providers')
    expect(r.status).toBe(200)
    expect(r.body.find((p) => p.provider === 'anthropic')).toBeDefined()
  })
})
