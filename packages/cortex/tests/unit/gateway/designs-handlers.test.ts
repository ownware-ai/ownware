/**
 * Designs HTTP handlers — Slice 7b (A2).
 *
 * Tests the 4 endpoints over real `GatewayState` (in-memory sqlite +
 * migration 033). Each endpoint: happy path, 404, bad input where
 * applicable. The state-layer round-trip is already covered by
 * `designs.test.ts` from slice 7a; this file adds the HTTP boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GatewayState } from '../../../src/gateway/state.js'
import { createDesignHandlers } from '../../../src/gateway/handlers/designs.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'

interface Captured {
  status: number
  body: unknown
}

function mockReq(body?: unknown): IncomingMessage {
  const req = {
    url: '/api/v1/test',
    headers: { host: 'localhost' },
    method: body == null ? 'GET' : 'POST',
  } as unknown as IncomingMessage
  // readJSON listens for 'data' + 'end'. When body is missing we still
  // need to fire 'end' so the reader resolves with an empty string
  // (which the handler treats as "no body" and returns 400).
  const chunks: Buffer[] =
    body != null ? [Buffer.from(JSON.stringify(body))] : []
  let dataEmitted = false
  ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on = (
    event: string,
    cb: (...a: unknown[]) => void,
  ) => {
    if (event === 'data' && !dataEmitted) {
      dataEmitted = true
      queueMicrotask(() => {
        for (const c of chunks) cb(c)
      })
    }
    if (event === 'end') {
      queueMicrotask(() => cb())
    }
    return req
  }
  return req
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    setHeader() {
      // no-op for tests
    },
    end(payload: string) {
      if (payload != null && payload.length > 0) {
        try {
          captured.body = JSON.parse(payload)
        } catch {
          captured.body = payload
        }
      }
    },
  } as unknown as ServerResponse
  return { res, captured }
}

describe('Designs HTTP handlers (slice 7b)', () => {
  let state: GatewayState
  let tmpDir: string
  let workspaceId: string
  let handlers: ReturnType<typeof createDesignHandlers>
  let registry: ProfileRegistry

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-designs-h-'))
    state = new GatewayState(join(tmpDir, 'test.db'))
    const ws = state.createWorkspace('/tmp/north-mark', 'north-mark')
    workspaceId = ws.id
    registry = new ProfileRegistry()
    handlers = createDesignHandlers(state, { registry })
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('POST /api/v1/workspaces/:wsId/designs', () => {
    it('creates a design row and returns 201 + the new row', async () => {
      const req = mockReq({
        slug: 'pricing-cover',
        kind: 'prototype',
        name: 'Pricing cover',
        templateSource: 'ownware/pricing',
      })
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: workspaceId })

      expect(captured.status).toBe(201)
      const body = captured.body as Record<string, unknown>
      expect(body['workspaceId']).toBe(workspaceId)
      expect(body['slug']).toBe('pricing-cover')
      expect(body['kind']).toBe('prototype')
      expect(body['name']).toBe('Pricing cover')
      expect(body['templateSource']).toBe('ownware/pricing')
      // ID format from slice 7a: dsn_<12 hex>
      expect((body['id'] as string).startsWith('dsn_')).toBe(true)
    })

    it('returns 404 when the workspace does not exist', async () => {
      const req = mockReq({ slug: 'p1', kind: 'prototype' })
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: 'ws_does_not_exist' })

      expect(captured.status).toBe(404)
      expect((captured.body as Record<string, string>)['message']).toContain('not found')
    })

    it('returns 400 when slug fails zod validation', async () => {
      const req = mockReq({ slug: 'Bad Slug With Spaces', kind: 'prototype' })
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: workspaceId })

      expect(captured.status).toBe(400)
      expect((captured.body as Record<string, string>)['message']).toContain('slug')
    })

    it('returns 400 when kind is not in the closed enum', async () => {
      const req = mockReq({ slug: 'p1', kind: 'hyperframes' })
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: workspaceId })

      expect(captured.status).toBe(400)
      expect((captured.body as Record<string, string>)['message']).toContain('kind')
    })

    it('returns 409 when the slug already exists in the workspace', async () => {
      state.createDesign(workspaceId, 'pricing-cover', 'prototype')

      const req = mockReq({ slug: 'pricing-cover', kind: 'sketch' })
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: workspaceId })

      expect(captured.status).toBe(409)
      expect((captured.body as Record<string, string>)['message']).toContain('already exists')
    })

    it('returns 400 when the body is missing', async () => {
      const req = mockReq()
      const { res, captured } = mockRes()
      await handlers.createDesign(req, res, { wsId: workspaceId })

      expect(captured.status).toBe(400)
    })
  })

  describe('GET /api/v1/workspaces/:wsId/designs', () => {
    it('returns an empty array for a workspace with no designs', async () => {
      const { res, captured } = mockRes()
      await handlers.listDesigns(mockReq(), res, { wsId: workspaceId })

      expect(captured.status).toBe(200)
      expect(captured.body).toEqual([])
    })

    // Listing matches on the path-nesting convention: each design lives
    // in its OWN folder workspace at `<parent>/.ownware/app/ownware-design/<slug>/`
    // (D-A16), and `GET /workspaces/:parentId/designs` returns designs
    // whose folder workspace nests under the parent's path.
    function createNestedDesign(
      parentPath: string,
      slug: string,
      kind: Parameters<typeof state.createDesign>[2],
    ) {
      const ws = state.createWorkspace(
        `${parentPath}/.ownware/app/ownware-design/${slug}`,
        slug,
      )
      return state.createDesign(ws.id, slug, kind)
    }

    it('lists every design in the workspace, newest first', async () => {
      createNestedDesign('/tmp/north-mark', 'a', 'prototype')
      createNestedDesign('/tmp/north-mark', 'b', 'sketch')
      createNestedDesign('/tmp/north-mark', 'c', 'deck')

      const { res, captured } = mockRes()
      await handlers.listDesigns(mockReq(), res, { wsId: workspaceId })

      expect(captured.status).toBe(200)
      const body = captured.body as Array<Record<string, unknown>>
      expect(body).toHaveLength(3)
      const slugs = body.map((d) => d['slug'])
      expect(slugs.sort()).toEqual(['a', 'b', 'c'])
    })

    it('does not leak designs across workspaces', async () => {
      state.createWorkspace('/tmp/other', 'other')
      createNestedDesign('/tmp/north-mark', 'in-ws-1', 'prototype')
      createNestedDesign('/tmp/other', 'in-ws-2', 'prototype')

      const { res, captured } = mockRes()
      await handlers.listDesigns(mockReq(), res, { wsId: workspaceId })

      const body = captured.body as Array<Record<string, unknown>>
      expect(body).toHaveLength(1)
      expect(body[0]?.['slug']).toBe('in-ws-1')
    })

    it('returns 404 for an unknown workspace', async () => {
      const { res, captured } = mockRes()
      await handlers.listDesigns(mockReq(), res, { wsId: 'ws_no' })
      expect(captured.status).toBe(404)
    })
  })

  describe('POST /api/v1/threads/:threadId/design', () => {
    it('links a thread to a design and returns the design row', async () => {
      const design = state.createDesign(workspaceId, 'p1', 'prototype')
      const thread = state.createThread('ownware-design', 'New design', workspaceId)

      const req = mockReq({ designId: design.id })
      const { res, captured } = mockRes()
      await handlers.linkThreadDesign(req, res, { threadId: thread.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['id']).toBe(design.id)
      // verify the link persisted
      const resolved = state.getDesignForThread(thread.id)
      expect(resolved?.id).toBe(design.id)
    })

    it('replaces the existing link when called twice (one design per thread)', async () => {
      const d1 = state.createDesign(workspaceId, 'p1', 'prototype')
      const d2 = state.createDesign(workspaceId, 'p2', 'sketch')
      const thread = state.createThread('ownware-design', 'T', workspaceId)

      await handlers.linkThreadDesign(mockReq({ designId: d1.id }), mockRes().res, {
        threadId: thread.id,
      })
      await handlers.linkThreadDesign(mockReq({ designId: d2.id }), mockRes().res, {
        threadId: thread.id,
      })

      const resolved = state.getDesignForThread(thread.id)
      expect(resolved?.id).toBe(d2.id)
    })

    it('returns 404 when the thread does not exist', async () => {
      const design = state.createDesign(workspaceId, 'p1', 'prototype')
      const req = mockReq({ designId: design.id })
      const { res, captured } = mockRes()
      await handlers.linkThreadDesign(req, res, { threadId: 'thread_no' })
      expect(captured.status).toBe(404)
    })

    it('returns 404 when the design does not exist', async () => {
      const thread = state.createThread('ownware-design', 'T', workspaceId)
      const req = mockReq({ designId: 'dsn_does_not_exist' })
      const { res, captured } = mockRes()
      await handlers.linkThreadDesign(req, res, { threadId: thread.id })
      expect(captured.status).toBe(404)
    })

    it('returns 400 when body is missing designId', async () => {
      const thread = state.createThread('ownware-design', 'T', workspaceId)
      const req = mockReq({ wrongKey: 'whatever' })
      const { res, captured } = mockRes()
      await handlers.linkThreadDesign(req, res, { threadId: thread.id })
      expect(captured.status).toBe(400)
    })
  })

  describe('GET /api/v1/threads/:threadId/design', () => {
    it('returns the linked design when one exists', async () => {
      const design = state.createDesign(workspaceId, 'p1', 'prototype')
      const thread = state.createThread('ownware-design', 'T', workspaceId)
      state.linkThreadToDesign(thread.id, design.id)

      const { res, captured } = mockRes()
      await handlers.getThreadDesign(mockReq(), res, { threadId: thread.id })

      expect(captured.status).toBe(200)
      expect((captured.body as Record<string, unknown>)['id']).toBe(design.id)
    })

    it('returns 200 with null body when the thread has no design link', async () => {
      const thread = state.createThread('coder', 'A non-Design thread', workspaceId)

      const { res, captured } = mockRes()
      await handlers.getThreadDesign(mockReq(), res, { threadId: thread.id })

      expect(captured.status).toBe(200)
      expect(captured.body).toBeNull()
    })

    it('returns 404 when the thread does not exist', async () => {
      const { res, captured } = mockRes()
      await handlers.getThreadDesign(mockReq(), res, { threadId: 'thread_no' })
      expect(captured.status).toBe(404)
    })
  })

  describe('GET /api/v1/designs/:designId/thread (BC3 reverse lookup)', () => {
    it('returns the linked thread id when a thread is linked', async () => {
      const design = state.createDesign(workspaceId, 'p1', 'prototype')
      const thread = state.createThread('ownware-design', 'T', workspaceId)
      state.linkThreadToDesign(thread.id, design.id)

      const { res, captured } = mockRes()
      await handlers.getDesignThread(mockReq(), res, { designId: design.id })

      expect(captured.status).toBe(200)
      expect(captured.body).toEqual({ threadId: thread.id })
    })

    it('returns the MOST RECENTLY linked thread when several threads share the design', async () => {
      const design = state.createDesign(workspaceId, 'p2', 'prototype')
      const t1 = state.createThread('ownware-design', 'first', workspaceId)
      state.linkThreadToDesign(t1.id, design.id)
      // Tiny tick so the second link has a strictly later created_at.
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      const t2 = state.createThread('ownware-design', 'second', workspaceId)
      state.linkThreadToDesign(t2.id, design.id)

      const { res, captured } = mockRes()
      await handlers.getDesignThread(mockReq(), res, { designId: design.id })

      expect(captured.status).toBe(200)
      expect((captured.body as { threadId: string }).threadId).toBe(t2.id)
    })

    it('returns 200 with null body when the design exists but has no linked threads', async () => {
      const design = state.createDesign(workspaceId, 'orphan', 'prototype')

      const { res, captured } = mockRes()
      await handlers.getDesignThread(mockReq(), res, { designId: design.id })

      expect(captured.status).toBe(200)
      expect(captured.body).toBeNull()
    })

    it('returns 404 when the design id does not exist', async () => {
      const { res, captured } = mockRes()
      await handlers.getDesignThread(mockReq(), res, { designId: 'dsn_no' })
      expect(captured.status).toBe(404)
    })
  })

  describe('GET /api/v1/designs/:designId/threads (Slice 2 — multi-session list)', () => {
    it('returns all linked threads, most-recent-first, as full Thread rows', async () => {
      const design = state.createDesign(workspaceId, 'multi', 'prototype')
      const t1 = state.createThread('ownware-design', 'first', workspaceId)
      state.linkThreadToDesign(t1.id, design.id)
      // Tick so the second link's created_at is strictly later.
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      const t2 = state.createThread('ownware-design', 'second', workspaceId)
      state.linkThreadToDesign(t2.id, design.id)

      const { res, captured } = mockRes()
      await handlers.listThreadsForDesign(mockReq(), res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Array<Record<string, unknown>>
      expect(body).toHaveLength(2)
      expect(body[0]?.['id']).toBe(t2.id) // most-recent-first
      expect(body[1]?.['id']).toBe(t1.id)
      // Full Thread rows so the switcher can label without a 2nd round-trip.
      expect(body[0]?.['title']).toBe('second')
    })

    it('returns an empty array when the design has no linked threads', async () => {
      const design = state.createDesign(workspaceId, 'lonely', 'prototype')
      const { res, captured } = mockRes()
      await handlers.listThreadsForDesign(mockReq(), res, { designId: design.id })
      expect(captured.status).toBe(200)
      expect(captured.body).toEqual([])
    })

    it('does not leak threads across designs', async () => {
      const d1 = state.createDesign(workspaceId, 'd-one', 'prototype')
      const d2 = state.createDesign(workspaceId, 'd-two', 'prototype')
      const ta = state.createThread('ownware-design', 'A', workspaceId)
      const tb = state.createThread('ownware-design', 'B', workspaceId)
      state.linkThreadToDesign(ta.id, d1.id)
      state.linkThreadToDesign(tb.id, d2.id)

      const { res, captured } = mockRes()
      await handlers.listThreadsForDesign(mockReq(), res, { designId: d1.id })
      const body = captured.body as Array<Record<string, unknown>>
      expect(body).toHaveLength(1)
      expect(body[0]?.['id']).toBe(ta.id)
    })

    it('returns 404 when the design id does not exist', async () => {
      const { res, captured } = mockRes()
      await handlers.listThreadsForDesign(mockReq(), res, { designId: 'dsn_no' })
      expect(captured.status).toBe(404)
    })
  })

  describe('POST /api/v1/designs/:designId/seed-template', () => {
    /** Stand up a fake ownware-design profile dir with one template
     *  inside (`design-templates/<id>/`) so the handler has something
     *  real to read. Behaviour reversed in slice B1.5 (2026-05-27):
     *  the endpoint now returns SKILL.md + example.html as JSON
     *  instead of copying the folder. Slug folders stay empty. */
    async function seedFakeTemplate(
      templateId: string,
      files: ReadonlyMap<string, string>,
    ): Promise<string> {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const profileRoot = join(tmpDir, 'profile-ownware-design')
      const templateRoot = join(profileRoot, 'design-templates', templateId)
      await mkdir(templateRoot, { recursive: true })
      for (const [rel, contents] of files.entries()) {
        const target = join(templateRoot, rel)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, contents, 'utf8')
      }
      registry.register(
        'ownware-design',
        { name: 'ownware-design', description: 'test', model: 'test:m' } as Parameters<typeof registry.register>[1],
        profileRoot,
      )
      return templateRoot
    }

    it('returns SKILL.md + example.html as JSON (no file writes to the slug folder)', async () => {
      const { mkdir, readdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-acme')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'acme')
      const design = state.createDesign(ws.id, 'pricing', 'prototype')
      await seedFakeTemplate(
        'pricing-page',
        new Map([
          ['SKILL.md', '---\nname: pricing-page\n---\nUse a 3-tier grid.'],
          ['example.html', '<h1>Pricing</h1>'],
          ['assets/logo.svg', '<svg />'],
        ]),
      )

      const req = mockReq({ templateId: 'pricing-page' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['designId']).toBe(design.id)
      expect(body['templateId']).toBe('pricing-page')
      expect(body['skillMd']).toBe('---\nname: pricing-page\n---\nUse a 3-tier grid.')
      expect(body['exampleHtml']).toBe('<h1>Pricing</h1>')
      // Filesystem invariant — pure pass-through, slug folder untouched.
      const entries = await readdir(wsPath)
      expect(entries).toEqual([])
    })

    it('returns exampleHtml="" when the template has no example.html', async () => {
      const { mkdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-html-ppt')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'html-ppt-ws')
      const design = state.createDesign(ws.id, 'deck', 'deck')
      // html-ppt-style template — SKILL.md only, no example.html.
      await seedFakeTemplate(
        'html-ppt',
        new Map([['SKILL.md', 'Use scroll-snap. Author the deck framework inline.']]),
      )

      const req = mockReq({ templateId: 'html-ppt' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['skillMd']).toContain('scroll-snap')
      expect(body['exampleHtml']).toBe('')
    })

    it('returns 404 when SKILL.md is missing (malformed template)', async () => {
      const { mkdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-bad-tpl')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'bad-tpl-ws')
      const design = state.createDesign(ws.id, 'p', 'prototype')
      // Template dir exists but contains only example.html.
      await seedFakeTemplate(
        'no-skill',
        new Map([['example.html', '<h1>Orphan</h1>']]),
      )

      const req = mockReq({ templateId: 'no-skill' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })

      expect(captured.status).toBe(404)
      expect((captured.body as Record<string, string>)['message']).toContain('SKILL.md')
    })

    it('returns 404 when the design does not exist', async () => {
      const req = mockReq({ templateId: 'x' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: 'dsn_no' })
      expect(captured.status).toBe(404)
    })

    it('returns 404 when the templateId is not in the catalog', async () => {
      const { mkdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-empty')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'empty')
      const design = state.createDesign(ws.id, 'p', 'prototype')
      // Register a profile but with no design-templates dir
      registry.register(
        'ownware-design',
        { name: 'ownware-design', description: 'test', model: 'test:m' } as Parameters<typeof registry.register>[1],
        join(tmpDir, 'no-templates'),
      )

      const req = mockReq({ templateId: 'nonexistent' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })
      expect(captured.status).toBe(404)
      expect((captured.body as Record<string, string>)['message']).toContain('not found in catalog')
    })

    it('returns 400 when templateId fails zod (escape attempt)', async () => {
      const { mkdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-escape')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'esc')
      const design = state.createDesign(ws.id, 'p', 'prototype')
      registry.register(
        'ownware-design',
        { name: 'ownware-design', description: 'test', model: 'test:m' } as Parameters<typeof registry.register>[1],
        join(tmpDir, 'profile'),
      )

      const req = mockReq({ templateId: '../../etc/passwd' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })
      expect(captured.status).toBe(400)
    })

    it('does NOT 409 when the slug folder already contains files (pure pass-through, no overwrite check)', async () => {
      // Pre-B1.5 the handler returned 409 if any template file existed
      // in the workspace. With pure pass-through there is no file copy,
      // so pre-existing slug-folder contents are irrelevant. Locking
      // this in so the no-overwrite check is not accidentally re-added.
      const { mkdir, writeFile } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-occupied-now-ok')
      await mkdir(wsPath, { recursive: true })
      await writeFile(join(wsPath, 'example.html'), 'pre-existing', 'utf8')
      const ws = state.createWorkspace(wsPath, 'occupied-ok')
      const design = state.createDesign(ws.id, 'p', 'prototype')
      await seedFakeTemplate(
        'tpl',
        new Map([
          ['SKILL.md', 'use a 12-col grid'],
          ['example.html', '<h1>Hello</h1>'],
        ]),
      )

      const req = mockReq({ templateId: 'tpl' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })
      expect(captured.status).toBe(200)
      // Pre-existing slug-folder file is untouched (no overwrite, no read).
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(join(wsPath, 'example.html'), 'utf8')).toBe(
        'pre-existing',
      )
    })

    it('returns 500 when the ownware-design profile is not registered', async () => {
      const { mkdir } = await import('node:fs/promises')
      const wsPath = join(tmpDir, 'ws-noprofile')
      await mkdir(wsPath, { recursive: true })
      const ws = state.createWorkspace(wsPath, 'noprof')
      const design = state.createDesign(ws.id, 'p', 'prototype')
      // No registry.register() call — profile missing on purpose

      const req = mockReq({ templateId: 'x' })
      const { res, captured } = mockRes()
      await handlers.seedTemplate(req, res, { designId: design.id })
      expect(captured.status).toBe(500)
      expect((captured.body as Record<string, string>)['message']).toContain('not registered')
    })
  })

  describe('PATCH /api/v1/designs/:designId (slice B1.6)', () => {
    /** Stand up a parent dir + slug folder so updateDesign has real
     *  filesystem to rename. */
    async function setupDesignFolder(
      parentDir: string,
      slug: string,
      seedFiles?: ReadonlyMap<string, string>,
    ): Promise<{ wsPath: string; ws: ReturnType<typeof state.createWorkspace> }> {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const wsPath = join(parentDir, slug)
      await mkdir(wsPath, { recursive: true })
      if (seedFiles) {
        for (const [rel, contents] of seedFiles.entries()) {
          await writeFile(join(wsPath, rel), contents, 'utf8')
        }
      }
      const ws = state.createWorkspace(wsPath, slug)
      return { wsPath, ws }
    }

    it('renames a slug — moves the on-disk folder AND updates designs.slug + workspaces.path atomically', async () => {
      const { mkdir, access, readFile } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-rename-parent')
      await mkdir(parentDir, { recursive: true })
      const { wsPath, ws } = await setupDesignFolder(
        parentDir,
        'old-name',
        new Map([['index.html', '<h1>Hello</h1>']]),
      )
      const design = state.createDesign(ws.id, 'old-name', 'prototype', {
        name: 'Old Name',
      })

      const req = mockReq({ slug: 'fresh-name', name: 'Fresh Name' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['slug']).toBe('fresh-name')
      expect(body['name']).toBe('Fresh Name')

      // Filesystem: folder moved, contents intact.
      const newPath = join(parentDir, 'fresh-name')
      await expect(access(newPath)).resolves.toBeUndefined()
      await expect(access(wsPath)).rejects.toBeDefined() // old gone
      expect((await readFile(join(newPath, 'index.html'), 'utf8')).trim()).toBe(
        '<h1>Hello</h1>',
      )

      // DB: workspace.path now points at the new folder.
      const refreshedWs = state.getWorkspace(ws.id)
      expect(refreshedWs?.path).toBe(newPath)
      const refreshedDesign = state.getDesign(design.id)
      expect(refreshedDesign?.slug).toBe('fresh-name')
      expect(refreshedDesign?.name).toBe('Fresh Name')
    })

    it('name-only update does not touch the filesystem', async () => {
      const { mkdir, access } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-name-only-parent')
      await mkdir(parentDir, { recursive: true })
      const { wsPath, ws } = await setupDesignFolder(parentDir, 'keep-slug')
      const design = state.createDesign(ws.id, 'keep-slug', 'prototype', {
        name: 'Original',
      })

      const req = mockReq({ name: 'Renamed Display' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      expect((captured.body as Record<string, unknown>)['name']).toBe(
        'Renamed Display',
      )
      expect((captured.body as Record<string, unknown>)['slug']).toBe(
        'keep-slug',
      )
      // Folder untouched, still at the original path.
      await expect(access(wsPath)).resolves.toBeUndefined()
    })

    it('returns 404 when the design does not exist', async () => {
      const req = mockReq({ name: 'x' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: 'dsn_missing' })
      expect(captured.status).toBe(404)
    })

    it('returns 400 when neither name nor slug is provided', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-empty-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'has-slug')
      const design = state.createDesign(ws.id, 'has-slug', 'prototype')

      const req = mockReq({})
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })
      expect(captured.status).toBe(400)
      expect((captured.body as Record<string, string>)['message']).toMatch(
        /at least one.*name|slug|kind/i,
      )
    })

    it('returns 400 for invalid slug (uppercase / path escape)', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-invalid-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'good-slug')
      const design = state.createDesign(ws.id, 'good-slug', 'prototype')

      // Uppercase
      const req1 = mockReq({ slug: 'UPPER-CASE' })
      const r1 = mockRes()
      await handlers.updateDesign(req1, r1.res, { designId: design.id })
      expect(r1.captured.status).toBe(400)

      // Path traversal attempt
      const req2 = mockReq({ slug: '../escape' })
      const r2 = mockRes()
      await handlers.updateDesign(req2, r2.res, { designId: design.id })
      expect(r2.captured.status).toBe(400)
    })

    it('returns 409 when the target slug folder already exists on disk', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-collision-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'one')
      await setupDesignFolder(parentDir, 'two') // sibling, blocks rename
      const design = state.createDesign(ws.id, 'one', 'prototype')

      const req = mockReq({ slug: 'two' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })
      expect(captured.status).toBe(409)
      expect((captured.body as Record<string, string>)['message']).toMatch(
        /already taken/i,
      )
    })

    it('rejects extra keys per strict schema (defends against UI sending phantom fields)', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-strict-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'strict-slug')
      const design = state.createDesign(ws.id, 'strict-slug', 'prototype')

      // `templateSource` used to be the phantom — slice B1.9 made it
      // a real field. Use a still-phantom field here.
      const req = mockReq({ name: 'OK', archivedAt: '2026-05-27T00:00:00Z' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })
      expect(captured.status).toBe(400)
    })

    // ─── Slice B1.7 — kind switch ─────────────────────────────────

    it('B1.7 — kind switch is metadata-only (no FS touch, design row updated)', async () => {
      const { mkdir, access } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-kind-parent')
      await mkdir(parentDir, { recursive: true })
      const { wsPath, ws } = await setupDesignFolder(parentDir, 'kind-slug')
      const design = state.createDesign(ws.id, 'kind-slug', 'prototype')

      const req = mockReq({ kind: 'deck' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['kind']).toBe('deck')
      expect(body['slug']).toBe('kind-slug') // unchanged
      // Folder untouched.
      await expect(access(wsPath)).resolves.toBeUndefined()
      // DB row reflects new kind.
      expect(state.getDesign(design.id)?.kind).toBe('deck')
    })

    it('B1.7 — kind + name in one PATCH', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-kind-name-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'kn-slug')
      const design = state.createDesign(ws.id, 'kn-slug', 'prototype', {
        name: 'Old',
      })

      const req = mockReq({ kind: 'hyperframe', name: 'Animated Title' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['kind']).toBe('hyperframe')
      expect(body['name']).toBe('Animated Title')
    })

    it('B1.7 — kind alongside slug rename also updates kind atomically', async () => {
      const { mkdir, access } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-kind-slug-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'before-name')
      const design = state.createDesign(ws.id, 'before-name', 'prototype')

      const req = mockReq({ kind: 'sketch', slug: 'after-name' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['kind']).toBe('sketch')
      expect(body['slug']).toBe('after-name')
      await expect(access(join(parentDir, 'after-name'))).resolves.toBeUndefined()
    })

    it('B1.7 — rejects unknown kind values', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-bad-kind-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'bad-kind-slug')
      const design = state.createDesign(ws.id, 'bad-kind-slug', 'prototype')

      const req = mockReq({ kind: 'not-a-real-kind' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })
      expect(captured.status).toBe(400)
    })

    it('B1.9 — accepts templateSource as a metadata-only PATCH (no FS work)', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-tpl-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'tpl-slug')
      const design = state.createDesign(ws.id, 'tpl-slug', 'prototype')

      const req = mockReq({ templateSource: 'pricing-page' })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['templateSource']).toBe('pricing-page')
      // Slug folder still untouched (metadata-only).
      const { access } = await import('node:fs/promises')
      await expect(access(join(parentDir, 'tpl-slug'))).resolves.toBeUndefined()
    })

    it('B1.9 — accepts templateSource=null to clear the pin', async () => {
      const { mkdir } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-tpl-clear-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'tpl-clear')
      const design = state.createDesign(ws.id, 'tpl-clear', 'prototype', {
        templateSource: 'pricing-page',
      })
      expect(design.templateSource).toBe('pricing-page')

      const req = mockReq({ templateSource: null })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['templateSource']).toBeNull()
    })

    it('B1.9 — templateSource alongside slug rename updates both atomically', async () => {
      const { mkdir, access } = await import('node:fs/promises')
      const parentDir = join(tmpDir, 'patch-tpl-slug-parent')
      await mkdir(parentDir, { recursive: true })
      const { ws } = await setupDesignFolder(parentDir, 'tpl-rename-old')
      const design = state.createDesign(ws.id, 'tpl-rename-old', 'prototype')

      const req = mockReq({
        templateSource: 'html-ppt-pitch-deck',
        slug: 'tpl-rename-new',
      })
      const { res, captured } = mockRes()
      await handlers.updateDesign(req, res, { designId: design.id })

      expect(captured.status).toBe(200)
      const body = captured.body as Record<string, unknown>
      expect(body['templateSource']).toBe('html-ppt-pitch-deck')
      expect(body['slug']).toBe('tpl-rename-new')
      await expect(
        access(join(parentDir, 'tpl-rename-new')),
      ).resolves.toBeUndefined()
    })
  })
})
