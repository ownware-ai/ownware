import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
  SOURCE_UTF8_SEARCH_MAX_MATCHES,
  SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES,
  SourceByteStore,
  type SourceUtf8SearchInput,
} from '../../../src/gateway/source-byte-store.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_KEY = `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`

describe('SourceByteStore bounded UTF-8 search', () => {
  let dir: string
  let root: string
  let objectPath: string
  let store: SourceByteStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-byte-search-'))
    root = join(dir, 'source-storage')
    objectPath = join(root, OBJECT_KEY)
    store = new SourceByteStore(root)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds exact non-ASCII terms with UTF-8-safe context and byte locations', async () => {
    const content = Buffer.from('αα|café|ωω', 'utf8')
    await place(content)
    const matchByteStart = content.indexOf(Buffer.from('café'))

    await expect(store.searchPlacedUtf8({
      ...input(content), query: 'café', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 2,
    })).resolves.toEqual({
      matches: [{
        text: '|café|',
        byteStart: matchByteStart - 1,
        byteEnd: matchByteStart + Buffer.byteLength('café') + 1,
        matchByteStart,
        matchByteEnd: matchByteStart + Buffer.byteLength('café'),
      }],
      truncated: false,
    })
  })

  it('folds ASCII only, returns non-overlapping matches in byte order, and reports truncation', async () => {
    const content = Buffer.from('Alpha alpha ALPHA')
    await place(content)

    await expect(store.searchPlacedUtf8({
      ...input(content), query: 'alpha', matchMode: 'ascii_case_insensitive',
      maxMatches: 2, contextBytes: 0,
    })).resolves.toEqual({
      matches: [
        { text: 'Alpha', byteStart: 0, byteEnd: 5, matchByteStart: 0, matchByteEnd: 5 },
        { text: 'alpha', byteStart: 6, byteEnd: 11, matchByteStart: 6, matchByteEnd: 11 },
      ],
      truncated: true,
    })

    const overlapping = Buffer.from('aaaa')
    await place(overlapping)
    await expect(store.searchPlacedUtf8({
      ...input(overlapping), query: 'aa', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 0,
    })).resolves.toMatchObject({
      matches: [
        { matchByteStart: 0, matchByteEnd: 2 },
        { matchByteStart: 2, matchByteEnd: 4 },
      ],
      truncated: false,
    })
  })

  it('returns an honest empty result when the verified object has no match', async () => {
    const content = Buffer.from('approved source text')
    await place(content)

    await expect(store.searchPlacedUtf8({
      ...input(content), query: 'missing', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 32,
    })).resolves.toEqual({ matches: [], truncated: false })
  })

  it.each([
    ['empty query', { query: '' }],
    ['padded query', { query: ' hidden ' }],
    ['control query', { query: 'hidden\nvalue' }],
    ['oversized query', { query: 'x'.repeat(SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES + 1) }],
    ['non-ASCII folded query', { query: 'café', matchMode: 'ascii_case_insensitive' }],
    ['zero matches', { maxMatches: 0 }],
    ['too many matches', { maxMatches: SOURCE_UTF8_SEARCH_MAX_MATCHES + 1 }],
    ['negative context', { contextBytes: -1 }],
    ['too much context', { contextBytes: SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES + 1 }],
  ])('rejects %s before scanning', async (_label, change) => {
    const content = Buffer.from('approved source text')
    await place(content)

    await expect(store.searchPlacedUtf8({
      ...input(content), query: 'source', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 16, ...change,
    })).rejects.toMatchObject({ code: 'search_invalid' })
  })

  it('withholds every match when full-object checksum verification fails', async () => {
    const expected = Buffer.from('needle|expected suffix')
    const tampered = Buffer.from('needle|tampered suffix')
    expect(tampered.length).toBe(expected.length)
    await place(tampered)

    const outcome = await store.searchPlacedUtf8({
      ...input(expected), query: 'needle', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 0,
    }).then((value) => ({ value }), (error: unknown) => ({ error }))

    expect(outcome).not.toHaveProperty('value')
    expect(outcome).toMatchObject({ error: { code: 'object_mismatch' } })
    expect((outcome as { error: object }).error).not.toHaveProperty('matches')
  })

  it('rejects a symlinked private object without returning passages', async () => {
    const content = Buffer.from('outside needle')
    const outside = join(dir, 'outside.txt')
    await writeFile(outside, content)
    await mkdir(dirname(objectPath), { recursive: true })
    await symlink(outside, objectPath, 'file')

    await expect(store.searchPlacedUtf8({
      ...input(content), query: 'needle', matchMode: 'exact_utf8',
      maxMatches: 5, contextBytes: 0,
    })).rejects.toMatchObject({ code: 'storage_inconsistent' })
  })

  function input(content: Buffer): Pick<
    SourceUtf8SearchInput,
    'objectKey' | 'expectedByteCount' | 'expectedChecksum'
  > {
    return {
      objectKey: OBJECT_KEY,
      expectedByteCount: content.length,
      expectedChecksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    }
  }

  async function place(content: Buffer): Promise<void> {
    await mkdir(dirname(objectPath), { recursive: true })
    await writeFile(objectPath, content, { mode: 0o600 })
  }
})
