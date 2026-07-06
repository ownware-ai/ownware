/**
 * Integration test — turn-boundary reconcile wiring.
 *
 * Runs against a real in-process gateway + real SQLite. Covers the
 * full "profile mutation → thread marked pending" path for the three
 * producers wired in this branch:
 *
 *   1. POST /api/v1/profiles/:id/composio — attach toolkit marks threads
 *   2. DELETE /api/v1/profiles/:id/composio/:toolkit — detach marks threads
 *   3. ConnectorStatusBus emit — composio→ready marks only threads on
 *      profiles that declare the affected connector (cross-profile
 *      isolation).
 *
 * Does NOT exercise the actual `session.addTool` call path — that lives
 * in `reconcileSessionTools` and is covered by the unit suite. Here we
 * care about the wiring: when producer X fires, tracker Y is marked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import { initialManagedTools } from '../../../src/profile/reconcile.js'

const COMPOSIO_PROFILE = {
  name: 'composio-test',
  description: 'Profile with a composio toolkit declared',
  model: 'anthropic:claude-sonnet-4-20250514',
  tools: {
    preset: 'none' as const,
    composio: { toolkits: ['gmail'] },
  },
}

const UNRELATED_PROFILE = {
  name: 'unrelated',
  description: 'Profile that declares no composio toolkits',
  model: 'anthropic:claude-sonnet-4-20250514',
  tools: { preset: 'none' as const },
}

describe('Reconcile lifecycle — producer wiring', () => {
  let gw: TestGateway

  beforeEach(async () => {
    gw = await createTestGateway({
      profiles: [COMPOSIO_PROFILE, UNRELATED_PROFILE],
    })
  })

  afterEach(async () => {
    await gw.stop()
  })

  it('POST /profiles/:id/composio marks every thread on that profile', async () => {
    // Create two threads on the composio-test profile.
    const t1 = gw.state.createThread('composio-test')
    const t2 = gw.state.createThread('composio-test')
    // Seed initial managed snapshots so the status-bus path (which
    // skips threads with no snapshot) would still be exercised if
    // triggered. Attach-path does not gate on snapshots, but we seed
    // both for realism.
    gw.gateway.pendingReconciles.setManaged(t1.id, initialManagedTools([]))
    gw.gateway.pendingReconciles.setManaged(t2.id, initialManagedTools([]))

    expect(gw.gateway.pendingReconciles.isPending(t1.id)).toBe(false)
    expect(gw.gateway.pendingReconciles.isPending(t2.id)).toBe(false)

    const res = await gw.client.post('/api/v1/profiles/composio-test/composio', {
      toolkit: 'slack',
    })
    expect(res.status).toBe(200)

    expect(gw.gateway.pendingReconciles.isPending(t1.id)).toBe(true)
    expect(gw.gateway.pendingReconciles.isPending(t2.id)).toBe(true)
  })

  it('POST with already-declared toolkit is a no-op and does NOT mark', async () => {
    // gmail is already declared in COMPOSIO_PROFILE.tools.composio.toolkits.
    const t1 = gw.state.createThread('composio-test')
    gw.gateway.pendingReconciles.setManaged(t1.id, initialManagedTools([]))

    const res = await gw.client.post('/api/v1/profiles/composio-test/composio', {
      toolkit: 'gmail',
    })
    expect(res.status).toBe(200)
    expect((res.body as { added: boolean }).added).toBe(false)
    // No disk write, no mark.
    expect(gw.gateway.pendingReconciles.isPending(t1.id)).toBe(false)
  })

  it('DELETE /profiles/:id/composio/:toolkit marks every thread on the profile', async () => {
    const t1 = gw.state.createThread('composio-test')
    gw.gateway.pendingReconciles.setManaged(t1.id, initialManagedTools([]))

    const res = await gw.client.delete('/api/v1/profiles/composio-test/composio/gmail')
    expect(res.status).toBe(204)
    expect(gw.gateway.pendingReconciles.isPending(t1.id)).toBe(true)
  })

  it('DELETE of a non-existent toolkit returns 404 and does NOT mark', async () => {
    const t1 = gw.state.createThread('composio-test')
    gw.gateway.pendingReconciles.setManaged(t1.id, initialManagedTools([]))

    const res = await gw.client.delete(
      '/api/v1/profiles/composio-test/composio/bogus-slug',
    )
    expect(res.status).toBe(404)
    expect(gw.gateway.pendingReconciles.isPending(t1.id)).toBe(false)
  })

  it('ConnectorStatusBus emit marks ONLY threads whose profile declares the connector', async () => {
    const matching = gw.state.createThread('composio-test')
    const unrelated = gw.state.createThread('unrelated')
    gw.gateway.pendingReconciles.setManaged(matching.id, initialManagedTools([]))
    gw.gateway.pendingReconciles.setManaged(unrelated.id, initialManagedTools([]))

    await gw.gateway.registry.get('composio-test')
    await gw.gateway.registry.get('unrelated')

    // Sanity probe: the cached profile should declare gmail.
    const cached = gw.gateway.registry.getCached('composio-test')
    expect(cached).not.toBeNull()
    const declared = (
      (cached?.config as unknown as { tools?: { composio?: { toolkits?: string[] } } })
        .tools?.composio?.toolkits
    ) ?? []
    expect(declared).toContain('gmail')

    gw.gateway.connectorStatusBus.emit({
      connectorId: 'gmail',
      source: 'composio',
      status: 'ready',
      previousStatus: 'needs_setup',
    })

    expect(gw.gateway.pendingReconciles.isPending(matching.id)).toBe(true)
    expect(gw.gateway.pendingReconciles.isPending(unrelated.id)).toBe(false)
  })

  it('ConnectorStatusBus emit does NOT mark a thread that has no initial managed snapshot', async () => {
    // Threads with no snapshot mean "no session ever born" — marking
    // them would surface a stale flag that never gets consumed.
    // Scoping the subscriber on snapshot presence keeps the tracker
    // tidy.
    const thread = gw.state.createThread('composio-test')
    await gw.gateway.registry.get('composio-test')
    // NOTE: no setManaged call — this thread has never born a session.

    gw.gateway.connectorStatusBus.emit({
      connectorId: 'gmail',
      source: 'composio',
      status: 'ready',
      previousStatus: 'needs_setup',
    })

    expect(gw.gateway.pendingReconciles.isPending(thread.id)).toBe(false)
  })

  it('consume is edge-triggered — a second consume after one POST returns false', async () => {
    const t = gw.state.createThread('composio-test')
    gw.gateway.pendingReconciles.setManaged(t.id, initialManagedTools([]))

    await gw.client.post('/api/v1/profiles/composio-test/composio', {
      toolkit: 'notion',
    })

    expect(gw.gateway.pendingReconciles.consume(t.id)).toBe(true)
    expect(gw.gateway.pendingReconciles.consume(t.id)).toBe(false)
  })
})
