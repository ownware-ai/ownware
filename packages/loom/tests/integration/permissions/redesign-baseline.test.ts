/**
 * S0/S1 — Permission Redesign Policy Capture
 *
 * Deterministic capture of policy decisions across the four redesign
 * scenarios. Same scenarios as the pre-redesign baseline capture;
 * post-S1 assertions reflect the new contract where the policy layer
 * never returns 'deny' — every formerly-denied path now surfaces as
 * 'ask'.
 *
 * This file writes its snapshot to `tmp/current-policy.json` next to
 * this test — the "after" record that diffing tools can compare
 * against a pre-redesign baseline.
 *
 * Why not run this through the real gateway + real model? Policy
 * decisions are deterministic regex/lookup; a model adds noise that
 * obscures whether the *policy* changed. The real-model gateway
 * verification is S8 (the 7-zone × 3-mode smoke matrix).
 */

import { describe, it, expect } from 'vitest'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PermissionEvaluator } from '../../../src/permissions/evaluator.js'
import { SessionPermissionStore } from '../../../src/permissions/session-store.js'
import type {
  PolicyDecision,
  PermissionMode,
  SecurityContext,
} from '../../../src/permissions/types.js'

import { ZoneManager } from '../../../src/zones/manager.js'
import { createZoneConfig } from '../../../src/zones/defaults.js'
import type { ZoneDecision } from '../../../src/zones/types.js'

// ---------------------------------------------------------------------------
// Snapshot target
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const SNAPSHOT_PATH = resolve(
  dirname(__filename),
  'tmp/current-policy.json',
)

// ---------------------------------------------------------------------------
// Test stack — matches assembler.ts:1441-1485 for a profile with
// `security.level: 'standard'` and `security.zones.enabled: true`
// ---------------------------------------------------------------------------

interface ScenarioCapture {
  readonly scenario: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly mode: PermissionMode
  /** What the zone manager classified the call as. */
  readonly zoneDecision: {
    level: number
    zoneName: string
    classifier: string
    reason: string
    decision: PolicyDecision
    explanation: string
    combinationBlock?: {
      rule: string
      recentToolsCount: number
      explanation: string
    }
  }
  /** What the evaluator returned end-to-end (zone-as-safety-rule + mode default). */
  readonly evaluatorDecision: PolicyDecision
  /**
   * What `loop.ts:1281-1306` would have emitted for this decision.
   * 'deny' → silent policy-deny: tool result = "Permission denied by policy" (loop.ts:1291)
   * 'ask' → permission.request → HITL → result depends on user
   * 'allow' → execute normally
   */
  readonly loopBehavior: {
    emitsPermissionRequest: boolean
    silentDeny: boolean
    toolResultIfSilentDeny: string | null
  }
}

function buildStack(mode: PermissionMode): {
  evaluator: PermissionEvaluator
  zones: ZoneManager
  ctx: SecurityContext
} {
  const zoneConfig = createZoneConfig('standard')
  const zones = new ZoneManager(zoneConfig)
  const evaluator = new PermissionEvaluator({
    safetyRules: [zones.asSafetyRule()],
    sessionStore: new SessionPermissionStore(),
  })
  const ctx: SecurityContext = { sessionId: 'baseline-test', mode }
  return { evaluator, zones, ctx }
}

