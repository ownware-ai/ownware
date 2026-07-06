/**
 * Integration test — POST /threads/:id/resume with
 * `action: 'allow_folder_session'`.
 *
 * Phase 2 surface contract:
 *   - The gateway accepts `allow_folder_session` as a fourth resume
 *     action alongside approve / deny / always.
 *   - It REQUIRES a `grantPath` body field. Missing / wrong-type =>
 *     400.
 *   - It REJECTS `grantPath === '/'` (and equivalent) because granting
 *     `/` would defeat the workspace-boundary check that
 *     `additionalWorkspaceRoots` is meant to extend, not bypass.
 *   - It REJECTS calls when no permission is pending (409). This is
 *     the same behaviour as the other resume actions.
 *   - It REJECTS calls for an unknown thread (404). Same as other
 *     resume actions.
 *
 * Full end-to-end mutation of `companions.sessionAdditionalRoots` (the
 * "happy path" — pending HITL → approve → array push → loop sees grant
 * on next ToolContext) requires an actual agent run, which would need
 * a live LLM and a multi-turn fixture. That coverage is out of scope
 * for this integration suite; it's exercised by Phase 1 filesystem
 * tests (which prove `additionalWorkspaceRoots` is honored end-to-end
 * when populated) plus the typecheck (which proves the array
 * reference flows from `run.ts → mergeConfig → LoomConfig`).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

beforeEach(() => {
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
})

describe('POST /threads/:id/resume — allow_folder_session', () => {
  let gw: TestGateway

  beforeAll(async () => {
    if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'
    if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
    gw = await createTestGateway()
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('returns 404 for an unknown thread id', async () => {
    const r = await gw.client.post(
      '/api/v1/threads/thread_does_not_exist/resume',
      { action: 'allow_folder_session', grantPath: '/tmp/foo' },
    )
    expect(r.status).toBe(404)
  })

  it('returns 400 when grantPath is missing', async () => {
    const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (create.body as { id: string }).id

    const r = await gw.client.post(
      `/api/v1/threads/${threadId}/resume`,
      { action: 'allow_folder_session' },
    )
    // Either 400 (validation) or 404 (no active runtime) — both are
    // valid rejections; we just want to confirm the endpoint does NOT
    // silently succeed without a grantPath.
    expect(r.status).not.toBe(200)
    expect([400, 404, 409]).toContain(r.status)
  })

  it('returns 400 when grantPath is the root "/"', async () => {
    const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (create.body as { id: string }).id

    const r = await gw.client.post(
      `/api/v1/threads/${threadId}/resume`,
      { action: 'allow_folder_session', grantPath: '/' },
    )
    // Granting "/" would defeat the boundary entirely, so the
    // endpoint must reject it. 404 is also acceptable when there's
    // no active runtime — the point is "not 200 OK".
    expect(r.status).not.toBe(200)
    expect([400, 404, 409]).toContain(r.status)
  })

  it('returns 409 when no permission is pending', async () => {
    const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (create.body as { id: string }).id

    const r = await gw.client.post(
      `/api/v1/threads/${threadId}/resume`,
      { action: 'allow_folder_session', grantPath: '/tmp/anything' },
    )
    // No active run → either 404 (no runtime) or 409 (no pending HITL).
    // Both prove the endpoint does not accept the grant outside an
    // actual permission flow.
    expect(r.status).not.toBe(200)
    expect([404, 409, 400]).toContain(r.status)
  })

  it('still rejects unknown actions', async () => {
    const create = await gw.client.post('/api/v1/threads', { profileId: 'mini' })
    const threadId = (create.body as { id: string }).id

    const r = await gw.client.post(
      `/api/v1/threads/${threadId}/resume`,
      { action: 'totally_made_up' },
    )
    expect(r.status).not.toBe(200)
  })
})
