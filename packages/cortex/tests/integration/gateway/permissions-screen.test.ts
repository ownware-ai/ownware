/**
 * Integration tests — endpoints powering the Settings → Permissions
 * (v2) screen. Validates the four new surfaces the screen depends on:
 *
 *   GET    /api/v1/threads/:threadId/workspace-roots
 *   DELETE /api/v1/threads/:threadId/workspace-roots
 *   GET    /api/v1/permissions/rules
 *   GET    /api/v1/profiles/:profileId/zones
 *
 * Each test verifies a single contract: status code + response shape.
 * The full grant lifecycle (pending HITL → allow_folder_session →
 * companions.sessionAdditionalRoots populated → list endpoint reflects
 * it) requires a live agent run and is out of scope here; the array
 * mutation has its own typecheck-level guarantees and is exercised by
 * the existing resume-folder-grant.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import { ZoneManager, ZONE_CONFIGS, ZoneLevel } from '@ownware/loom'

beforeEach(() => {
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
})

describe('GET /threads/:threadId/workspace-roots', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns 404 for an unknown thread', async () => {
    const r = await gw.client.get('/api/v1/threads/thread_does_not_exist/workspace-roots')
    expect(r.status).toBe(404)
  })

  it('returns 200 + empty list for a thread with no active runtime', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    const r = await gw.client.get<{ items: unknown[]; total: number; threadId: string; workspaceId: string | null }>(
      `/api/v1/threads/${threadId}/workspace-roots`,
    )
    expect(r.status).toBe(200)
    expect(r.body.threadId).toBe(threadId)
    expect(Array.isArray(r.body.items)).toBe(true)
    expect(r.body.items.length).toBe(0)
    expect(r.body.total).toBe(0)
  })

  it('reflects grants pushed onto companions.sessionAdditionalRoots', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    // Inject a fake companions slot directly so the endpoint has
    // something to read — this avoids needing a live agent run.
    const grants = ['/tmp/foo', '/tmp/bar']
    gw.state.setSessionCompanions(threadId, {
      hitl: null as never,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL: null as never,
      credentialRuntime: null as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots: grants,
    })

    const r = await gw.client.get<{ items: { path: string }[]; total: number }>(
      `/api/v1/threads/${threadId}/workspace-roots`,
    )
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(2)
    expect(r.body.items.map(x => x.path)).toEqual(['/tmp/foo', '/tmp/bar'])
  })
})

describe('DELETE /threads/:threadId/workspace-roots', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns 404 for an unknown thread', async () => {
    const r = await gw.client.del(
      '/api/v1/threads/thread_does_not_exist/workspace-roots',
      { path: '/tmp/foo' },
    )
    expect(r.status).toBe(404)
  })

  it('returns 400 when path is missing', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    const r = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, {})
    expect(r.status).toBe(400)
  })

  it('returns 200 with removed=0 when there is no active runtime (idempotent)', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    const r = await gw.client.del<{ removed: number }>(
      `/api/v1/threads/${threadId}/workspace-roots`,
      { path: '/tmp/foo' },
    )
    expect(r.status).toBe(200)
    expect(r.body.removed).toBe(0)
  })

  it('removes a matching grant in place', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    const grants = ['/tmp/keep', '/tmp/drop']
    gw.state.setSessionCompanions(threadId, {
      hitl: null as never,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL: null as never,
      credentialRuntime: null as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots: grants,
    })

    const r = await gw.client.del<{ removed: number }>(
      `/api/v1/threads/${threadId}/workspace-roots`,
      { path: '/tmp/drop' },
    )
    expect(r.status).toBe(200)
    expect(r.body.removed).toBe(1)
    // Same array reference — caller's `grants` should be mutated.
    expect(grants).toEqual(['/tmp/keep'])
  })

  it('returns 0 when revoking a non-existent path (idempotent)', async () => {
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    gw.state.setSessionCompanions(threadId, {
      hitl: null as never,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL: null as never,
      credentialRuntime: null as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots: ['/tmp/keep'],
    })

    const r = await gw.client.del<{ removed: number }>(
      `/api/v1/threads/${threadId}/workspace-roots`,
      { path: '/tmp/never-was-here' },
    )
    expect(r.status).toBe(200)
    expect(r.body.removed).toBe(0)
  })
})

describe('GET /permissions/rules', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns 200 with an items array (empty or populated)', async () => {
    const r = await gw.client.get<{ items: unknown[]; total: number }>('/api/v1/permissions/rules')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.items)).toBe(true)
    expect(typeof r.body.total).toBe('number')
    expect(r.body.total).toBe(r.body.items.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/permissions/rules — S6 (2026-05-14 permission redesign)
//
// The canonical wire-side write path for revoking saved "Always allow"
// rules from `~/.ownware/permissions/<profileId>.json`. The client's
// Settings → Permissions Rules tab calls this; no other writer.
// Idempotent — missing rule returns `{ removed: 0 }`, not 404.
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /permissions/rules', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns 400 when profileId is missing', async () => {
    const r = await gw.client.del<{ error: string }>('/api/v1/permissions/rules', {
      toolPattern: 'writeFile',
    })
    expect(r.status).toBe(400)
  })

  it('returns 400 when toolPattern is missing', async () => {
    const r = await gw.client.del<{ error: string }>('/api/v1/permissions/rules', {
      profileId: 'mini',
    })
    expect(r.status).toBe(400)
  })

  it('returns 200 with removed=0 when revoking a rule that does not exist (idempotent)', async () => {
    const r = await gw.client.del<{ removed: number }>('/api/v1/permissions/rules', {
      profileId: 'mini',
      toolPattern: 'never-was-saved-here',
    })
    expect(r.status).toBe(200)
    expect(r.body.removed).toBe(0)
  })

  // BUG #8 — disk revoke must poke every live ZoneManager whose thread
  // belongs to this profile. Without the poke, a saved "Always allow"
  // rule revoked on disk leaves the in-memory expansion (pre-populated
  // at session start) alive until the session ends — the agent keeps
  // auto-allowing after the user thinks they revoked the grant.
  it('revokes the matching expansion on every live ZoneManager for the profile', async () => {
    // Create a thread on 'mini' and inject a real ZoneManager that
    // has a session-wide expansion granted for 'shell_execute' (the
    // shape the assembler creates when a saved rule existed at start).
    const c = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (c.body as { id: string }).id

    const zm = new ZoneManager(ZONE_CONFIGS.standard)
    zm.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')

    // Pre-condition: the expansion upgrades 'ask' to 'allow'.
    expect(
      zm.evaluate({ toolName: 'shell_execute', input: { command: 'npm test' }, sessionId: 't' }).decision,
    ).toBe('allow')

    gw.state.setSessionCompanions(threadId, {
      hitl: null as never,
      zoneManager: zm,
      getLastZoneDecision: () => null,
      credentialHITL: null as never,
      credentialRuntime: null as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots: [],
    })

    const r = await gw.client.del<{ removed: number }>('/api/v1/permissions/rules', {
      profileId: 'mini',
      toolPattern: 'shell_execute',
    })
    expect(r.status).toBe(200)

    // The live ZoneManager must now ask again — the in-memory
    // expansion was poked.
    expect(
      zm.evaluate({ toolName: 'shell_execute', input: { command: 'npm test' }, sessionId: 't' }).decision,
    ).toBe('ask')
    expect(zm.getExpansions()).toHaveLength(0)
  })

  it('leaves ZoneManagers belonging to a different profile alone', async () => {
    // Two threads on two different profiles. Revoking on profile A
    // must not touch profile B's live expansion.
    const a = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadIdA = (a.body as { id: string }).id
    const b = await gw.client.post('/api/v1/threads', { profileId: 'default' })
    const threadIdB = (b.body as { id: string }).id

    const zmA = new ZoneManager(ZONE_CONFIGS.standard)
    zmA.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')
    const zmB = new ZoneManager(ZONE_CONFIGS.standard)
    zmB.grantExpansion('shell_execute', ZoneLevel.BUILD, 'session')

    const baseCompanions = {
      hitl: null as never,
      getLastZoneDecision: () => null,
      credentialHITL: null as never,
      credentialRuntime: null as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots: [],
    }
    gw.state.setSessionCompanions(threadIdA, { ...baseCompanions, zoneManager: zmA })
    gw.state.setSessionCompanions(threadIdB, { ...baseCompanions, zoneManager: zmB })

    const r = await gw.client.del<{ removed: number }>('/api/v1/permissions/rules', {
      profileId: 'mini',
      toolPattern: 'shell_execute',
    })
    expect(r.status).toBe(200)

    expect(zmA.getExpansions()).toHaveLength(0)
    expect(zmB.getExpansions()).toHaveLength(1) // untouched
  })
})

describe('GET /profiles/:profileId/zones', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns 404 for an unknown profile', async () => {
    const r = await gw.client.get('/api/v1/profiles/totally_not_a_profile/zones')
    expect(r.status).toBe(404)
  })

  it('returns 200 with the zones config shape for a real profile', async () => {
    const r = await gw.client.get<{
      profileId: string
      enabled: boolean
      securityLevel: string
      maxAutoZone: string | null
      maxAskZone: string | null
      overrides: unknown[]
    }>('/api/v1/profiles/mini/zones')
    expect(r.status).toBe(200)
    expect(r.body.profileId).toBe('mini')
    expect(typeof r.body.enabled).toBe('boolean')
    expect(['permissive', 'standard', 'strict', 'paranoid']).toContain(r.body.securityLevel)
    expect(Array.isArray(r.body.overrides)).toBe(true)
  })
})

describe('GET /profiles/zones (batch)', () => {
  let gw: TestGateway
  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)
  afterAll(async () => { await gw.stop() })

  it('returns every profile\'s zones in one response, not a per-id 404', async () => {
    // Guards route ordering: `/profiles/zones` must resolve to the batch
    // handler, NOT be captured as `/profiles/:profileId` with id="zones"
    // (which would 404). One call replaces the old N+1 per-card fetch.
    const r = await gw.client.get<{
      zones: ReadonlyArray<{
        profileId: string
        enabled: boolean
        securityLevel: string
        maxAutoZone: string | null
        maxAskZone: string | null
        overrides: unknown[]
      }>
    }>('/api/v1/profiles/zones')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.zones)).toBe(true)
    const mini = r.body.zones.find(z => z.profileId === 'mini')
    expect(mini).toBeDefined()
    expect(typeof mini!.enabled).toBe('boolean')
    expect(['permissive', 'standard', 'strict', 'paranoid']).toContain(mini!.securityLevel)
    expect(Array.isArray(mini!.overrides)).toBe(true)
  })
})
