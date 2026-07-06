/**
 * Unit tests — bridge-catalog reader.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBridgeCatalog, resolveBridgeUrl } from '../../../src/connector/bridge-catalog.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-catalog-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readBridgeCatalog', () => {
  it('returns empty array when directory is missing', async () => {
    const missing = join(dir, 'no-such-subdir')
    expect(await readBridgeCatalog({ bridgesDir: missing })).toEqual([])
  })

  it('returns empty array when directory is empty', async () => {
    expect(await readBridgeCatalog({ bridgesDir: dir })).toEqual([])
  })

  it('parses a well-formed Paper-style manifest', async () => {
    writeFileSync(
      join(dir, 'paper.json'),
      JSON.stringify({
        name: 'Paper',
        bundleId: 'com.paperdesigner.Paper',
        category: 'design',
        description: 'Design tool — read designs, export assets.',
        transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp' },
      }),
    )
    const entries = await readBridgeCatalog({ bridgesDir: dir })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      id: 'paper',
      title: 'Paper',
      description: 'Design tool — read designs, export assets.',
      category: 'design',
      transport: { kind: 'http_bridge', bridgeId: 'paper' },
      requiredEnv: [],
      repository: '',
      icon: '',
      authType: 'none',
    })
  })

  it('falls back to default category when category is unknown', async () => {
    writeFileSync(
      join(dir, 'odd.json'),
      JSON.stringify({
        name: 'Odd App',
        category: 'this-is-not-a-real-category',
        transport: { url: 'http://127.0.0.1:9999/mcp' },
      }),
    )
    const entries = await readBridgeCatalog({ bridgesDir: dir })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.category).toBe('productivity')
  })

  it('synthesizes a default description when the manifest omits one', async () => {
    writeFileSync(
      join(dir, 'minimal.json'),
      JSON.stringify({
        name: 'Minimal',
        transport: { url: 'http://127.0.0.1:7777/mcp' },
      }),
    )
    const entries = await readBridgeCatalog({ bridgesDir: dir })
    expect(entries[0]?.description).toMatch(/local bridge/)
  })

  it('skips malformed JSON without throwing', async () => {
    writeFileSync(join(dir, 'broken.json'), '{ not valid json')
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify({
        name: 'Good',
        transport: { url: 'http://127.0.0.1:8888/mcp' },
      }),
    )
    const entries = await readBridgeCatalog({ bridgesDir: dir })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('good')
  })

  it('skips manifests missing required fields (no name)', async () => {
    writeFileSync(
      join(dir, 'no-name.json'),
      JSON.stringify({ transport: { url: 'http://127.0.0.1:1234/mcp' } }),
    )
    expect(await readBridgeCatalog({ bridgesDir: dir })).toEqual([])
  })

  it('skips manifests missing transport.url', async () => {
    writeFileSync(
      join(dir, 'no-url.json'),
      JSON.stringify({ name: 'No URL', transport: { type: 'http' } }),
    )
    expect(await readBridgeCatalog({ bridgesDir: dir })).toEqual([])
  })

  it('ignores non-JSON files in the directory', async () => {
    writeFileSync(join(dir, 'README.md'), '# notes')
    mkdirSync(join(dir, 'subdir'))
    expect(await readBridgeCatalog({ bridgesDir: dir })).toEqual([])
  })
})

describe('resolveBridgeUrl', () => {
  it('returns the URL for a known bridge', async () => {
    writeFileSync(
      join(dir, 'paper.json'),
      JSON.stringify({
        name: 'Paper',
        transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp' },
      }),
    )
    expect(await resolveBridgeUrl('paper', { bridgesDir: dir })).toBe(
      'http://127.0.0.1:29979/mcp',
    )
  })

  it('returns null for an unknown bridge id', async () => {
    expect(await resolveBridgeUrl('ghost', { bridgesDir: dir })).toBeNull()
  })

  it('returns null when the manifest is malformed', async () => {
    writeFileSync(join(dir, 'broken.json'), '{')
    expect(await resolveBridgeUrl('broken', { bridgesDir: dir })).toBeNull()
  })

  it('returns null when the manifest has no URL', async () => {
    writeFileSync(
      join(dir, 'no-url.json'),
      JSON.stringify({ name: 'No URL', transport: {} }),
    )
    expect(await resolveBridgeUrl('no-url', { bridgesDir: dir })).toBeNull()
  })
})
