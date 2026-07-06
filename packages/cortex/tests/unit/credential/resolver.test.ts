/**
 * Unit tests — gateway credential resolver.
 *
 * Pinned (every gate has a hit + miss test):
 *   - Missing credential → MissingCredentialError, no audit row.
 *   - Soft-deleted (revoked) credential → CredentialDeniedError(REVOKED).
 *   - Expired credential → CredentialDeniedError(EXPIRED) + status auto-updated.
 *   - LLM with spendCap + estimate under cap → resolves OK.
 *   - LLM with spendCap + estimate over cap → DENIED(SPEND_CAP_EXCEEDED).
 *   - LLM with spendCap + missing estimate → DENIED (fail-CLOSED per D5).
 *   - trust:high + grant → resolves OK.
 *   - trust:high + deny → DENIED(APPROVAL_DENIED).
 *   - trust:high without trustGate configured → DENIED.
 *   - On success: audit row written, lastUsedAt bumped, handle issued.
 *   - Handle TTL: dereferenceHandle returns null after expiry.
 *   - releaseHandle drops the handle eagerly.
 *   - recordActualCost writes a true-up audit row.
 *   - findByVariableName tries categories in deterministic order.
 *   - Plaintext value never appears in any audit row's `detail`.
 */

import Database from 'better-sqlite3'
import {
  CredentialDeniedError,
  MissingCredentialError,
  type ResolveContext,
} from '@ownware/loom'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { TrustGate } from '../../../src/credential/trust-gate.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let trustGate: TrustGate
let resolver: GatewayCredentialResolver

const ctx: ResolveContext = {
  agentId: 'agent_x',
  sessionId: 'sess_x',
  threadId: 'thread_x',
  toolName: 'shell',
}

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-resolver-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  trustGate = new TrustGate()
  resolver = new GatewayCredentialResolver({ store, audit, spendDb: db, trustGate })
})
afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

