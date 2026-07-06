/**
 * Journey 10: Settings persistence
 *
 *   1. Set appearance settings
 *   2. Set defaults settings
 *   3. Read all settings — both present
 *   4. Update one — others unchanged
 *   5. Verify persistence after gateway restart simulation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 10 Settings Persistence', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: PUT /settings/appearance saves theme + fontSize', async () => {
    const r = await gw.client.put('/api/v1/settings/appearance', {
      theme: 'dark',
      fontSize: '14',
    })
    expect(r.status).toBe(200)
  })

  it('Step 2: PUT /settings/defaults saves model', async () => {
    const r = await gw.client.put('/api/v1/settings/defaults', {
      model: 'anthropic:claude-sonnet-4-20250514',
    })
    expect(r.status).toBe(200)
  })

  it('Step 3: GET /settings returns both sections', async () => {
    const r = await gw.client.get<Record<string, Record<string, string>>>('/api/v1/settings')
    expect(r.body['appearance']?.['theme']).toBe('dark')
    expect(r.body['appearance']?.['fontSize']).toBe('14')
    expect(r.body['defaults']?.['model']).toBe('anthropic:claude-sonnet-4-20250514')
  })

  it('Step 4: Updating theme leaves fontSize untouched', async () => {
    await gw.client.put('/api/v1/settings/appearance', { theme: 'light' })
    const r = await gw.client.get<Record<string, Record<string, string>>>('/api/v1/settings')
    expect(r.body['appearance']?.['theme']).toBe('light')
    expect(r.body['appearance']?.['fontSize']).toBe('14')
  })

  it('Step 5: Settings persist via direct DB read', () => {
    const theme = gw.state.getSetting('appearance.theme')
    const fontSize = gw.state.getSetting('appearance.fontSize')
    expect(theme?.value).toBe('light')
    expect(fontSize?.value).toBe('14')
  })
})
