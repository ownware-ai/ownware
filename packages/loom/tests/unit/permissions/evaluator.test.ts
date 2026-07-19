import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PermissionEvaluator } from '../../../src/permissions/evaluator.js'
import { SessionPermissionStore } from '../../../src/permissions/session-store.js'
import type { SecurityContext, PermissionRule } from '../../../src/permissions/types.js'

function ctx(mode: SecurityContext['mode'] = 'ask'): SecurityContext {
  return { sessionId: 'test-session', mode }
}

describe('PermissionEvaluator', () => {
  describe('default mode behavior', () => {
    it('auto mode defaults to allow', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      expect(evaluator.evaluate('anything', {}, ctx('auto'))).toBe('allow')
    })

    it('ask mode defaults to ask', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      expect(evaluator.evaluate('anything', {}, ctx('ask'))).toBe('ask')
    })

    it('deny mode (deprecated) coerces to ask post-redesign', () => {
      // The 'deny' permission mode used to mean "default deny all". After
      // 2026-05-14 the policy layer cannot deny; the mode is retained for
      // on-disk back-compat and falls through to 'ask' so the user is
      // always the final arbiter.
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      expect(evaluator.evaluate('anything', {}, ctx('deny'))).toBe('ask')
    })

    it('allowlist mode defaults to ask (post-redesign: never auto-deny)', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      expect(evaluator.evaluate('anything', {}, ctx('allowlist'))).toBe('ask')
    })
  })

  describe('safety rules take priority', () => {
    it('safety ask surfaces in ask mode', () => {
      const evaluator = new PermissionEvaluator({
        safetyRules: [() => 'ask'],
      })
      expect(evaluator.evaluate('shell', { command: 'rm -rf /' }, ctx('ask'))).toBe('ask')
    })

    it('safety rules checked before user rules (ask mode)', () => {
      const evaluator = new PermissionEvaluator({
        rules: [{ pattern: '*', decision: 'allow' }],
        safetyRules: [() => 'ask'],
      })
      expect(evaluator.evaluate('anything', {}, ctx('ask'))).toBe('ask')
    })

    it('safety rule returning null means no opinion (ask mode falls through to mode default)', () => {
      const evaluator = new PermissionEvaluator({
        safetyRules: [() => null],
      })
      expect(evaluator.evaluate('anything', {}, ctx('ask'))).toBe('ask')
    })

    it("'auto' is only the fallback and cannot bypass a configured safety rule", () => {
      const safetyRule = vi.fn(() => 'ask' as const)
      const evaluator = new PermissionEvaluator({
        safetyRules: [safetyRule],
      })
      expect(evaluator.evaluate('shell', { command: 'rm -rf /' }, ctx('auto'))).toBe('ask')
      expect(safetyRule).toHaveBeenCalledWith('shell', { command: 'rm -rf /' })
    })
  })

  describe('session store', () => {
    it('session remembered decision used before rules', () => {
      const sessionStore = new SessionPermissionStore()
      sessionStore.remember('shell', 'allow')

      const evaluator = new PermissionEvaluator({
        rules: [{ pattern: 'shell', decision: 'ask' }],
        safetyRules: [],
        sessionStore,
      })
      expect(evaluator.evaluate('shell', {}, ctx('deny'))).toBe('allow')
    })
  })

  describe('user-defined rules with glob patterns', () => {
    let evaluator: PermissionEvaluator

    beforeEach(() => {
      evaluator = new PermissionEvaluator({
        rules: [
          { pattern: 'filesystem.*', decision: 'allow' },
          { pattern: 'shell', decision: 'ask' },
          { pattern: 'browser.*', decision: 'ask' },
        ],
        safetyRules: [],
      })
    })

    it('exact match works', () => {
      expect(evaluator.evaluate('shell', {}, ctx('deny'))).toBe('ask')
    })

    it('glob filesystem.* matches filesystem.readFile', () => {
      expect(evaluator.evaluate('filesystem.readFile', {}, ctx('deny'))).toBe('allow')
    })

    it('glob filesystem.* matches filesystem.writeFile', () => {
      expect(evaluator.evaluate('filesystem.writeFile', {}, ctx('deny'))).toBe('allow')
    })

    it('glob browser.* matches browser.navigate', () => {
      expect(evaluator.evaluate('browser.navigate', {}, ctx('ask'))).toBe('ask')
    })

    it('unmatched tool falls through to mode default', () => {
      expect(evaluator.evaluate('unknown_tool', {}, ctx('ask'))).toBe('ask')
    })

    it('first match wins', () => {
      const eval2 = new PermissionEvaluator({
        rules: [
          { pattern: 'shell', decision: 'allow' },
          { pattern: 'shell', decision: 'ask' },
        ],
        safetyRules: [],
      })
      expect(eval2.evaluate('shell', {}, ctx('deny'))).toBe('allow')
    })
  })

  describe('wildcard * matches everything', () => {
    it('pattern * matches any tool name', () => {
      const evaluator = new PermissionEvaluator({
        rules: [{ pattern: '*', decision: 'allow' }],
        safetyRules: [],
      })
      expect(evaluator.evaluate('anything', {}, ctx('deny'))).toBe('allow')
      expect(evaluator.evaluate('filesystem.readFile', {}, ctx('deny'))).toBe('allow')
    })
  })

  describe('remember and clearSession', () => {
    it('remember persists for the evaluator instance', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      evaluator.remember('shell', 'allow')
      expect(evaluator.evaluate('shell', {}, ctx('deny'))).toBe('allow')
    })

    it('clearSession removes remembered decisions', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      evaluator.remember('shell', 'allow')
      evaluator.clearSession()
      // After clearing, the remembered allow is gone; with no rules and
      // mode 'deny' (deprecated, coerces to ask) the call falls through
      // to the mode default, which is now 'ask'.
      expect(evaluator.evaluate('shell', {}, ctx('deny'))).toBe('ask')
    })
  })

  describe('addRule / removeRule / setRules', () => {
    it('addRule appends a rule', () => {
      const evaluator = new PermissionEvaluator({ safetyRules: [] })
      evaluator.addRule({ pattern: 'shell', decision: 'ask' })
      expect(evaluator.evaluate('shell', {}, ctx('ask'))).toBe('ask')
    })

    it('removeRule removes matching pattern', () => {
      const evaluator = new PermissionEvaluator({
        rules: [{ pattern: 'shell', decision: 'ask' }],
        safetyRules: [],
      })
      evaluator.removeRule('shell')
      expect(evaluator.evaluate('shell', {}, ctx('auto'))).toBe('allow')
    })

    it('setRules replaces all rules', () => {
      const evaluator = new PermissionEvaluator({
        rules: [{ pattern: 'shell', decision: 'ask' }],
        safetyRules: [],
      })
      evaluator.setRules([{ pattern: 'shell', decision: 'allow' }])
      expect(evaluator.evaluate('shell', {}, ctx('deny'))).toBe('allow')
    })

    it('getRules returns current rules', () => {
      const rules: PermissionRule[] = [{ pattern: 'x', decision: 'allow' }]
      const evaluator = new PermissionEvaluator({ rules, safetyRules: [] })
      expect(evaluator.getRules()).toHaveLength(1)
      expect(evaluator.getRules()[0]!.pattern).toBe('x')
    })
  })
})
