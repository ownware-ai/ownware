/**
 * PermissionStore — disk-backed profile permission rules.
 *
 * Covers the round-trip contract the desktop client depends on:
 *   1. saveRule + load round-trip
 *   2. saveRule replaces, doesn't duplicate, on same toolPattern
 *   3. revokeRule removes (idempotent — missing rule returns false)
 *   4. NEVER-zone allow rules are rejected at save time (S1 safeguard)
 *   5. Legacy 'deny' entries on disk are dropped at load time (S1 migration)
 *   6. getEffectiveRules respects the security level's maxAutoZone
 *
 * Each test runs against a temp directory so on-disk state is isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionStore } from '../../../src/permissions/store.js'

describe('PermissionStore', () => {
  let tmp: string
  let store: PermissionStore

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'permission-store-test-'))
    store = new PermissionStore(tmp)
  })
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  describe('saveRule + load round-trip', () => {
    it('persists a saved rule that load returns identically', async () => {
      await store.saveRule('mini', {
        toolPattern: 'writeFile',
        maxZone: 2,
        decision: 'allow',
        reason: 'Approved via UI',
      })
      const loaded = await store.load('mini')
      expect(loaded.rules).toHaveLength(1)
      expect(loaded.rules[0]).toMatchObject({
        toolPattern: 'writeFile',
        maxZone: 2,
        decision: 'allow',
        reason: 'Approved via UI',
      })
      expect(typeof loaded.rules[0]?.createdAt).toBe('string')
    })

    it('replaces an existing rule for the same toolPattern instead of duplicating', async () => {
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 2, decision: 'allow' })
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 3, decision: 'allow' })
      const loaded = await store.load('mini')
      expect(loaded.rules).toHaveLength(1)
      expect(loaded.rules[0]?.maxZone).toBe(3)
    })

    it('keeps rules for different patterns side-by-side', async () => {
      await store.saveRule('mini', { toolPattern: 'writeFile', maxZone: 2, decision: 'allow' })
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 2, decision: 'allow' })
      const loaded = await store.load('mini')
      expect(loaded.rules).toHaveLength(2)
    })
  })

  describe('revokeRule (S6 — DELETE endpoint contract)', () => {
    it('removes a saved rule and returns true', async () => {
      await store.saveRule('mini', { toolPattern: 'writeFile', maxZone: 2, decision: 'allow' })
      const removed = await store.revokeRule('mini', 'writeFile')
      expect(removed).toBe(true)
      const loaded = await store.load('mini')
      expect(loaded.rules).toHaveLength(0)
    })

    it('returns false when the rule does not exist (idempotent)', async () => {
      const removed = await store.revokeRule('mini', 'never-saved')
      expect(removed).toBe(false)
    })

    it('returns false when the profile file does not exist (idempotent)', async () => {
      const removed = await store.revokeRule('absent-profile', 'writeFile')
      expect(removed).toBe(false)
    })

    it('leaves other rules intact when one is revoked', async () => {
      await store.saveRule('mini', { toolPattern: 'writeFile', maxZone: 2, decision: 'allow' })
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 2, decision: 'allow' })
      await store.revokeRule('mini', 'writeFile')
      const loaded = await store.load('mini')
      expect(loaded.rules).toHaveLength(1)
      expect(loaded.rules[0]?.toolPattern).toBe('shell.execute')
    })
  })

  describe('S1 safeguards (post-2026-05-14 redesign)', () => {
    it('rejects NEVER-zone allow rules at save time', async () => {
      await expect(
        store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 6, decision: 'allow' }),
      ).rejects.toThrow(/zone 6/i)
    })

    it("drops legacy 'deny' entries on load (S1 migration path)", async () => {
      // Hand-write a profile file mimicking the pre-redesign schema —
      // both 'allow' and 'deny' rules. After load, 'deny' is stripped.
      const filePath = join(tmp, 'legacy.json')
      const legacy = {
        profileId: 'legacy',
        version: 1,
        rules: [
          { toolPattern: 'writeFile', maxZone: 2, decision: 'allow', createdAt: '2026-04-01T00:00:00Z' },
          { toolPattern: 'shell.execute', maxZone: 2, decision: 'deny', createdAt: '2026-04-01T00:00:00Z' },
        ],
      }
      await mkdir(tmp, { recursive: true })
      await writeFile(filePath, JSON.stringify(legacy), 'utf-8')

      const loaded = await store.load('legacy')
      expect(loaded.rules).toHaveLength(1)
      expect(loaded.rules[0]?.toolPattern).toBe('writeFile')
      // The 'deny' entry never surfaces — the client cannot accidentally
      // re-introduce blocking behaviour we eliminated.
      expect(loaded.rules.find(r => r.toolPattern === 'shell.execute')).toBeUndefined()
    })
  })

  describe('getEffectiveRules — security-level ceiling', () => {
    it('returns rules whose maxZone is within the security level threshold', async () => {
      await store.saveRule('mini', { toolPattern: 'writeFile', maxZone: 1, decision: 'allow' })
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 3, decision: 'allow' })
      // maxAutoZone = 2 (BUILD) → only the maxZone=1 rule applies.
      const effective = await store.getEffectiveRules('mini', 2)
      expect(effective).toHaveLength(1)
      expect(effective[0]?.toolPattern).toBe('writeFile')
    })

    it('returns all rules when maxAutoZone is high enough to cover them', async () => {
      await store.saveRule('mini', { toolPattern: 'writeFile', maxZone: 1, decision: 'allow' })
      await store.saveRule('mini', { toolPattern: 'shell.execute', maxZone: 3, decision: 'allow' })
      const effective = await store.getEffectiveRules('mini', 5)
      expect(effective).toHaveLength(2)
    })
  })
})
