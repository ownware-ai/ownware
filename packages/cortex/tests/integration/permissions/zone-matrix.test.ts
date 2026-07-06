/**
 * S8 — Per-zone × per-mode end-to-end smoke matrix.
 *
 * Drives the full cortex assembler → Session → loom loop wire for a
 * representative tool from each zone (SAFE through NEVER) across both
 * `'ask'` and `'auto'` modes, asserting the redesigned contract:
 *
 *   - Zero `'Permission denied by policy'` strings anywhere in the
 *     event stream.
 *   - In `'ask'` mode: above-maxAutoZone tools emit a
 *     `permission.request` event with the right `zoneName` (and
 *     `severityTag` for warn/critical classifications).
 *   - In `'auto'` mode: NO `permission.request` events fire — the
 *     session-level bypass (S2) short-circuits every call to `'allow'`.
 *   - User-deny on a `'ask'` path produces a typed `DecisionReason`
 *     (S4) on the `permission.response` event.
 *
 * Uses a deterministic mock provider that emits one tool_use call per
 * test so we control exactly which zone gets exercised. The real-model
 * variant (driving Haiku 4.5 through OpenRouter) adds noise without
 * proving anything the deterministic version misses — the deterministic
 * S0 baseline (`packages/loom/tests/integration/permissions/redesign-baseline.test.ts`)
 * locks the policy contract, and this matrix locks the assembler-to-
 * session WIRE contract. Different concerns, both covered.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'
import { Session } from '@ownware/loom'
import type {
  LoomEvent,
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '@ownware/loom'

// ---------------------------------------------------------------------------
// Provider that emits exactly one tool_use call with the given name + input
// ---------------------------------------------------------------------------

function makeToolUseProvider(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      yield {
        type: 'tool_use_start',
        toolCallId: 'tc-1',
        toolName,
        input,
      } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use' as const, id: 'tc-1', name: toolName, input }],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },
    async countTokens() { return 10 },
    supportsFeature(_f: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

async function buildSession(opts: {
  permissionMode: 'ask' | 'auto'
  toolName: string
  toolInput: Record<string, unknown>
}): Promise<{ session: Session; events: LoomEvent[] }> {
  const { dir } = track(
    await createMinimalProfile({
      security: {
        permissionMode: opts.permissionMode,
        // Combination rules off (S7 default) so per-call classification
        // is the only signal — no cross-call noise interfering.
        zones: { combinationRules: 'none' },
      },
    }),
  )
  const profile = await loadProfile(dir)
  const assembled = await assembleAgent(profile)

  // Replace the provider with our deterministic tool-use emitter so
  // we control exactly what runs. The rest of the assembled stack
  // (zone manager, checkPermission wrapper, severity plumbing) is real.
  //
  // maxTurns: 2 bounds the loop — the mock provider re-emits the same
  // tool_use every turn, so without a bound we'd accumulate
  // permission.request events up to the default 100-turn ceiling.
  // Two turns lets the gate fire and the deny path close cleanly.
  const session = new Session({
    config: { ...assembled.config, maxTurns: 2 },
    provider: makeToolUseProvider(opts.toolName, opts.toolInput),
    tools: assembled.tools,
    permissionMode: opts.permissionMode,
    // checkPermission wired through the assembler's zone manager
    // when present — same wiring as cortex's run.ts handler.
    ...(assembled.zoneManager
      ? {
          checkPermission: async (tool) => {
            const decision = assembled.zoneManager!.evaluate({
              toolName: tool.name,
              input: tool.input,
              sessionId: 'matrix-test',
            })
            return {
              decision: decision.decision,
              zoneLevel: decision.classification.level,
              zoneName: decision.classification.zoneName,
              explanation: decision.explanation,
              ...(decision.classification.severityTag !== undefined
                ? { severityTag: decision.classification.severityTag }
                : {}),
              ...(decision.classification.severityReason !== undefined
                ? { severityReason: decision.classification.severityReason }
                : {}),
            }
          },
          // In 'ask' mode the user always denies in this matrix so we
          // can assert the typed DecisionReason. A real UI client is where
          // the user clicks Allow; the contract here is "non-allow
          // produces a typed reason."
          requestApproval: async () => false,
        }
      : {}),
  })

  const events: LoomEvent[] = []
  const gen = session.submitMessage('do the thing')
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { session, events }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPermissionRequests(events: LoomEvent[]) {
  return events.filter(
    (e): e is Extract<LoomEvent, { type: 'permission.request' }> =>
      e.type === 'permission.request',
  )
}

function findPermissionResponses(events: LoomEvent[]) {
  return events.filter(
    (e): e is Extract<LoomEvent, { type: 'permission.response' }> =>
      e.type === 'permission.response',
  )
}

function findToolCallEnds(events: LoomEvent[]) {
  return events.filter(
    (e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
      e.type === 'tool.call.end',
  )
}

function hasPolicyDenyString(events: LoomEvent[]): boolean {
  return events.some(
    e =>
      e.type === 'tool.call.end' &&
      typeof (e as { result?: unknown }).result === 'string' &&
      ((e as { result: string }).result === 'Permission denied by policy'),
  )
}

// ---------------------------------------------------------------------------
// Per-zone matrix — `ask` mode (interactive)
// ---------------------------------------------------------------------------

describe('S8 zone matrix — ask mode (full assembler wire)', () => {
  it('Zone SAFE: readFile in workspace auto-allows (no permission.request)', async () => {
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'readFile',
      toolInput: { file_path: 'README.md' },
    })
    expect(findPermissionRequests(events).length).toBe(0)
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  // The mock provider re-emits the same tool_use every turn; with
  // maxTurns: 2 the loop fires the permission gate twice (once per
  // turn) before stopping. We assert ≥ 1 (the contract is "ask
  // happens at all") rather than exactly 1.

  it('Zone BUILD: writeFile asks (permission.request fires with zoneName "build")', async () => {
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'writeFile',
      toolInput: { file_path: 'foo.html', content: '<p>hi</p>' },
    })
    const reqs = findPermissionRequests(events)
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    expect(reqs[0]?.zoneName).toBe('build')
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  it('Zone NEVER (was): sensitive path read asks with severityTag "critical" — never silent-deny', async () => {
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'readFile',
      toolInput: { file_path: '/home/user/.ssh/id_rsa' },
    })
    const reqs = findPermissionRequests(events)
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    // Post-S3: the sensitive-path classifier maps to MACHINE zone with
    // severityTag 'critical'. The user sees the prompt; no silent deny.
    expect(reqs[0]?.zoneName).toBe('machine')
    expect(reqs[0]?.severityTag).toBe('critical')
    expect(reqs[0]?.severityReason).toMatch(/sensitive/i)
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  it('Zone NEVER (catastrophic): rm -rf / asks with severityTag "critical" — user is the arbiter', async () => {
    // shell_execute is the canonical builtin name. The classifier
    // accepts both 'shell.execute' and 'shell_execute' but only the
    // _underscore form is present in the coding preset's tool list,
    // so this is what the loop will gate.
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'shell_execute',
      toolInput: { command: 'rm -rf /' },
    })
    const reqs = findPermissionRequests(events)
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    expect(reqs[0]?.zoneName).toBe('never')
    expect(reqs[0]?.severityTag).toBe('critical')
    // The deterministic catastrophic patterns are the ONLY ones that
    // stay at Zone NEVER post-S3 — but they still ask, never silent-deny.
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  it('User-deny on a permission.request yields a typed DecisionReason (S4)', async () => {
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'writeFile',
      toolInput: { file_path: '/work/secrets/.env', content: 'x' },
    })
    const responses = findPermissionResponses(events)
    expect(responses.length).toBeGreaterThanOrEqual(1)
    // All denied responses on the same tool_use carry the same typed reason.
    for (const r of responses) {
      expect(r.granted).toBe(false)
      expect(r.reason?.type).toBe('user-denied')
      if (r.reason?.type === 'user-denied') {
        expect(r.reason.toolName).toBe('writeFile')
        expect(r.reason.toolInput).toEqual({
          file_path: '/work/secrets/.env',
          content: 'x',
        })
      }
    }
    const callEnd = findToolCallEnds(events).find(e => e.toolCallId === 'tc-1')
    expect(callEnd?.result).toContain('/work/secrets/.env')
    expect(callEnd?.result).toContain('writeFile')
    expect(callEnd?.result).not.toBe('User denied this action')
    expect(callEnd?.result).not.toBe('Permission denied by policy')
  })
})

// ---------------------------------------------------------------------------
// Per-zone matrix — `auto` mode (true bypass, S2)
// ---------------------------------------------------------------------------

describe('S8 zone matrix — auto mode (true bypass)', () => {
  it('Zone BUILD: writeFile auto-allows — no permission.request', async () => {
    const { events } = await buildSession({
      permissionMode: 'auto',
      toolName: 'writeFile',
      toolInput: { file_path: 'foo.html', content: 'hi' },
    })
    expect(findPermissionRequests(events).length).toBe(0)
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  it('Zone NEVER (sensitive path): auto bypasses even the most-sensitive classifications', async () => {
    const { events } = await buildSession({
      permissionMode: 'auto',
      toolName: 'readFile',
      toolInput: { file_path: '/home/user/.ssh/id_rsa' },
    })
    // The user explicitly chose auto mode — that's their authorisation.
    // No prompt, no silent deny.
    expect(findPermissionRequests(events).length).toBe(0)
    expect(hasPolicyDenyString(events)).toBe(false)
  })

  it('Zone NEVER (catastrophic): auto bypasses even rm -rf /', async () => {
    const { events } = await buildSession({
      permissionMode: 'auto',
      toolName: 'shell_execute',
      toolInput: { command: 'rm -rf /' },
    })
    // Documented design choice (S2 note): bypass is bypass. Users
    // who want per-call confirmation on critical actions stay on
    // 'ask' mode (the default). Auto means "I trust this run".
    expect(findPermissionRequests(events).length).toBe(0)
    expect(hasPolicyDenyString(events)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Contract invariants — independent of zone
// ---------------------------------------------------------------------------

describe('S8 zone matrix — contract invariants', () => {
  it("the literal 'Permission denied by policy' is not produced anywhere in the post-redesign stack", async () => {
    // Run a diverse set of zones in ask mode where deny is most
    // likely to surface. The contract is global: that string is dead.
    const inputs = [
      { tool: 'writeFile', input: { file_path: 'foo.html', content: 'x' } },
      { tool: 'shell_execute', input: { command: 'cat > foo.html << END\n$(date)\nEND' } },
      { tool: 'shell_execute', input: { command: 'rm -rf /' } },
      { tool: 'readFile', input: { file_path: '/etc/passwd' } },
    ]
    for (const { tool, input } of inputs) {
      const { events } = await buildSession({
        permissionMode: 'ask',
        toolName: tool,
        toolInput: input,
      })
      expect(hasPolicyDenyString(events), `${tool} should not emit policy-deny string`).toBe(false)
    }
  })

  it('every permission.request carries enough metadata for the client to render a card', async () => {
    const { events } = await buildSession({
      permissionMode: 'ask',
      toolName: 'writeFile',
      toolInput: { file_path: 'foo.html', content: 'x' },
    })
    const req = findPermissionRequests(events)[0]
    expect(req).toBeDefined()
    expect(req?.toolName).toBe('writeFile')
    expect(req?.input).toEqual({ file_path: 'foo.html', content: 'x' })
    expect(req?.requestId).toBeTruthy()
    expect(typeof req?.turnIndex).toBe('number')
    // Zone metadata required for the severity badge to render correctly.
    expect(req?.zoneName).toBeTruthy()
  })
})
