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
