/**
 * Unit tests for `getDetectedApps()` — the cortex-side rich
 * detection function that powers `GET /api/v1/detected-apps`.
 *
 * Phase 3a (2026-05-06) of the connector production rebuild.
 *
 * Strategy: redirect HOME to a temp dir, plant fake config files, and
 * assert the scanner picks them up with the right shape. mdfind is
 * skipped here — its behaviour is platform-specific and tests run on
 * non-darwin CI agents too.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getDetectedApps,
  type DetectedApp,
} from '../../../../src/connector/detection/get-detected-apps.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-detect-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('getDetectedApps — empty environment', () => {
  it('returns an empty list when no sources have any data', async () => {
    const apps = await getDetectedApps()
    // On macOS CI, mdfind may still surface real installed apps —
    // assert non-spotlight scanners contributed nothing.
    const nonSpotlight = apps.filter(a => a.detectedFrom !== 'spotlight')
    expect(nonSpotlight).toEqual([])
  })
})

describe('getDetectedApps — bridge folder', () => {
  it('emits an entry for a valid bridge manifest', async () => {
    const bridgesDir = join(tmpHome, '.ownware', 'bridges')
    mkdirSync(bridgesDir, { recursive: true })
    writeFileSync(
      join(bridgesDir, 'paper.json'),
      JSON.stringify({
        name: 'Paper',
        bundleId: 'com.fiftythree.paper',
        via: 'mcp:paper',
        category: 'design',
        transport: { type: 'http', url: 'http://127.0.0.1:8392/mcp' },
      }),
    )

    const apps = await getDetectedApps()
    const paper = apps.find(a => a.platformId === 'com.fiftythree.paper')
    expect(paper).toBeDefined()
    expect(paper!.name).toBe('Paper')
    expect(paper!.via).toBe('mcp:paper')
    expect(paper!.category).toBe('design')
    expect(paper!.detectedFrom).toBe('bridge')
    expect(paper!.transport?.type).toBe('http')
    expect(paper!.transport?.url).toBe('http://127.0.0.1:8392/mcp')
  })

  it('skips a malformed bridge manifest without throwing', async () => {
    const bridgesDir = join(tmpHome, '.ownware', 'bridges')
    mkdirSync(bridgesDir, { recursive: true })
    writeFileSync(join(bridgesDir, 'broken.json'), '{ this is not json')

    const apps = await getDetectedApps()
    const nonSpotlight = apps.filter(a => a.detectedFrom !== 'spotlight')
    expect(nonSpotlight).toEqual([])
  })

  it('skips a manifest missing required fields', async () => {
    const bridgesDir = join(tmpHome, '.ownware', 'bridges')
    mkdirSync(bridgesDir, { recursive: true })
    writeFileSync(
      join(bridgesDir, 'incomplete.json'),
      JSON.stringify({ category: 'design' }), // no name, no via
    )

    const apps = await getDetectedApps()
    const nonSpotlight = apps.filter(a => a.detectedFrom !== 'spotlight')
    expect(nonSpotlight).toEqual([])
  })
})

describe('getDetectedApps — Claude Desktop config', () => {
  it('emits one entry per mcpServers row', async () => {
    const dir = join(tmpHome, 'Library', 'Application Support', 'Claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'claude_desktop_config.json'),
      JSON.stringify({
        mcpServers: {
          'my-stdio': { command: 'npx', args: ['-y', 'cool-mcp'] },
          'my-http': { type: 'http', url: 'https://example.com/mcp' },
        },
      }),
    )

    const apps = await getDetectedApps()
    const desktop = apps.filter(a => a.detectedFrom === 'claude-desktop')
    expect(desktop.length).toBe(2)

    const stdio = desktop.find(a => a.name === 'My Stdio')!
    expect(stdio.via).toBe('claude-desktop:my-stdio')
    expect(stdio.transport?.type).toBe('stdio')
    expect(stdio.transport?.command).toBe('npx')
    expect(stdio.transport?.args).toEqual(['-y', 'cool-mcp'])

    const http = desktop.find(a => a.name === 'My Http')!
    expect(http.via).toBe('claude-desktop:my-http')
    expect(http.transport?.type).toBe('http')
    expect(http.transport?.url).toBe('https://example.com/mcp')
  })

  it('returns empty when no mcpServers key', async () => {
    const dir = join(tmpHome, 'Library', 'Application Support', 'Claude')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'claude_desktop_config.json'), JSON.stringify({}))

    const apps = await getDetectedApps()
    const desktop = apps.filter(a => a.detectedFrom === 'claude-desktop')
    expect(desktop).toEqual([])
  })
})

describe('getDetectedApps — Claude Code settings', () => {
  it('emits one entry per mcpServers row', async () => {
    const claudeDir = join(tmpHome, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        mcpServers: {
          'foo-server': { command: 'uvx', args: ['foo'] },
        },
      }),
    )

    const apps = await getDetectedApps()
    const foo = apps.find(a => a.via === 'claude-code:foo-server')
    expect(foo).toBeDefined()
    expect(foo!.name).toBe('Foo Server')
    expect(foo!.detectedFrom).toBe('claude-code')
    expect(foo!.transport?.command).toBe('uvx')
  })
})

describe('getDetectedApps — output ordering', () => {
  it('sorts by source then by name within source', async () => {
    // Plant one bridge + one claude-desktop entry. Bridge comes first
    // by source order; within the same source, alphabetical by name.
    const bridgesDir = join(tmpHome, '.ownware', 'bridges')
    mkdirSync(bridgesDir, { recursive: true })
    writeFileSync(
      join(bridgesDir, 'b-app.json'),
      JSON.stringify({ name: 'Bravo', via: 'mcp:bravo', category: 'tool' }),
    )
    writeFileSync(
      join(bridgesDir, 'a-app.json'),
      JSON.stringify({ name: 'Alpha', via: 'mcp:alpha', category: 'tool' }),
    )

    const desktopDir = join(tmpHome, 'Library', 'Application Support', 'Claude')
    mkdirSync(desktopDir, { recursive: true })
    writeFileSync(
      join(desktopDir, 'claude_desktop_config.json'),
      JSON.stringify({
        mcpServers: { 'd-srv': { command: 'echo', args: [] } },
      }),
    )

    const apps = await getDetectedApps()
    const ordered: DetectedApp[] = apps.filter(a => a.detectedFrom !== 'spotlight')
    // Expect: bridge:Alpha, bridge:Bravo, claude-desktop:D Srv
    expect(ordered.map(a => `${a.detectedFrom}:${a.name}`)).toEqual([
      'bridge:Alpha',
      'bridge:Bravo',
      'claude-desktop:D Srv',
    ])
  })
})
