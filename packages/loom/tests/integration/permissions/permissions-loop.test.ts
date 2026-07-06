import { describe, it, expect } from 'vitest'
import { PermissionEvaluator } from '../../../src/permissions/evaluator.js'
import { SessionPermissionStore } from '../../../src/permissions/session-store.js'
import { HumanInTheLoop } from '../../../src/permissions/hitl.js'
import { BUILT_IN_SAFETY_RULES } from '../../../src/permissions/rules.js'
import { CODING_AGENT_RULES } from '../../../src/security/default-rules.js'
import type { SecurityContext } from '../../../src/permissions/types.js'

describe('Permissions integration — evaluator + rules + session store + HITL', () => {
  it('full flow: safety surfaces dangerous command to user in ask mode (auto bypasses)', () => {
    // S2 contract: 'auto' is a true bypass — safety rules are not
    // consulted. To exercise the safety path, use 'ask' mode (the
    // default for interactive sessions). Post-2026-05-14 redesign,
    // a matching safety rule promotes the decision to 'ask' so the
    // user sees the warning and decides — never silent-deny.
    const evaluator = new PermissionEvaluator({ safetyRules: CODING_AGENT_RULES })
    const ctx: SecurityContext = { sessionId: 'test', mode: 'ask' }

    const decision = evaluator.evaluate('shell.execute', { command: 'rm -rf /tmp/x' }, ctx)
    expect(decision).toBe('ask')
  })

  it('full flow: session store overrides rules', () => {
    const sessionStore = new SessionPermissionStore()
    const evaluator = new PermissionEvaluator({
      rules: [{ pattern: 'shell', decision: 'ask' }],
      safetyRules: [], // disable safety so we test rule vs session
      sessionStore,
    })
    const ctx: SecurityContext = { sessionId: 'test', mode: 'deny' }

    // Rule says ask
    expect(evaluator.evaluate('shell', { command: 'ls' }, ctx)).toBe('ask')

    // User says "always allow shell this session"
    sessionStore.remember('shell', 'allow')
    expect(evaluator.evaluate('shell', { command: 'ls' }, ctx)).toBe('allow')

    // Clear session — falls back through rule (ask) and mode (deny → coerced ask)
    sessionStore.clear()
    expect(evaluator.evaluate('shell', { command: 'ls' }, ctx)).toBe('ask')
  })

  it('full flow: evaluator + HITL approval', async () => {
    const evaluator = new PermissionEvaluator({
      rules: [{ pattern: 'shell', decision: 'ask' }],
      safetyRules: [],
    })
    const hitl = new HumanInTheLoop({ timeoutMs: 1000 })
    const ctx: SecurityContext = { sessionId: 'test', mode: 'ask' }

    // Evaluate says "ask"
    const decision = evaluator.evaluate('shell', { command: 'npm install' }, ctx)
    expect(decision).toBe('ask')

    // Simulate HITL flow: auto-approve
    hitl.onApprovalNeeded((req) => {
      hitl.respond(req.requestId, true)
    })

    const approved = await hitl.requestApproval(
      { id: 'call_1', name: 'shell', input: { command: 'npm install' } },
    )
    expect(approved).toBe(true)

    // Remember for session
    evaluator.remember('shell', 'allow')
    const nextDecision = evaluator.evaluate('shell', { command: 'npm test' }, ctx)
    expect(nextDecision).toBe('allow')

    hitl.dispose()
  })

  it('full flow: allowlist mode prompts for unlisted tools (post-redesign: ask, not deny)', () => {
    const evaluator = new PermissionEvaluator({
      rules: [
        { pattern: 'filesystem.readFile', decision: 'allow' },
        { pattern: 'search.*', decision: 'allow' },
      ],
      safetyRules: [],
    })
    const ctx: SecurityContext = { sessionId: 'test', mode: 'allowlist' }

    expect(evaluator.evaluate('filesystem.readFile', {}, ctx)).toBe('allow')
    expect(evaluator.evaluate('search.grep', {}, ctx)).toBe('allow')
    // Pre-redesign these defaulted to deny. Now allowlist mode falls
    // through to the universal 'ask' default — the user reads what the
    // unlisted tool wants to do and decides.
    expect(evaluator.evaluate('shell', { command: 'ls' }, ctx)).toBe('ask')
    expect(evaluator.evaluate('browser', { url: 'https://google.com' }, ctx)).toBe('ask')
  })

  it('safety rules flag secrets in any tool (in ask mode — auto would bypass)', () => {
    // Use CODING_AGENT_RULES since BUILT_IN is now empty by design.
    // S2: switch to 'ask' so the safety pipeline runs. In 'auto' mode
    // the bypass would short-circuit before the secret-flag rule fires.
    const evaluator = new PermissionEvaluator({ safetyRules: CODING_AGENT_RULES })
    const ctx: SecurityContext = { sessionId: 'test', mode: 'ask' }

    // Should flag AWS key
    const decision = evaluator.evaluate(
      'filesystem.writeFile',
      { content: 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
      ctx,
    )
    expect(decision).toBe('ask')
  })

  it('concurrent HITL requests handled independently', async () => {
    const hitl = new HumanInTheLoop({ timeoutMs: 5000 })
    const responses: boolean[] = []

    hitl.onApprovalNeeded((req) => {
      // Approve odd-numbered, deny even-numbered
      const num = parseInt(req.requestId.replace('call_', ''))
      setTimeout(() => hitl.respond(req.requestId, num % 2 === 1), 10)
    })

    const promises = [
      hitl.requestApproval({ id: 'call_1', name: 'a', input: {} }),
      hitl.requestApproval({ id: 'call_2', name: 'b', input: {} }),
      hitl.requestApproval({ id: 'call_3', name: 'c', input: {} }),
    ]

    const results = await Promise.all(promises)
    expect(results).toEqual([true, false, true])

    hitl.dispose()
  })
})
