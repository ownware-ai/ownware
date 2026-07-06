/**
 * Integration test — Phase 2 happy path for session-scope folder grants.
 *
 * Covers the slice that the validation-only test (resume-folder-grant)
 * couldn't reach without a fully-wired runtime:
 *
 *   1. POST /threads/:id/resume action=allow_folder_session
 *      - WITH a pending HITL → pushes the canonical path into
 *        `companions.sessionAdditionalRoots`, resolves HITL true.
 *      - With duplicate path → idempotent (no double-entry).
 *
 *   2. GET /threads/:id/workspace-roots
 *      - Returns the active grants.
 *      - Returns [] when no companions exist for the thread.
 *      - 404 for unknown thread id.
 *
 *   3. DELETE /threads/:id/workspace-roots
 *      - 400 when `path` is missing or empty.
 *      - 404 for unknown thread id.
 *      - Removes the matching path; subsequent GET shows it gone.
 *      - Idempotent (`removed: 0`) when the path wasn't granted.
 *
 * The test bypasses the full agent loop by injecting minimal companion
 * + runtime stubs directly via `gw.state`. This is safe because the
 * three endpoints under test only touch `companions.sessionAdditional-
 * Roots` and `runtime.hitl` — none of the heavier machinery (zone
 * manager, credential vault, session) is on the hot path.
 *
 * The shared-array contract (mutating one place is visible everywhere)
 * is proved at the engine layer in
 * `packages/loom/src/tools/builtins/__tests__/filesystem.test.ts`
 * ("session-grant mutation"). This file pins the gateway HTTP surface.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { HumanInTheLoop } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

beforeEach(() => {
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
})

describe('Phase 2 — workspace-roots happy path', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  /**
   * Build a stand-in SessionCompanions with just enough surface for the
   * resume + list + revoke endpoints to function. credentialHITL +
   * credentialRuntime are only touched on thread deletion (via
   * try/catch best-effort), so no-op stubs are sufficient.
   */
  function attachStubCompanions(threadId: string, sessionAdditionalRoots: string[]): {
    hitl: HumanInTheLoop
  } {
    const hitl = new HumanInTheLoop({ timeoutMs: 10_000 })
    // Minimal handler — required so requestApproval() doesn't auto-deny.
    hitl.onApprovalNeeded(() => {})
    const companions = {
      hitl,
      zoneManager: null,
      getLastZoneDecision: () => undefined,
      credentialHITL: { dispose: () => {} } as never,
      credentialRuntime: { cleanup: async () => {} } as never,
      smallFastModel: null,
      hitls: [],
      sessionAdditionalRoots,
    }
    gw.state.setSessionCompanions(threadId, companions as never)
    gw.state.setRuntime(threadId, {
      session: {} as never,
      hitl,
      zoneManager: null,
      lastZoneDecision: () => undefined,
    } as never)
    return { hitl }
  }

  describe('POST /threads/:id/resume — allow_folder_session (happy path)', () => {
    it('pushes the canonical path into sessionAdditionalRoots and resolves the HITL', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const sessionAdditionalRoots: string[] = []
      const { hitl } = attachStubCompanions(threadId, sessionAdditionalRoots)

      // Park a pending approval — the resume endpoint reads runtime.hitl
      // and demands pendingCount > 0 before accepting any action.
      const pending = hitl.requestApproval(
        { id: 'req-grant-1', name: 'read_file', input: { file_path: '/tmp/grant-flow/note.md' } },
        'Reading outside workspace',
      )

      const r = await gw.client.post(`/api/v1/threads/${threadId}/resume`, {
        action: 'allow_folder_session',
        requestId: 'req-grant-1',
        grantPath: '/tmp/grant-flow',
      })

      expect(r.status).toBe(200)
      // The HITL should resolve true so the awaiting tool proceeds.
      await expect(pending).resolves.toBe(true)
      // The path we POSTed must appear in the shared array (canonical
      // form, since /tmp on macOS realpaths to /private/tmp — accept either).
      expect(sessionAdditionalRoots.length).toBe(1)
      expect(['/tmp/grant-flow', '/private/tmp/grant-flow']).toContain(sessionAdditionalRoots[0])
    })

    it('dedupes: granting the same path twice in a row leaves the array length at 1', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const sessionAdditionalRoots: string[] = []
      const { hitl } = attachStubCompanions(threadId, sessionAdditionalRoots)

      // First grant
      hitl.onApprovalNeeded(() => {})
      const p1 = hitl.requestApproval({ id: 'rq-A', name: 'read_file', input: {} }, 'r1')
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, {
        action: 'allow_folder_session',
        requestId: 'rq-A',
        grantPath: '/tmp/dedupe-target',
      })
      await p1

      // Second grant (same path) — must NOT add a duplicate entry.
      const p2 = hitl.requestApproval({ id: 'rq-B', name: 'read_file', input: {} }, 'r2')
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, {
        action: 'allow_folder_session',
        requestId: 'rq-B',
        grantPath: '/tmp/dedupe-target',
      })
      await p2

      expect(sessionAdditionalRoots.length).toBe(1)
    })
  })

  describe('GET /threads/:id/workspace-roots', () => {
    it('returns 404 for an unknown thread', async () => {
      const r = await gw.client.get('/api/v1/threads/thread_unknown/workspace-roots')
      expect(r.status).toBe(404)
    })

    it('returns an empty list when companions are not yet set on a known thread', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const r = await gw.client.get(`/api/v1/threads/${threadId}/workspace-roots`)
      expect(r.status).toBe(200)
      const body = r.body as { items: unknown[]; total: number }
      expect(body.total).toBe(0)
      expect(body.items).toEqual([])
    })

    it('returns the active grants from companions.sessionAdditionalRoots', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const sessionAdditionalRoots = ['/tmp/list-a', '/tmp/list-b']
      attachStubCompanions(threadId, sessionAdditionalRoots)

      const r = await gw.client.get(`/api/v1/threads/${threadId}/workspace-roots`)
      expect(r.status).toBe(200)
      const body = r.body as { items: { path: string }[]; total: number }
      expect(body.total).toBe(2)
      expect(body.items.map(i => i.path)).toEqual(['/tmp/list-a', '/tmp/list-b'])
    })
  })

  describe('DELETE /threads/:id/workspace-roots', () => {
    it('returns 400 when path is missing', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const r = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, {})
      expect(r.status).toBe(400)
    })

    it('returns 400 when path is an empty string', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const r = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, { path: '' })
      expect(r.status).toBe(400)
    })

    it('returns 404 for an unknown thread', async () => {
      const r = await gw.client.del('/api/v1/threads/thread_nope/workspace-roots', { path: '/tmp/x' })
      expect(r.status).toBe(404)
    })

    it('removes the matching path; subsequent GET reflects the deletion', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const sessionAdditionalRoots = ['/tmp/del-a', '/tmp/del-b', '/tmp/del-c']
      attachStubCompanions(threadId, sessionAdditionalRoots)

      const del = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, { path: '/tmp/del-b' })
      expect(del.status).toBe(200)
      const delBody = del.body as { removed: number }
      expect(delBody.removed).toBe(1)

      const list = await gw.client.get(`/api/v1/threads/${threadId}/workspace-roots`)
      const listBody = list.body as { items: { path: string }[] }
      expect(listBody.items.map(i => i.path)).toEqual(['/tmp/del-a', '/tmp/del-c'])
    })

    it('is idempotent: deleting an un-granted path returns removed: 0 with status 200', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const sessionAdditionalRoots = ['/tmp/only-this']
      attachStubCompanions(threadId, sessionAdditionalRoots)

      const r = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, { path: '/tmp/never-granted' })
      expect(r.status).toBe(200)
      const body = r.body as { removed: number }
      expect(body.removed).toBe(0)
      // The originally-granted path stays intact.
      expect(sessionAdditionalRoots).toEqual(['/tmp/only-this'])
    })

    it('returns removed: 0 with status 200 when companions are missing (no active runtime)', async () => {
      const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
      const threadId = (create.body as { id: string }).id

      const r = await gw.client.del(`/api/v1/threads/${threadId}/workspace-roots`, { path: '/tmp/anything' })
      expect(r.status).toBe(200)
      const body = r.body as { removed: number }
      expect(body.removed).toBe(0)
    })
  })
})
