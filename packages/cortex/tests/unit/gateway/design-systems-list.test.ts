/**
 * Design-systems list endpoint — Slice A5a.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { createDesignSystemsListHandlers } from '../../../src/gateway/handlers/design-systems-list.js'

function mockReq(): IncomingMessage {
  const req = {
    url: '/api/v1/test',
    headers: { host: 'localhost' },
    method: 'GET',
    on: () => req,
  } as unknown as IncomingMessage
  return req
}

function mockRes(): { res: ServerResponse; captured: { status: number; body: unknown } } {
  const captured = { status: 0, body: null as unknown }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    setHeader() {},
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

describe('GET /api/v1/profiles/:profileId/design-systems', () => {
  let tmpDir: string
  let registry: ProfileRegistry
  let handlers: ReturnType<typeof createDesignSystemsListHandlers>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ds-list-'))
    registry = new ProfileRegistry()
    handlers = createDesignSystemsListHandlers({ registry })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function registerProfileWithDS(systems: Array<Record<string, unknown>>): void {
    const profileRoot = join(tmpDir, 'profile')
    const dsRoot = join(profileRoot, 'design-systems')
    mkdirSync(dsRoot, { recursive: true })
    // _schema folder (should be skipped)
    mkdirSync(join(dsRoot, '_schema'), { recursive: true })
    for (const sys of systems) {
      const id = sys['id'] as string
      const dir = join(dsRoot, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(sys), 'utf8')
    }
    registry.register(
      'ownware-design',
      { name: 'ownware-design', description: 'd', model: 'm:n' } as Parameters<typeof registry.register>[1],
      profileRoot,
    )
  }

  it('returns sorted list of design systems from the profile catalogue', async () => {
    registerProfileWithDS([
      {
        id: 'warm-soft',
        name: 'Warm Soft',
        category: 'consumer',
        surface: 'web',
        summary: 'cream + terracotta',
        swatches: ['#fdf9f3', '#c96442'],
      },
      {
        id: 'editorial-monocle',
        name: 'Editorial Monocle',
        category: 'editorial',
        surface: 'web',
        summary: 'serif magazine',
        swatches: ['#0E0E0E', '#FAF7EE'],
      },
    ])

    const { res, captured } = mockRes()
    await handlers.listDesignSystems(mockReq(), res, { profileId: 'ownware-design' })

    expect(captured.status).toBe(200)
    const body = captured.body as Array<Record<string, unknown>>
    expect(body).toHaveLength(2)
    // Sorted by name alphabetically
    expect(body[0]?.['id']).toBe('editorial-monocle')
    expect(body[1]?.['id']).toBe('warm-soft')
  })

  it('returns 404 when the profile is not registered', async () => {
    const { res, captured } = mockRes()
    await handlers.listDesignSystems(mockReq(), res, { profileId: 'no-such-profile' })
    expect(captured.status).toBe(404)
  })

  it('returns 200 + empty array when the profile has no design-systems folder', async () => {
    const profileRoot = join(tmpDir, 'profile-empty')
    mkdirSync(profileRoot, { recursive: true })
    registry.register(
      'p-empty',
      { name: 'p-empty', description: 'd', model: 'm:n' } as Parameters<typeof registry.register>[1],
      profileRoot,
    )

    const { res, captured } = mockRes()
    await handlers.listDesignSystems(mockReq(), res, { profileId: 'p-empty' })

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual([])
  })

  it('skips entries with missing or malformed manifest.json', async () => {
    const profileRoot = join(tmpDir, 'profile-partial')
    const dsRoot = join(profileRoot, 'design-systems')
    mkdirSync(dsRoot, { recursive: true })
    // Good entry
    mkdirSync(join(dsRoot, 'good'), { recursive: true })
    writeFileSync(
      join(dsRoot, 'good', 'manifest.json'),
      JSON.stringify({ id: 'good', name: 'Good', swatches: [] }),
      'utf8',
    )
    // Missing manifest
    mkdirSync(join(dsRoot, 'broken-no-manifest'), { recursive: true })
    // Malformed manifest
    mkdirSync(join(dsRoot, 'broken-malformed'), { recursive: true })
    writeFileSync(join(dsRoot, 'broken-malformed', 'manifest.json'), '{not json', 'utf8')
    registry.register(
      'p-partial',
      { name: 'p-partial', description: 'd', model: 'm:n' } as Parameters<typeof registry.register>[1],
      profileRoot,
    )

    const { res, captured } = mockRes()
    await handlers.listDesignSystems(mockReq(), res, { profileId: 'p-partial' })

    expect(captured.status).toBe(200)
    const body = captured.body as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    expect(body[0]?.['id']).toBe('good')
  })
})

describe('GET /api/v1/profiles/:profileId/design-systems/:dsId/content', () => {
  let tmpDir: string
  let registry: ProfileRegistry
  let handlers: ReturnType<typeof createDesignSystemsListHandlers>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-ds-content-'))
    registry = new ProfileRegistry()
    handlers = createDesignSystemsListHandlers({ registry })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function registerProfileWithDSDir(
    dsId: string,
    files: { readonly designMd?: string; readonly tokensCss?: string },
  ): void {
    const profileRoot = join(tmpDir, 'profile')
    const dir = join(profileRoot, 'design-systems', dsId)
    mkdirSync(dir, { recursive: true })
    if (files.designMd != null) {
      writeFileSync(join(dir, 'DESIGN.md'), files.designMd, 'utf8')
    }
    if (files.tokensCss != null) {
      writeFileSync(join(dir, 'tokens.css'), files.tokensCss, 'utf8')
    }
    registry.register(
      'ownware-design',
      { name: 'ownware-design', description: 'd', model: 'm:n' } as Parameters<typeof registry.register>[1],
      profileRoot,
    )
  }

  it('returns DESIGN.md + tokens.css contents verbatim', async () => {
    const designMd = '# Modern Minimal\n\nClean B2B.\n'
    const tokensCss = ':root { --cx-violet: #7C5CFC; }\n'
    registerProfileWithDSDir('modern-minimal', { designMd, tokensCss })

    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: 'modern-minimal',
    })

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      id: 'modern-minimal',
      designMd,
      tokensCss,
    })
  })

  it('returns 400 when dsId is not lowercase kebab-case', async () => {
    registerProfileWithDSDir('modern-minimal', {
      designMd: 'x',
      tokensCss: 'y',
    })
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: 'Modern_Minimal',
    })
    expect(captured.status).toBe(400)
  })

  it('returns 400 on path-escape attempts in dsId', async () => {
    registerProfileWithDSDir('modern-minimal', {
      designMd: 'x',
      tokensCss: 'y',
    })
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: '../etc',
    })
    expect(captured.status).toBe(400)
  })

  it('returns 404 when the profile is not registered', async () => {
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'no-such-profile',
      dsId: 'modern-minimal',
    })
    expect(captured.status).toBe(404)
  })

  it('returns 404 when the design system folder is missing', async () => {
    registerProfileWithDSDir('modern-minimal', {
      designMd: 'x',
      tokensCss: 'y',
    })
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: 'nope',
    })
    expect(captured.status).toBe(404)
  })

  it('returns 404 when DESIGN.md is missing from the folder', async () => {
    registerProfileWithDSDir('modern-minimal', { tokensCss: 'y' })
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: 'modern-minimal',
    })
    expect(captured.status).toBe(404)
  })

  it('returns 404 when tokens.css is missing from the folder', async () => {
    registerProfileWithDSDir('modern-minimal', { designMd: 'x' })
    const { res, captured } = mockRes()
    await handlers.getDesignSystemContent(mockReq(), res, {
      profileId: 'ownware-design',
      dsId: 'modern-minimal',
    })
    expect(captured.status).toBe(404)
  })
})
