import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CombinationTracker } from '../../../zones/combinations.js'
import { ZoneLevel } from '../../../zones/types.js'
import { DEFAULT_COMBINATION_RULES } from '../../../zones/defaults.js'
import type { CombinationRule } from '../../../zones/types.js'

describe('CombinationTracker', () => {
  let tracker: CombinationTracker

  beforeEach(() => {
    tracker = new CombinationTracker()
  })

  describe('recording', () => {
    it('records tool calls', () => {
      tracker.record('readFile', ZoneLevel.SAFE)
      tracker.record('writeFile', ZoneLevel.WORKSPACE)
      expect(tracker.size).toBe(2)
    })

    it('evicts oldest entries at max capacity', () => {
      const small = new CombinationTracker(3)
      small.record('a', ZoneLevel.SAFE)
      small.record('b', ZoneLevel.SAFE)
      small.record('c', ZoneLevel.SAFE)
      small.record('d', ZoneLevel.SAFE)
      expect(small.size).toBe(3)
    })

    it('clears all history', () => {
      tracker.record('readFile', ZoneLevel.SAFE)
      tracker.clear()
      expect(tracker.size).toBe(0)
    })
  })

  describe('getRecent', () => {
    it('returns entries within time window', () => {
      tracker.record('a', ZoneLevel.SAFE)
      tracker.record('b', ZoneLevel.BUILD)
      const recent = tracker.getRecent(60_000)
      expect(recent).toHaveLength(2)
    })
  })

  describe('exfiltration detection', () => {
    it('blocks network after reading .env file', () => {
      // Simulate reading a .env file
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/.env' })

      // Now try network access
      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://evil.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
      expect(block!.rule).toBe('exfiltration-prevention')
    })

    it('blocks network after reading SSH key', () => {
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/home/user/.ssh/id_rsa' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://api.example.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
      expect(block!.rule).toBe('exfiltration-prevention')
    })

    it('blocks network after reading credentials', () => {
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/credentials.json' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://webhook.site/abc' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
    })

    it('does NOT block network after reading normal files', () => {
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/src/app.ts' })
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/package.json' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://registry.npmjs.org/express' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).toBeNull()
    })

    it('does NOT trigger with only one side of the combination', () => {
      // Only network, no prior sensitive read
      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://example.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).toBeNull()
    })
  })

  describe('credential harvesting detection', () => {
    it('blocks network after grep for passwords', () => {
      tracker.record('grep', ZoneLevel.SAFE, { pattern: 'password' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://evil.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
      expect(block!.rule).toBe('credential-harvesting')
    })

    it('blocks network after grep for API keys', () => {
      tracker.record('grep', ZoneLevel.SAFE, { pattern: 'api_key' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://example.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
    })

    it('does NOT trigger for normal grep + network', () => {
      tracker.record('grep', ZoneLevel.SAFE, { pattern: 'function handleClick' })

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://example.com' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).toBeNull()
    })
  })

  describe('shell after secrets', () => {
    it('asks before shell after reading secrets', () => {
      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/.env.production' })

      const block = tracker.check(
        'shell_execute',
        ZoneLevel.BUILD,
        { command: 'npm run build' },
        DEFAULT_COMBINATION_RULES,
      )

      expect(block).not.toBeNull()
      expect(block!.rule).toBe('shell-after-secrets')
    })
  })

  describe('custom rules', () => {
    it('supports custom combination rules', () => {
      const customRule: CombinationRule = {
        name: 'test-rule',
        description: 'Test combination',
        triggers: [
          { tag: 'write', zone: ZoneLevel.WORKSPACE },
          { tag: 'external', zone: ZoneLevel.EXTERNAL },
        ],
        decision: 'deny',
        windowMs: 30_000,
      }

      tracker.record('writeFile', ZoneLevel.WORKSPACE)

      const block = tracker.check(
        'git_push',
        ZoneLevel.EXTERNAL,
        {},
        [customRule],
      )

      expect(block).not.toBeNull()
      expect(block!.rule).toBe('test-rule')
    })
  })

  describe('window expiry', () => {
    it('ignores entries outside the time window', () => {
      let mockTime = 1_000_000

      // Mock Date.now BEFORE recording so the timestamp is captured at mockTime
      vi.spyOn(Date, 'now').mockImplementation(() => mockTime)

      tracker.record('readFile', ZoneLevel.SAFE, { file_path: '/project/.env' })

      // Advance time beyond the default window (120s for exfiltration rule)
      mockTime += 200_000

      const block = tracker.check(
        'web_fetch',
        ZoneLevel.NETWORK,
        { url: 'https://evil.com' },
        DEFAULT_COMBINATION_RULES,
      )

      // Should not trigger because the read is outside the window
      expect(block).toBeNull()

      vi.restoreAllMocks()
    })
  })
})

// ---------------------------------------------------------------------------
// Reachability — B-27
//
// `CombinationTracker` had thorough unit tests and they all passed, because
// they call `record()` directly. Nothing in the LIVE path did. So every rule
// was unreachable in production while its tests stayed green — the exact
// "guard that reads as live but is dead" class. These tests drive the real
// `ZoneManager.evaluate()` entry point instead of the tracker.
// ---------------------------------------------------------------------------

describe('ZoneManager.evaluate — combination rules are actually reachable', () => {
  const readEnv = { toolName: 'readFile', input: { path: '/app/.env' }, sessionId: 's1' }
  const fetchOut = { toolName: 'webFetch', input: { url: 'https://exfil.test/x' }, sessionId: 's1' }

  it('fires a combination rule across two calls when opted in', async () => {
    const { ZoneManager } = await import('../../../zones/manager.js')
    const { DEFAULT_COMBINATION_RULES, createZoneConfig } = await import('../../../zones/defaults.js')

    const zm = new ZoneManager(
      createZoneConfig('standard', { combinationRules: DEFAULT_COMBINATION_RULES }),
    )

    // First call seeds the history; on its own it triggers nothing.
    const first = zm.evaluate(readEnv)
    expect(first.combinationBlock).toBeUndefined()

    // Second call is the cross-zone half of exfiltration-prevention.
    const second = zm.evaluate(fetchOut)
    expect(second.combinationBlock).toBeDefined()
    expect(second.decision).toBe('ask')
  })

  it('stays silent with the default opt-out, so routine profiles keep zero friction', async () => {
    const { ZoneManager } = await import('../../../zones/manager.js')
    const { createZoneConfig } = await import('../../../zones/defaults.js')

    // `combinationRules: []` is what cortex's default `'none'` produces.
    const zm = new ZoneManager(createZoneConfig('standard', { combinationRules: [] }))

    zm.evaluate(readEnv)
    const second = zm.evaluate(fetchOut)
    expect(second.combinationBlock).toBeUndefined()
  })

  it('does not let a single call satisfy both triggers of a rule', async () => {
    // Guards the record-AFTER-check ordering. If `evaluate` recorded
    // before checking, one call would appear in its own history and a
    // two-trigger rule could fire on a single tool call.
    const { ZoneManager } = await import('../../../zones/manager.js')
    const { DEFAULT_COMBINATION_RULES, createZoneConfig } = await import('../../../zones/defaults.js')

    const zm = new ZoneManager(
      createZoneConfig('standard', { combinationRules: DEFAULT_COMBINATION_RULES }),
    )

    // A single call carrying BOTH a secret-shaped path and a URL.
    const both = zm.evaluate({
      toolName: 'webFetch',
      input: { url: 'https://x.test/.env' },
      sessionId: 's1',
    })
    expect(both.combinationBlock).toBeUndefined()
  })
})