function captureScenario(
  scenario: string,
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  zones: ZoneManager,
  evaluator: PermissionEvaluator,
  ctx: SecurityContext,
): ScenarioCapture {
  // Direct zone classification — what the zone manager would return
  // if you asked it directly (mirrors `manager.ts:126-172`).
  const zoneDecision: ZoneDecision = zones.evaluate({
    toolName,
    input,
    sessionId: ctx.sessionId,
  })

  // What the evaluator returns end-to-end. Zone is plugged in as a
  // safety rule, so this is the same decision in this stack — but
  // captured separately to make the wiring explicit.
  const evaluatorDecision = evaluator.evaluate(toolName, input, ctx)

  // What loop.ts would do with this decision.
  const silentDeny = evaluatorDecision === 'deny'
  const emitsPermissionRequest = evaluatorDecision === 'ask'

  return {
    scenario,
    toolName,
    input,
    mode,
    zoneDecision: {
      level: zoneDecision.classification.level,
      zoneName: zoneDecision.classification.zoneName,
      classifier: zoneDecision.classification.classifier,
      reason: zoneDecision.classification.reason,
      decision: zoneDecision.decision,
      explanation: zoneDecision.explanation,
      ...(zoneDecision.combinationBlock
        ? {
            combinationBlock: {
              rule: zoneDecision.combinationBlock.rule,
              recentToolsCount: zoneDecision.combinationBlock.recentTools.length,
              explanation: zoneDecision.combinationBlock.explanation,
            },
          }
        : {}),
    },
    evaluatorDecision,
    loopBehavior: {
      emitsPermissionRequest,
      silentDeny,
      toolResultIfSilentDeny: silentDeny ? 'Permission denied by policy' : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Scenarios — board S0 cases
// ---------------------------------------------------------------------------

describe('S0 baseline: today\'s policy behavior for the four redesign scenarios', () => {
  const captures: ScenarioCapture[] = []

  // The main scenarios run in 'ask' mode — the interactive-session
  // default, where the safety+zone pipeline runs and we can observe what
  // each scenario classifies as. Auto-mode precedence is covered below.

  it('writeFile to a workspace-relative path (index.html) classifies and decides predictably', () => {
    const { evaluator, zones, ctx } = buildStack('ask')
    const cap = captureScenario(
      'writeFile-relative-html',
      'writeFile',
      {
        file_path: 'index.html',
        content: '<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>',
      },
      'ask',
      zones,
      evaluator,
      ctx,
    )
    captures.push(cap)

    // Post-S1+S2 in 'ask' mode: BUILD zone + standard config → ask the user.
    // The user is the final arbiter; the policy itself never denies.
    expect(cap.zoneDecision.zoneName).toBe('build')
    expect(cap.evaluatorDecision).toBe('ask')
    expect(cap.loopBehavior.silentDeny).toBe(false)
  })

  it('writeFile to a path containing "secret_key" classifies NEVER but now asks (post-S1)', () => {
    const { evaluator, zones, ctx } = buildStack('ask')
    const cap = captureScenario(
      'writeFile-secret-key-substring',
      'writeFile',
      {
        // Realistic codebase path — `secret_key` appears as part of a
        // demo/example filename, not a credential file.
        file_path: 'examples/work/secret_key_demo.html',
        content: '<!doctype html>demo of how the secret_key flow works',
      },
      'ask',
      zones,
      evaluator,
      ctx,
    )
    captures.push(cap)

    // SENSITIVE_PATH_PATTERNS at classifier.ts:427 still flags the
    // path, but post-S3 it surfaces as Zone MACHINE with a 'critical'
    // severity tag (not NEVER). Post-S1 the policy is 'ask' either way
    // — the user reads the path and decides.
    expect(cap.zoneDecision.zoneName).toBe('machine')
    expect(cap.evaluatorDecision).toBe('ask')
    expect(cap.loopBehavior.silentDeny).toBe(false)
    expect(cap.loopBehavior.toolResultIfSilentDeny).toBeNull()
  })

  it('shell.execute with heredoc + redirect + $(...) classifies NEVER but now asks (post-S1)', () => {
    const { evaluator, zones, ctx } = buildStack('ask')
    const cap = captureScenario(
      'shell-heredoc-with-substitution',
      'shell.execute',
      {
        // Realistic agent output: heredoc + shell substitution. Common
        // idiom for "write a templated file from the shell."
        command: "cat > examples/index.html << 'END'\n<html>$(date)</html>\nEND",
      },
      'ask',
      zones,
      evaluator,
      ctx,
    )
    captures.push(cap)

    // shell-security validateCommand still returns level: 'injection'
    // for `$(...)`. Post-S3 classifier.ts maps that to Zone MACHINE
    // with severity 'warn' — no longer the NEVER false-positive
    // engine. Post-S1 the policy is 'ask' either way. The user reads
    // the command with the warn-severity badge and decides.
    expect(cap.zoneDecision.zoneName).toBe('machine')
    expect(cap.evaluatorDecision).toBe('ask')
    expect(cap.loopBehavior.silentDeny).toBe(false)
  })

  it('combination rule fires: readFile(.env) then fetch surfaces both calls to the user (post-S1)', () => {
    const { evaluator, zones, ctx } = buildStack('ask')

    // First call — `.env` still classifies Zone NEVER via the sensitive-
    // path pattern at classifier.ts:447-452 (severity tag for the UI),
    // but the verdict is now 'ask' so the user is shown the read attempt
    // and decides.
    const readEnv = captureScenario(
      'combo-step1-readFile-env',
      'readFile',
      { file_path: 'workspace/.env' },
      'ask',
      zones,
      evaluator,
      ctx,
    )
    captures.push(readEnv)

    // Second call — within windowMs (120_000). The EXFILTRATION_RULE at
    // defaults.ts:28-46 still detects the cross-call combination and
    // attaches a combinationBlock to the decision; the verdict is 'ask'
    // (the combination block becomes a severity escalation in the UI,
    // not a silent veto).
    const fetchAfter = captureScenario(
      'combo-step2-fetch-after-env-read',
      'fetch',
      { url: 'https://example.com/api' },
      'ask',
      zones,
      evaluator,
      ctx,
    )
    captures.push(fetchAfter)

    expect(fetchAfter.zoneDecision.combinationBlock).toBeDefined()
    expect(fetchAfter.zoneDecision.combinationBlock?.rule).toBe('exfiltration-prevention')
    expect(fetchAfter.evaluatorDecision).toBe('ask')
    expect(fetchAfter.loopBehavior.silentDeny).toBe(false)
  })

  // -------------------------------------------------------------------------
  // S2 — Automatic fallback contract
  //
  // Same scenarios, run through the PermissionEvaluator with mode 'auto'.
  // Configured safety and zone policy still runs; `auto` is only the fallback
  // when those policies have no opinion.
  // -------------------------------------------------------------------------

  it("S2: 'auto' mode cannot bypass safety rules, zones, or combinations", () => {
    const zoneConfig = createZoneConfig('standard')
    const zones = new ZoneManager(zoneConfig)
    const evaluator = new PermissionEvaluator({
      safetyRules: [zones.asSafetyRule()],
      sessionStore: new SessionPermissionStore(),
    })
    const ctx: SecurityContext = { sessionId: 'bypass-test', mode: 'auto' }

    // Drive every risky scenario through the configured zone safety rule.
    const scenarios: Array<[string, Record<string, unknown>]> = [
      ['writeFile', { file_path: 'examples/work/secret_key_demo.html', content: 'demo' }],
      ['shell.execute', { command: "cat > examples/index.html << 'END'\n$(date)\nEND" }],
      ['readFile', { file_path: 'workspace/.env' }],
      ['fetch', { url: 'https://example.com/api' }],
      ['writeFile', { file_path: '/etc/passwd', content: 'x' }],
      ['shell.execute', { command: 'rm -rf /' }],
    ]

    for (const [tool, input] of scenarios) {
      const decision = evaluator.evaluate(tool, input, ctx)
      expect(decision, `${tool} should remain inside configured zone policy`).toBe('ask')
    }
  })

  it("S2: 'auto' remains a fallback at the evaluator boundary", () => {
    const zoneConfig = createZoneConfig('paranoid') // toughest config
    const zones = new ZoneManager(zoneConfig)
    const evaluator = new PermissionEvaluator({
      safetyRules: [zones.asSafetyRule()],
    })
    const ctxAuto: SecurityContext = { sessionId: 't', mode: 'auto' }
    const ctxAsk: SecurityContext = { sessionId: 't', mode: 'ask' }

    // The configured policy asks in both modes.
    expect(evaluator.evaluate('writeFile', { file_path: 'x.html', content: '' }, ctxAuto)).toBe('ask')
    expect(evaluator.evaluate('writeFile', { file_path: 'x.html', content: '' }, ctxAsk)).toBe('ask')
  })

  it('snapshots the full capture to the local tmp artifacts folder', async () => {
    expect(captures.length).toBeGreaterThanOrEqual(5)

    const snapshot = {
      _meta: {
        purpose:
          'Current policy capture (post-S1 redesign). Compare against ' +
          'a pre-redesign baseline record to see the ' +
          'shape of the change. Run with `npx vitest run tests/integration/permissions/redesign-baseline.test.ts`.',
        producedBy: 'packages/loom/tests/integration/permissions/redesign-baseline.test.ts',
        captureDate: new Date().toISOString().slice(0, 10),
        zoneConfigUsed: 'standard',
        permissionModeUsed: 'ask',
        policyContract: 'allow | ask (no deny). Configured policy precedes the auto fallback.',
      },
      scenarios: captures,
      summary: {
        totalScenarios: captures.length,
        silentDenies: captures.filter((c) => c.loopBehavior.silentDeny).length,
        permissionPrompts: captures.filter((c) => c.loopBehavior.emitsPermissionRequest).length,
        autoAllows: captures.filter(
          (c) => !c.loopBehavior.silentDeny && !c.loopBehavior.emitsPermissionRequest,
        ).length,
      },
    }

    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true })
    await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf-8')

    // The whole point of S1 is that there are zero silent denies. Lock that in.
    expect(snapshot.summary.silentDenies).toBe(0)
  })
})