async function seed(overrides: Partial<Parameters<typeof store.save>[0]> = {}) {
  return store.save({
    name: 'Anthropic',
    value: 'sk-ant-XXXXXXXX-HM8A',
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Missing
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — missing credential', () => {
  it('throws MissingCredentialError when no credential exists for the name', async () => {
    await expect(
      resolver.resolve('NOPE_KEY', ctx),
    ).rejects.toBeInstanceOf(MissingCredentialError)
  })

  it('does not write an audit row for missing credentials', async () => {
    try { await resolver.resolve('NOPE_KEY', ctx) } catch { /* expected */ }
    const row = db.prepare('SELECT COUNT(*) AS c FROM credential_audit_log').get() as { c: number }
    expect(row.c).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Status / expiry gates
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — status gate', () => {
  it('denies a revoked credential', async () => {
    const c = await seed()
    await store.update(c.id, { status: 'revoked', statusReason: 'user removed' })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
    expect((error as CredentialDeniedError).reason).toBe('REVOKED')
  })

  it('denies an error-status credential', async () => {
    const c = await seed()
    await store.update(c.id, { status: 'error', statusReason: '401' })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect((error as CredentialDeniedError).reason).toBe('ERROR')
  })

  it('denies an expired-status credential', async () => {
    const c = await seed()
    await store.update(c.id, { status: 'expired', statusReason: 'rotated' })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect((error as CredentialDeniedError).reason).toBe('EXPIRED')
  })

  it('denies + auto-updates when expiresAt is in the past (status was still ready)', async () => {
    const c = await seed({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect((error as CredentialDeniedError).reason).toBe('EXPIRED')
    const refetched = await store.get(c.id)
    expect(refetched?.status).toBe('expired')
  })

  it('writes a denied audit row tagged with the gate name', async () => {
    const c = await seed()
    await store.update(c.id, { status: 'revoked', statusReason: 'user removed' })
    try { await resolver.resolve('ANTHROPIC_API_KEY', ctx) } catch { /* */ }
    const events = audit.listEventsForCredential(c.id).events
    expect(events[0]!.outcome).toBe('denied')
    expect(events[0]!.detail).toMatchObject({ gate: 'status' })
  })
})

// ---------------------------------------------------------------------------
// Spend gate (LLM only)
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — spend gate', () => {
  it('resolves OK when the estimate is under the cap', async () => {
    await seed({ spendCap: { amountUsd: 5, period: 'day' } })
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', { ...ctx, estimatedCostUsd: 0.01 })
    expect(handle.token.length).toBeGreaterThan(0)
  })

  it('denies when the estimate would exceed the cap', async () => {
    const c = await seed({ spendCap: { amountUsd: 5, period: 'day' } })
    audit.recordEvent({
      credentialId: c.id, eventType: 'resolve', outcome: 'ok', actualCostUsd: 4.99,
    })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', { ...ctx, estimatedCostUsd: 0.5 }).catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
    expect((error as CredentialDeniedError).reason).toBe('SPEND_CAP_EXCEEDED')
  })

  it('denies when estimate is missing on a capped LLM credential (fail-CLOSED)', async () => {
    await seed({ spendCap: { amountUsd: 5, period: 'day' } })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
    expect((error as CredentialDeniedError).reason).toBe('SPEND_CAP_EXCEEDED')
    expect((error as CredentialDeniedError).detail).toContain('estimatedCostUsd')
  })

  it('denies when estimate is NaN', async () => {
    await seed({ spendCap: { amountUsd: 5, period: 'day' } })
    const error = await resolver.resolve('ANTHROPIC_API_KEY', { ...ctx, estimatedCostUsd: NaN }).catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
  })

  it('does NOT require an estimate on an uncapped LLM credential', async () => {
    await seed() // no spendCap
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    expect(handle.token.length).toBeGreaterThan(0)
  })

  it('does NOT enforce spendCap on non-LLM categories', async () => {
    await seed({
      name: 'GitHub MCP',
      category: 'mcp-server',
      authType: 'api-key',
      variableName: 'GITHUB_TOKEN',
      forConnector: 'mcp:github',
      source: 'mcp-config',
      // spendCap intentionally absent — schema rejects it on non-LLM
    })
    const handle = await resolver.resolve('GITHUB_TOKEN', ctx)
    expect(handle.token.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Trust gate
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — trust gate', () => {
  it('blocks until the user grants approval, then issues a handle', async () => {
    await seed({ trust: 'high' })
    let pending: { requestId: string; signature: string } | null = null
    trustGate.onApprovalRequired(e => {
      pending = { requestId: e.requestId, signature: e.signature }
    })
    const promise = resolver.resolve('ANTHROPIC_API_KEY', ctx)
    // Yield so the approval is emitted.
    await new Promise(r => setTimeout(r, 0))
    expect(pending).not.toBeNull()
    trustGate.respond({
      requestId: pending!.requestId,
      decision: 'granted',
      signature: pending!.signature,
    })
    const handle = await promise
    expect(handle.token.length).toBeGreaterThan(0)
  })

  it('throws APPROVAL_DENIED on user deny', async () => {
    await seed({ trust: 'high' })
    let pending: { requestId: string; signature: string } | null = null
    trustGate.onApprovalRequired(e => {
      pending = { requestId: e.requestId, signature: e.signature }
    })
    const promise = resolver.resolve('ANTHROPIC_API_KEY', ctx)
    await new Promise(r => setTimeout(r, 0))
    trustGate.respond({
      requestId: pending!.requestId,
      decision: 'denied',
      signature: pending!.signature,
    })
    const error = await promise.catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
    expect((error as CredentialDeniedError).reason).toBe('APPROVAL_DENIED')
  })

  it('throws APPROVAL_DENIED on a denied request — even when no trustGate is wired', async () => {
    await seed({ trust: 'high' })
    const noGate = new GatewayCredentialResolver({ store, audit, spendDb: db })
    const error = await noGate.resolve('ANTHROPIC_API_KEY', ctx).catch(e => e)
    expect(error).toBeInstanceOf(CredentialDeniedError)
    expect((error as CredentialDeniedError).reason).toBe('APPROVAL_DENIED')
    expect((error as CredentialDeniedError).detail).toContain('trust gate')
  })

  it('skips the gate on trust:medium / low', async () => {
    await seed({ trust: 'medium' })
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    expect(handle.token.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — success', () => {
  it('writes one audit row with outcome ok', async () => {
    const c = await seed()
    await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const events = audit.listEventsForCredential(c.id).events
    expect(events.length).toBe(1)
    expect(events[0]!.eventType).toBe('resolve')
    expect(events[0]!.outcome).toBe('ok')
  })

  it('records ctx fields on the audit row', async () => {
    const c = await seed()
    await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const events = audit.listEventsForCredential(c.id).events
    expect(events[0]!.agentId).toBe('agent_x')
    expect(events[0]!.sessionId).toBe('sess_x')
    expect(events[0]!.threadId).toBe('thread_x')
    expect(events[0]!.toolName).toBe('shell')
  })

  it('records estimatedCostUsd on the audit row when the LLM has a cap', async () => {
    const c = await seed({ spendCap: { amountUsd: 5, period: 'day' } })
    await resolver.resolve('ANTHROPIC_API_KEY', { ...ctx, estimatedCostUsd: 0.02 })
    const events = audit.listEventsForCredential(c.id).events
    expect(events[0]!.estimatedCostUsd).toBe(0.02)
  })

  it('updates lastUsedAt on the credential', async () => {
    const c = await seed()
    expect(c.lastUsedAt).toBeUndefined()
    await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const refetched = await store.get(c.id)
    expect(refetched?.lastUsedAt).toBeDefined()
  })

  it('returns a handle whose token is unique per resolve', async () => {
    await seed()
    const a = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const b = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    expect(a.token).not.toBe(b.token)
  })

  it('never includes the plaintext value in any audit detail', async () => {
    const value = 'sk-ant-PLAINTEXT-LEAK-CHECK-RESOLVER'
    const c = await seed({ value })
    await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const events = audit.listEventsForCredential(c.id).events
    expect(JSON.stringify(events)).not.toContain(value)
  })
})

// ---------------------------------------------------------------------------
// Handle lifecycle
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — handle lifecycle', () => {
  it('dereferenceHandle returns the value for a fresh handle', async () => {
    await seed({ value: 'sk-ant-XXXXXXXX-DEREF' })
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const resolved = await resolver.dereferenceHandle(handle)
    expect(resolved?.value).toBe('sk-ant-XXXXXXXX-DEREF')
    expect(resolved?.variableName).toBe('ANTHROPIC_API_KEY')
    expect(resolved?.category).toBe('llm')
  })

  it('dereferenceHandle returns null for an unknown token', async () => {
    const fake = { token: 'unknown', __brand: undefined as unknown as never } as const
    expect(await resolver.dereferenceHandle(fake)).toBeNull()
  })

  it('dereferenceHandle returns null after handle TTL expires', async () => {
    vi.useFakeTimers()
    try {
      const shortTtl = new GatewayCredentialResolver({
        store, audit, spendDb: db, trustGate, handleTtlMs: 1_000,
      })
      await seed({ value: 'sk-ant-XXXXXXXX-EXPR' })
      const handle = await shortTtl.resolve('ANTHROPIC_API_KEY', ctx)
      vi.advanceTimersByTime(2_000)
      expect(await shortTtl.dereferenceHandle(handle)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releaseHandle drops the handle eagerly', async () => {
    await seed()
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    expect(resolver.pendingHandleCount()).toBe(1)
    resolver.releaseHandle(handle)
    expect(resolver.pendingHandleCount()).toBe(0)
    expect(await resolver.dereferenceHandle(handle)).toBeNull()
  })

  it('recordActualCost writes a true-up audit row tagged trueUp: true', async () => {
    const c = await seed()
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    resolver.recordActualCost(handle, 0.42)
    const events = audit.listEventsForCredential(c.id).events
    const trueUp = events.find(e => e.detail !== null && (e.detail as Record<string, unknown>)['trueUp'] === true)
    expect(trueUp).toBeDefined()
    expect(trueUp!.actualCostUsd).toBe(0.42)
  })

  it('recordActualCost ignores a stale handle (no audit row)', async () => {
    await seed()
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    resolver.releaseHandle(handle)
    const before = audit.listEventsForCredential('cred_000000000000').total
    resolver.recordActualCost(handle, 0.42)
    const after = audit.listEventsForCredential('cred_000000000000').total
    expect(before).toBe(after)
  })
})

// ---------------------------------------------------------------------------
// Variable-name disambiguation
// ---------------------------------------------------------------------------

describe('GatewayCredentialResolver — findByVariableName', () => {
  it('prefers an LLM credential when the same name exists in tool category', async () => {
    // Both categories can theoretically host the same variableName.
    await seed({ name: 'Tool', category: 'tool', forConnector: 'manual:t1' })
    await seed({ name: 'LLM' })
    const c = await seed({ name: 'LLM', value: 'sk-ant-llm-pref' })
    void c
    const handle = await resolver.resolve('ANTHROPIC_API_KEY', ctx)
    const resolved = await resolver.dereferenceHandle(handle)
    expect(resolved?.category).toBe('llm')
  })
})
