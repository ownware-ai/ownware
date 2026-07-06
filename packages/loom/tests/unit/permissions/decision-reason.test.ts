/**
 * S4 — formatDecisionReason
 *
 * Pure-function tests for the `DecisionReason → model-readable string`
 * formatter. Each variant of the discriminated union has its own
 * assertion. The integration with the loop (typed reason on
 * `permission.response` + tool result content) is covered by
 * `tests/unit/core/session-permission-mode.test.ts` S4 cases.
 */

import { describe, it, expect } from 'vitest'
import {
  formatDecisionReason,
  type DecisionReason,
} from '../../../src/permissions/types.js'

describe('formatDecisionReason — typed deny reasons surfaced to the model', () => {
  describe("type: 'user-denied'", () => {
    it('names the tool and the target path', () => {
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'writeFile',
        toolInput: { file_path: '/work/secrets/.env', content: 'x' },
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('writeFile')
      expect(msg).toContain('/work/secrets/.env')
      expect(msg).toMatch(/decline/i)
    })

    it('names the command for shell tools', () => {
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'shell.execute',
        toolInput: { command: 'rm -rf /tmp/build' },
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('shell.execute')
      expect(msg).toContain('rm -rf /tmp/build')
    })

    it('includes severity tag and reason when present', () => {
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'writeFile',
        toolInput: { file_path: '/work/.env' },
        severityTag: 'critical',
        severityReason: 'This path looks sensitive: Environment file',
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('critical')
      expect(msg).toContain('Environment file')
    })

    it('includes the optional user note when supplied', () => {
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'writeFile',
        toolInput: { file_path: 'foo.html' },
        note: 'I want to review this manually first',
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('I want to review this manually first')
    })

    it('falls back gracefully when no recognised input field is present', () => {
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'some_mcp_tool',
        toolInput: { custom_field: 'abc', some_other: 42 },
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('some_mcp_tool')
      // No path / command / url / query → falls back to a generic
      // description so we always have *something* useful in the prose.
      expect(msg.length).toBeGreaterThan(20)
    })

    it('truncates very long commands so the model message stays readable', () => {
      const longCmd = 'echo ' + 'x'.repeat(500)
      const reason: DecisionReason = {
        type: 'user-denied',
        toolName: 'shell.execute',
        toolInput: { command: longCmd },
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('…')
      expect(msg.length).toBeLessThan(longCmd.length + 200)
    })
  })

  describe("type: 'timeout'", () => {
    it('names the timeout duration and suggests an actionable next step', () => {
      const reason: DecisionReason = {
        type: 'timeout',
        toolName: 'writeFile',
        timeoutMs: 30000,
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('30000')
      expect(msg).toContain('writeFile')
      expect(msg).toMatch(/auto|interactiv/i)
    })
  })

  describe("type: 'hook-blocked'", () => {
    it('quotes the hook reason verbatim so the user can investigate', () => {
      const reason: DecisionReason = {
        type: 'hook-blocked',
        toolName: 'writeFile',
        reason: 'Corp policy 42: writes to /opt require change ticket',
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('Corp policy 42')
      expect(msg).toContain('change ticket')
    })

    it('includes the rule id when present', () => {
      const reason: DecisionReason = {
        type: 'hook-blocked',
        toolName: 'shell.execute',
        reason: 'Network calls blocked in this run',
        ruleId: 'net-block-prod',
      }
      const msg = formatDecisionReason(reason)
      expect(msg).toContain('net-block-prod')
    })
  })
})
