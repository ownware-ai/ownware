/**
 * S7 — `security.zones.combinationRules` gate (2026-05-14 permission redesign).
 *
 * The bundled five-rule combination set (exfiltration-prevention,
 * credential-harvesting, shell-after-secrets, dns-exfiltration,
 * clipboard-exfiltration) was always-on pre-S7 and caught common
 * coding inputs containing `token` / `authorization` / `api_key` as
 * false positives. S7 makes the set opt-in via `combinationRules:
 * 'default-set'`; default is `'none'` (empty array) so routine
 * profiles don't carry the friction.
 *
 * These tests assert the schema → assembler → ZoneManager wiring is
 * correct: the cortex profile field drives the loom-side
 * `ZoneConfig.combinationRules` length.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createTempProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

describe("assembleAgent: security.zones.combinationRules — S7 opt-in gate", () => {
  it("defaults to 'none' — ZoneManager runs with an empty combinationRules array", async () => {
    // No security.zones.combinationRules field on the profile → schema
    // default kicks in → cortex passes an empty array to ZoneManager.
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({ name: 'combo-default' }),
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(agent.zoneManager).not.toBeNull()
    const cfg = agent.zoneManager!.getConfig()
    expect(cfg.combinationRules).toEqual([])
  })

  it("opts in with 'default-set' — ZoneManager has the bundled five rules", async () => {
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'combo-on',
          security: {
            zones: { combinationRules: 'default-set' },
          },
        }),
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(agent.zoneManager).not.toBeNull()
    const cfg = agent.zoneManager!.getConfig()
    expect(cfg.combinationRules.length).toBeGreaterThan(0)
    // Spot-check the bundled rules so a future swap of the default
    // set surfaces here intentionally rather than silently.
    const ruleNames = cfg.combinationRules.map(r => r.name)
    expect(ruleNames).toContain('exfiltration-prevention')
    expect(ruleNames).toContain('credential-harvesting')
  })

  it("'none' explicitly chosen has the same effect as the default", async () => {
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'combo-off',
          security: { zones: { combinationRules: 'none' } },
        }),
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)

    expect(agent.zoneManager).not.toBeNull()
    const cfg = agent.zoneManager!.getConfig()
    expect(cfg.combinationRules).toEqual([])
  })

  it("validates the schema enum — invalid values are rejected by zod", async () => {
    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'combo-bad',
          security: { zones: { combinationRules: 'invalid-value' } },
        }),
      }),
    )
    await expect(loadProfile(dir)).rejects.toThrow(/combinationRules/i)
  })
})
