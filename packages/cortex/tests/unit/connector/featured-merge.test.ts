/**
 * Integration tests — bridge catalog merging into `getFeaturedServers()`.
 *
 * Exercises the full path: drop a file in a bridges dir → call
 * `refreshBridgeCache` → bridge appears in `getFeaturedServers()`. Delete
 * the file → refresh → bridge disappears. Validates the cache contract
 * that gateway boot relies on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { refreshBridgeCache } from '../../../src/connector/bridge-catalog.js'
import {
  FEATURED_SERVERS,
  getFeaturedServers,
  getFeaturedServer,
  setBridgeCache,
} from '../../../src/connector/mcp/featured.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'featured-merge-test-'))
  setBridgeCache([])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  setBridgeCache([])
})

// Visible Tier 1 entries — `getFeaturedServers()` filters hidden ones
// (OAuth-only `http_remote` entries that don't work until PKCE lands).
const VISIBLE_FEATURED = FEATURED_SERVERS.filter(s => !s.hidden)

describe('static-only behaviour (no bridges)', () => {
  it('getFeaturedServers returns the visible static list when cache is empty', () => {
    const all = getFeaturedServers()
    expect(all.length).toBe(VISIBLE_FEATURED.length)
    for (let i = 0; i < VISIBLE_FEATURED.length; i++) {
      expect(all[i]?.id).toBe(VISIBLE_FEATURED[i]?.id)
    }
  })
})

describe('drop / remove bridge files', () => {
  it('drops a fake bridge → it appears in getFeaturedServers after refresh', async () => {
    writeFileSync(
      join(dir, 'paper.json'),
      JSON.stringify({
        name: 'Paper',
        category: 'design',
        description: 'Paper bridge',
        transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp' },
      }),
    )
    await refreshBridgeCache({ bridgesDir: dir })

    const found = getFeaturedServer('paper')
    expect(found).toBeDefined()
    expect(found?.title).toBe('Paper')
    expect(found?.transport).toEqual({ kind: 'http_bridge', bridgeId: 'paper' })
    expect(found?.category).toBe('design')

    expect(getFeaturedServers().length).toBe(VISIBLE_FEATURED.length + 1)
  })

  it('deletes the bridge file → it disappears after refresh', async () => {
    const path = join(dir, 'paper.json')
    writeFileSync(
      path,
      JSON.stringify({
        name: 'Paper',
        transport: { url: 'http://127.0.0.1:29979/mcp' },
      }),
    )
    await refreshBridgeCache({ bridgesDir: dir })
    expect(getFeaturedServer('paper')).toBeDefined()

    unlinkSync(path)
    await refreshBridgeCache({ bridgesDir: dir })
    expect(getFeaturedServer('paper')).toBeUndefined()
    expect(getFeaturedServers().length).toBe(VISIBLE_FEATURED.length)
  })

  it('static entry shadows a bridge with the same id (defensive)', async () => {
    // 'github' is a static featured entry. A bridge claiming the same
    // id must NOT shadow it.
    writeFileSync(
      join(dir, 'github.json'),
      JSON.stringify({
        name: 'Imposter GitHub',
        transport: { url: 'http://127.0.0.1:1234/mcp' },
      }),
    )
    await refreshBridgeCache({ bridgesDir: dir })

    const github = getFeaturedServer('github')
    expect(github).toBeDefined()
    // Static entry wins
    expect(github?.title).toBe('GitHub')
    expect(github?.transport.kind).toBe('stdio')
  })

  it('category filter works across static + bridges', async () => {
    writeFileSync(
      join(dir, 'paper.json'),
      JSON.stringify({
        name: 'Paper',
        category: 'design',
        transport: { url: 'http://127.0.0.1:29979/mcp' },
      }),
    )
    await refreshBridgeCache({ bridgesDir: dir })

    const designOnly = getFeaturedServers('design')
    // Figma is the only static `design` entry but is currently hidden
    // (OAuth-only, no paste-token path) — the visible design slice is
    // just the bridge.
    expect(designOnly.map(e => e.id).sort()).toEqual(['paper'])
  })
})
