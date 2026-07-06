/**
 * Contract: Workspace pane substrate.
 *
 * Covers the 7 endpoints added by slice 1a.3:
 *
 *   GET    /api/v1/workspaces/:wsId/panes
 *   POST   /api/v1/workspaces/:wsId/panes
 *   PATCH  /api/v1/workspaces/:wsId/panes/:paneId
 *   DELETE /api/v1/workspaces/:wsId/panes/:paneId
 *   PUT    /api/v1/workspaces/:wsId/panes        (reorder)
 *   GET    /api/v1/workspaces/:wsId/layout
 *   PUT    /api/v1/workspaces/:wsId/layout
 *
 * Goes through the real gateway via the test harness — same code path
 * the client will hit. Drives every pane shape from the wire side and
 * asserts both the typed responses and the persisted state.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import type {
  WorkspacePane,
  WorkspacePaneListResponse,
  CreateWorkspacePaneResponse,
  CloseWorkspacePaneResponse,
} from '../../../src/gateway/types.js'

describe('Contract: Workspace panes', () => {
  let gw: TestGateway
  let wsId: string
  let wsId2: string
  // Each test seeds two workspaces inside the gateway's state DB —
  // panes only live under workspaces. We keep paths unique per test
  // file run via a tmp dir under OS tmp.
  let tmpRoot: string

  beforeAll(async () => {
    gw = await createTestGateway()
    tmpRoot = await mkdtemp(join(tmpdir(), 'panes-contract-'))
  })

  afterAll(async () => {
    await gw.stop()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Fresh workspaces per test so panes don't leak between cases.
    // Workspaces themselves never get cleaned up — the harness drops
    // the entire DB at gw.stop(). The unique random path name keeps
    // CREATE WORKSPACE happy (path is uniquely indexed).
    const a = await mkdtemp(join(tmpRoot, 'a-'))
    const b = await mkdtemp(join(tmpRoot, 'b-'))
    wsId = gw.state.createWorkspace(a).id
    wsId2 = gw.state.createWorkspace(b).id
  })

  // ───────────────────────────────────────────────────────────────────
  // GET /panes  +  POST /panes
  // ───────────────────────────────────────────────────────────────────

  it('GET /panes returns empty for a fresh workspace', async () => {
    const r = await gw.client.get<WorkspacePaneListResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
    )
    expect(r.status).toBe(200)
    expect(r.body.items).toEqual([])
    expect(r.body.total).toBe(0)
    expect(r.body.layout).toBeNull()
  })

  it('GET /panes returns 404 for an unknown workspace', async () => {
    const r = await gw.client.get(`/api/v1/workspaces/ws_nope/panes`)
    expect(r.status).toBe(404)
  })

  it('POST /panes creates a markdown pane and echoes placement', async () => {
    const r = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'markdown', source: { origin: 'inline', content: '# hello' } },
        title: 'README',
        zone: 'tabs',
        placement: 'split',
        metadata: { openedBy: 'agent' },
      },
    )
    expect(r.status).toBe(201)
    expect(r.body.placement).toBe('split')
    expect(r.body.pane.id).toMatch(/^pane_[0-9a-f]{12}$/)
    expect(r.body.pane.kind).toBe('markdown')
    expect(r.body.pane.title).toBe('README')
    expect(r.body.pane.zone).toBe('tabs')
    expect(r.body.pane.focused).toBe(true)
    expect(r.body.pane.metadata).toMatchObject({
      openedBy: 'agent',
      pinned: false,
      closeable: true,
    })
    expect(r.body.pane.config).toEqual({
      kind: 'markdown',
      source: { origin: 'inline', content: '# hello' },
    })
  })

  it('POST /panes fills metadata defaults when omitted', async () => {
    const r = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
      },
    )
    expect(r.status).toBe(201)
    expect(r.body.pane.metadata).toEqual({
      openedBy: 'user',
      pinned: false,
      closeable: true,
    })
  })

  it('POST /panes derives a default title from the kind when none supplied', async () => {
    const r = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'terminal' },
        zone: 'side',
      },
    )
    expect(r.status).toBe(201)
    expect(r.body.pane.title).toBe('Output')   // user-facing label per DESIGN.md §6
    expect(r.body.pane.zone).toBe('side')
    // Rip-dockview Phase F: new side panes auto-focus by default —
    // the side panel is single-slot and displays the focused pane,
    // so creating one without picking focus means "show this now".
    expect(r.body.pane.focused).toBe(true)
  })

  it('POST /panes derives default zone from kind when none supplied', async () => {
    // markdown → 'side' (rip-dockview Phase F default for non-chat).
    const r = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } } },
    )
    expect(r.status).toBe(201)
    expect(r.body.pane.zone).toBe('side')

    // chat → 'tabs' (rip-dockview Phase F default for chat).
    const c = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'chat', profileId: 'coder', threadId: 'th_zone_default' } },
    )
    expect(c.status).toBe(201)
    expect(c.body.pane.zone).toBe('tabs')
  })

  it('POST /panes is idempotent on (workspace, kind=chat, threadId)', async () => {
    const a = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'chat', profileId: 'coder', threadId: 'th_1' },
      },
    )
    const b = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        config: { kind: 'chat', profileId: 'coder', threadId: 'th_1' },
      },
    )
    expect(a.body.pane.id).toBe(b.body.pane.id)
    const list = await gw.client.get<WorkspacePaneListResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
    )
    expect(list.body.items).toHaveLength(1)
  })

  it('POST /panes returns 400 on a malformed body (strict Zod)', async () => {
    // Top-level `kind` is rejected — server derives from config.kind.
    const r = await gw.client.post(
      `/api/v1/workspaces/${wsId}/panes`,
      {
        kind: 'markdown',
        config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } },
      },
    )
    expect(r.status).toBe(400)
  })

  it('POST /panes returns 404 on an unknown workspace', async () => {
    const r = await gw.client.post(
      `/api/v1/workspaces/ws_nope/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } } },
    )
    expect(r.status).toBe(404)
  })

  // ───────────────────────────────────────────────────────────────────
  // PATCH /panes/:paneId
  // ───────────────────────────────────────────────────────────────────

  describe('PATCH /panes/:paneId', () => {
    let pane: WorkspacePane

    beforeEach(async () => {
      const r = await gw.client.post<CreateWorkspacePaneResponse>(
        `/api/v1/workspaces/${wsId}/panes`,
        {
          config: { kind: 'markdown', source: { origin: 'inline', content: 'orig' } },
          title: 'Original',
          metadata: { openedBy: 'agent' },
        },
      )
      pane = r.body.pane
    })

    it('patches title only', async () => {
      const r = await gw.client.patch<WorkspacePane>(
        `/api/v1/workspaces/${wsId}/panes/${pane.id}`,
        { title: 'Renamed' },
      )
      expect(r.status).toBe(200)
      expect(r.body.title).toBe('Renamed')
      expect(r.body.config).toEqual(pane.config)
    })

    it('merges a metadata partial onto existing metadata', async () => {
      // pane.metadata is { openedBy: 'agent', pinned: false, closeable: true }
      const r = await gw.client.patch<WorkspacePane>(
        `/api/v1/workspaces/${wsId}/panes/${pane.id}`,
        { metadata: { pinned: true, subagentId: 'sa_1' } },
      )
      expect(r.status).toBe(200)
      expect(r.body.metadata).toMatchObject({
        openedBy: 'agent',     // preserved
        pinned: true,           // overridden
        closeable: true,        // preserved
        subagentId: 'sa_1',     // added
      })
    })

    it('focused: true activates the pane (and defocuses the previous focus in the zone)', async () => {
      // Create a second pane that takes focus on creation.
      const second = await gw.client.post<CreateWorkspacePaneResponse>(
        `/api/v1/workspaces/${wsId}/panes`,
        {
          config: { kind: 'markdown', source: { origin: 'inline', content: 'b' } },
        },
      )
      // Confirm the first pane is no longer focused.
      const list1 = await gw.client.get<WorkspacePaneListResponse>(
        `/api/v1/workspaces/${wsId}/panes`,
      )
      expect(list1.body.items.find((p) => p.id === pane.id)?.focused).toBe(false)
      expect(list1.body.items.find((p) => p.id === second.body.pane.id)?.focused).toBe(true)

      // PATCH focus back to the first pane.
      const r = await gw.client.patch<WorkspacePane>(
        `/api/v1/workspaces/${wsId}/panes/${pane.id}`,
        { focused: true },
      )
      expect(r.status).toBe(200)
      expect(r.body.focused).toBe(true)
      const list2 = await gw.client.get<WorkspacePaneListResponse>(
        `/api/v1/workspaces/${wsId}/panes`,
      )
      expect(list2.body.items.find((p) => p.id === second.body.pane.id)?.focused).toBe(false)
    })

    it('focused: false is rejected by Zod (defocus only via another focus or close)', async () => {
      const r = await gw.client.patch(
        `/api/v1/workspaces/${wsId}/panes/${pane.id}`,
        { focused: false },
      )
      expect(r.status).toBe(400)
    })

    it('returns 404 for a pane that belongs to a different workspace', async () => {
      const r = await gw.client.patch(
        `/api/v1/workspaces/${wsId2}/panes/${pane.id}`,
        { title: 'x' },
      )
      expect(r.status).toBe(404)
    })

    it('returns 400 on an empty patch body', async () => {
      const r = await gw.client.patch(
        `/api/v1/workspaces/${wsId}/panes/${pane.id}`,
        {},
      )
      expect(r.status).toBe(400)
    })
  })

  // ───────────────────────────────────────────────────────────────────
  // DELETE /panes/:paneId
  // ───────────────────────────────────────────────────────────────────

  it('DELETE /panes/:paneId returns the next focused pane id', async () => {
    const a = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'a' } } },
    )
    const b = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'b' } } },
    )
    // b is focused (latest). Delete b — a should be promoted.
    const r = await gw.client.delete<CloseWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes/${b.body.pane.id}`,
    )
    expect(r.status).toBe(200)
    expect(r.body.closed).toBe(true)
    expect(r.body.nextFocusedPaneId).toBe(a.body.pane.id)

    const list = await gw.client.get<WorkspacePaneListResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
    )
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0]?.focused).toBe(true)
  })

  it('DELETE /panes/:paneId returns 404 for an unknown id', async () => {
    const r = await gw.client.delete(`/api/v1/workspaces/${wsId}/panes/pane_nope`)
    expect(r.status).toBe(404)
  })

  // ───────────────────────────────────────────────────────────────────
  // PUT /panes (reorder)
  // ───────────────────────────────────────────────────────────────────

  it('PUT /panes reorders by id sequence', async () => {
    const a = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'a' } } },
    )
    const b = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'b' } } },
    )
    const c = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'c' } } },
    )
    const r = await gw.client.put<readonly WorkspacePane[]>(
      `/api/v1/workspaces/${wsId}/panes`,
      // markdown defaults to the side zone (rip-dockview Phase F);
      // reorder validates "ids must all belong to (workspace, zone)",
      // so the zone has to match where these panes actually live.
      { zone: 'side', ids: [c.body.pane.id, a.body.pane.id, b.body.pane.id] },
    )
    expect(r.status).toBe(200)
    expect(r.body.map((p) => p.id)).toEqual([
      c.body.pane.id, a.body.pane.id, b.body.pane.id,
    ])
    expect(r.body.map((p) => p.position)).toEqual([0, 1, 2])
  })

  it('PUT /panes returns 400 when an id does not belong to the (workspace, zone)', async () => {
    const own = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'a' } } },
    )
    const alien = await gw.client.post<CreateWorkspacePaneResponse>(
      `/api/v1/workspaces/${wsId2}/panes`,
      { config: { kind: 'markdown', source: { origin: 'inline', content: 'x' } } },
    )
    const r = await gw.client.put(
      `/api/v1/workspaces/${wsId}/panes`,
      { zone: 'tabs', ids: [own.body.pane.id, alien.body.pane.id] },
    )
    expect(r.status).toBe(400)
  })

  it('PUT /panes returns 400 on empty ids', async () => {
    const r = await gw.client.put(
      `/api/v1/workspaces/${wsId}/panes`,
      { zone: 'tabs', ids: [] },
    )
    expect(r.status).toBe(400)
  })

  // ───────────────────────────────────────────────────────────────────
  // Layout endpoints
  // ───────────────────────────────────────────────────────────────────

  it('GET /layout returns null fields when nothing has been set', async () => {
    const r = await gw.client.get<{ layout: string | null; sideTrackWidth: number | null }>(
      `/api/v1/workspaces/${wsId}/layout`,
    )
    expect(r.status).toBe(200)
    expect(r.body.layout).toBeNull()
    expect(r.body.sideTrackWidth).toBeNull()
  })

  it('PUT /layout persists an opaque string and GET round-trips it', async () => {
    const layoutPayload = '{"groups":[{"id":"a","children":["pane_x"]}]}'
    const put = await gw.client.put<{ layout: string; sideTrackWidth: number | null }>(
      `/api/v1/workspaces/${wsId}/layout`,
      { layout: layoutPayload },
    )
    expect(put.status).toBe(200)
    expect(put.body.layout).toBe(layoutPayload)

    const get = await gw.client.get<{ layout: string | null }>(
      `/api/v1/workspaces/${wsId}/layout`,
    )
    expect(get.body.layout).toBe(layoutPayload)
  })

  it('PUT /layout persists sideTrackWidth independently of layout', async () => {
    const put = await gw.client.put<{ layout: string | null; sideTrackWidth: number }>(
      `/api/v1/workspaces/${wsId}/layout`,
      { sideTrackWidth: 720 },
    )
    expect(put.status).toBe(200)
    expect(put.body.sideTrackWidth).toBe(720)

    const get = await gw.client.get<{ layout: string | null; sideTrackWidth: number | null }>(
      `/api/v1/workspaces/${wsId}/layout`,
    )
    expect(get.body.sideTrackWidth).toBe(720)
    expect(get.body.layout).toBeNull()
  })

  it('PUT /layout with both fields persists both', async () => {
    const put = await gw.client.put<{ layout: string; sideTrackWidth: number }>(
      `/api/v1/workspaces/${wsId}/layout`,
      { layout: 'L', sideTrackWidth: 480 },
    )
    expect(put.status).toBe(200)
    expect(put.body.layout).toBe('L')
    expect(put.body.sideTrackWidth).toBe(480)
  })

  it('PUT /layout is also surfaced by GET /panes (single-fetch hydration)', async () => {
    await gw.client.put(`/api/v1/workspaces/${wsId}/layout`, { layout: 'X', sideTrackWidth: 600 })
    const r = await gw.client.get<WorkspacePaneListResponse>(
      `/api/v1/workspaces/${wsId}/panes`,
    )
    expect(r.body.layout).toBe('X')
    expect(r.body.sideTrackWidth).toBe(600)
  })

  it('PUT /layout returns 400 on an empty body (at least one field required)', async () => {
    const r = await gw.client.put(
      `/api/v1/workspaces/${wsId}/layout`,
      {},
    )
    expect(r.status).toBe(400)
  })

  it('PUT /layout returns 400 on out-of-range sideTrackWidth', async () => {
    const r = await gw.client.put(
      `/api/v1/workspaces/${wsId}/layout`,
      { sideTrackWidth: 99999 },
    )
    expect(r.status).toBe(400)
  })

  it('layout state is per-workspace', async () => {
    await gw.client.put(`/api/v1/workspaces/${wsId}/layout`, { layout: 'A', sideTrackWidth: 400 })
    await gw.client.put(`/api/v1/workspaces/${wsId2}/layout`, { layout: 'B', sideTrackWidth: 800 })
    const a = await gw.client.get<{ layout: string | null; sideTrackWidth: number | null }>(
      `/api/v1/workspaces/${wsId}/layout`,
    )
    const b = await gw.client.get<{ layout: string | null; sideTrackWidth: number | null }>(
      `/api/v1/workspaces/${wsId2}/layout`,
    )
    expect(a.body.layout).toBe('A')
    expect(a.body.sideTrackWidth).toBe(400)
    expect(b.body.layout).toBe('B')
    expect(b.body.sideTrackWidth).toBe(800)
  })

  // ───────────────────────────────────────────────────────────────────
  // GET /panes/source — wave-5 file viewer back-channel
  // ───────────────────────────────────────────────────────────────────

  describe('GET /panes/source', () => {
    let wsPath: string

    beforeEach(() => {
      // The workspace was created with a tmp dir as its `.path`; pull
      // it back from the gateway state so we can drop test files into
      // it and reference them via relative paths.
      const ws = gw.state.getWorkspace(wsId)
      if (ws == null) throw new Error('workspace missing')
      wsPath = ws.path
    })

    it('returns 200 with text/plain for a markdown file inside the workspace', async () => {
      const filePath = join(wsPath, 'notes.md')
      await writeFile(filePath, '# Hello\n\nbody', 'utf-8')
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/plain')
      expect(r.headers.get('etag')).toMatch(/^W\/"\d+(\.\d+)?:\d+"$/)
      expect(await r.text()).toBe('# Hello\n\nbody')
    })

    it('serves application/json for .json files', async () => {
      const filePath = join(wsPath, 'config.json')
      await writeFile(filePath, '{"x":1}', 'utf-8')
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('application/json')
    })

    it('serves image/png for a .png file (raw bytes)', async () => {
      const filePath = join(wsPath, 'pixel.png')
      // 1×1 transparent PNG
      const png = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
        '0d0a2db40000000049454e44ae426082',
        'hex',
      )
      await writeFile(filePath, png)
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('image/png')
      const bytes = new Uint8Array(await r.arrayBuffer())
      expect(bytes.byteLength).toBe(png.byteLength)
    })

    it('returns 304 when If-None-Match matches the ETag', async () => {
      const filePath = join(wsPath, 'cache-me.md')
      await writeFile(filePath, 'cacheable', 'utf-8')
      const url = `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`
      const first = await fetch(url, {
        headers: { Authorization: `Bearer ${gw.client['token']}` },
      })
      expect(first.status).toBe(200)
      const etag = first.headers.get('etag')!
      const second = await fetch(url, {
        headers: {
          Authorization: `Bearer ${gw.client['token']}`,
          'If-None-Match': etag,
        },
      })
      expect(second.status).toBe(304)
    })

    it('returns 400 when the path query parameter is missing', async () => {
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(400)
    })

    it('returns 404 when the file does not exist', async () => {
      const filePath = join(wsPath, 'never-was.md')
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(404)
    })

    it('returns 403 for an absolute path outside the workspace', async () => {
      const outside = join(tmpdir(), `outside-${Date.now()}.md`)
      await writeFile(outside, 'should not be served', 'utf-8')
      try {
        const r = await fetch(
          `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(outside)}`,
          { headers: { Authorization: `Bearer ${gw.client['token']}` } },
        )
        expect(r.status).toBe(403)
      } finally {
        await rm(outside, { force: true })
      }
    })

    it('returns 403 for a `..`-escape attempt resolved against the workspace', async () => {
      // `wsPath/../../../etc/passwd` — resolved becomes a path outside
      // the workspace; even though the file likely exists, the gate
      // must block.
      const escape = `${wsPath}/../../../../etc/passwd`
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(escape)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      // /etc/passwd may not exist in the test env (CI containers, etc).
      // Either way the gate must NOT serve it: 403 (out-of-workspace)
      // or 404 (resolves but missing) — never 200.
      expect([403, 404]).toContain(r.status)
    })

    it('returns 415 for an unsupported extension', async () => {
      const filePath = join(wsPath, 'archive.zip')
      await writeFile(filePath, 'PK\x03\x04', 'utf-8')
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(415)
    })

    it('returns 413 when the file exceeds the 5 MB cap', async () => {
      const filePath = join(wsPath, 'huge.txt')
      // 5 MB + 1 byte. Use a buffer to avoid string concat blowing the
      // heap; create at the byte level.
      const huge = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61) // 'a'
      await writeFile(filePath, huge)
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/${wsId}/panes/source?path=${encodeURIComponent(filePath)}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(413)
    })

    it('returns 404 for an unknown workspace', async () => {
      const r = await fetch(
        `${gw.client['baseUrl']}/api/v1/workspaces/ws_nope/panes/source?path=${encodeURIComponent(join(wsPath, 'x.md'))}`,
        { headers: { Authorization: `Bearer ${gw.client['token']}` } },
      )
      expect(r.status).toBe(404)
    })
  })
})
