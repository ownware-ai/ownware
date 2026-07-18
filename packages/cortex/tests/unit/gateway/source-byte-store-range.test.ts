import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SOURCE_UTF8_RANGE_MAX_BYTES,
  SourceByteStore,
  SourceByteStoreError,
  type SourceUtf8RangeReadInput,
} from '../../../src/gateway/source-byte-store.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_KEY = `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`

describe('SourceByteStore UTF-8 range reads', () => {
  let dir: string
  let root: string
  let objectPath: string
  let bytes: SourceByteStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-byte-range-'))
    root = join(dir, 'source-storage')
    objectPath = join(root, OBJECT_KEY)
    bytes = new SourceByteStore(root)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads exact first, middle, and final byte ranges', async () => {
    const content = Buffer.from('first|café|final')
    await place(content)
    const middleStart = content.indexOf(Buffer.from('café'))
    const finalStart = content.indexOf(Buffer.from('final'))

    await expect(bytes.readPlacedUtf8Range(input(content, 0, 5))).resolves.toEqual({
      text: 'first', byteStart: 0, byteEnd: 5, byteCount: 5,
    })
    await expect(bytes.readPlacedUtf8Range(
      input(content, middleStart, middleStart + Buffer.byteLength('café')),
    )).resolves.toEqual({
      text: 'café',
      byteStart: middleStart,
      byteEnd: middleStart + Buffer.byteLength('café'),
      byteCount: Buffer.byteLength('café'),
    })
    await expect(bytes.readPlacedUtf8Range(
      input(content, finalStart, content.length),
    )).resolves.toEqual({
      text: 'final', byteStart: finalStart, byteEnd: content.length, byteCount: 5,
    })
  })

  it('returns a range exactly at the 64 KiB cap after scanning trailing bytes', async () => {
    const content = Buffer.concat([
      Buffer.alloc(SOURCE_UTF8_RANGE_MAX_BYTES, 'x'),
      Buffer.from('trailing bytes'),
    ])
    await place(content)

    const result = await bytes.readPlacedUtf8Range(
      input(content, 0, SOURCE_UTF8_RANGE_MAX_BYTES),
    )

    expect(Buffer.byteLength(result.text)).toBe(SOURCE_UTF8_RANGE_MAX_BYTES)
    expect(result).toMatchObject({
      byteStart: 0,
      byteEnd: SOURCE_UTF8_RANGE_MAX_BYTES,
      byteCount: SOURCE_UTF8_RANGE_MAX_BYTES,
    })
  })

  it.each([
    ['negative start', -1, 1],
    ['empty range', 1, 1],
    ['reversed range', 2, 1],
    ['end beyond object', 0, 7],
    ['non-integer start', 0.5, 1],
    ['unsafe end', 0, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an invalid %s', async (_label, byteStart, byteEnd) => {
    const content = Buffer.from('abcdef')
    await place(content)

    await expect(bytes.readPlacedUtf8Range({
      ...input(content, 0, 1),
      byteStart,
      byteEnd,
    })).rejects.toMatchObject({
      code: 'range_invalid',
      message: 'range_invalid',
    })
  })

  it('rejects an unsafe expected full byte count', async () => {
    const content = Buffer.from('abcdef')
    await place(content)

    await expect(bytes.readPlacedUtf8Range({
      ...input(content, 0, 1),
      expectedByteCount: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toMatchObject({ code: 'range_invalid', message: 'range_invalid' })
  })

  it('rejects a range above the cap', async () => {
    const content = Buffer.alloc(SOURCE_UTF8_RANGE_MAX_BYTES + 1, 'x')
    await place(content)

    await expect(bytes.readPlacedUtf8Range(input(content, 0, content.length)))
      .rejects.toMatchObject({
        code: 'range_too_large',
        message: 'range_too_large',
      })
  })

  it('rejects a range that splits a valid multibyte sequence', async () => {
    const content = Buffer.from('AéB')
    await place(content)

    await expect(bytes.readPlacedUtf8Range(input(content, 1, 2))).rejects.toMatchObject({
      code: 'format_invalid',
      message: 'format_invalid',
    })
  })

  it('validates UTF-8 across the full object, not only the selected range', async () => {
    const content = Buffer.from([0x6f, 0x6b, 0xff])
    await place(content)

    await expect(bytes.readPlacedUtf8Range(input(content, 0, 2))).rejects.toMatchObject({
      code: 'format_invalid',
    })
  })

  it('stops a full-object scan at the fixed inspection size limit', async () => {
    const content = Buffer.alloc(16 * 1024 * 1024 + 1, 'x')
    await place(content)

    await expect(bytes.readPlacedUtf8Range(input(content, 0, 1))).rejects.toMatchObject({
      code: 'inspection_too_large',
      message: 'inspection_too_large',
    })
  })

  it('does not release selected bytes when same-length tampering is found at checksum', async () => {
    const expected = Buffer.from('safe selected bytes|expected suffix')
    const tampered = Buffer.from('safe selected bytes|tampered suffix')
    expect(tampered.length).toBe(expected.length)
    await place(tampered)

    const outcome = await bytes.readPlacedUtf8Range(input(expected, 0, 19)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    expect(outcome).not.toHaveProperty('value')
    expect(outcome).toMatchObject({
      error: {
        code: 'object_mismatch',
        message: 'object_mismatch',
      },
    })
    expect((outcome as { error: SourceByteStoreError }).error).not.toHaveProperty('text')
  })

  it('rejects a full-object byte-count mismatch after scanning', async () => {
    const content = Buffer.from('actual')
    await place(content)

    await expect(bytes.readPlacedUtf8Range({
      ...input(content, 0, 1),
      expectedByteCount: content.length + 1,
    })).rejects.toMatchObject({ code: 'object_mismatch', message: 'object_mismatch' })
  })

  it('rejects a symlink at the final object', async () => {
    const content = Buffer.from('outside content')
    const outside = join(dir, 'outside.txt')
    await writeFile(outside, content)
    await mkdir(dirname(objectPath), { recursive: true })
    await symlink(outside, objectPath, 'file')

    await expect(bytes.readPlacedUtf8Range(input(content, 0, content.length)))
      .rejects.toMatchObject({ code: 'storage_inconsistent' })
  })

  it('rejects a symlink in the object path', async () => {
    const content = Buffer.from('outside content')
    const outsideSource = join(dir, 'outside-source')
    const outsideObject = join(outsideSource, 'versions', VERSION_ID, 'original')
    await mkdir(dirname(outsideObject), { recursive: true })
    await writeFile(outsideObject, content)
    await mkdir(join(root, 'sources'), { recursive: true })
    await symlink(outsideSource, join(root, 'sources', SOURCE_ID), 'dir')

    await expect(bytes.readPlacedUtf8Range(input(content, 0, content.length)))
      .rejects.toMatchObject({ code: 'storage_inconsistent' })
  })

  it('rejects non-regular objects', async () => {
    const content = Buffer.from('directory is not content')
    await mkdir(objectPath, { recursive: true })

    await expect(bytes.readPlacedUtf8Range(input(content, 0, content.length)))
      .rejects.toMatchObject({ code: 'storage_inconsistent' })
  })

  it('returns a safe typed error for a missing object', async () => {
    const content = Buffer.from('missing')

    await expect(bytes.readPlacedUtf8Range(input(content, 0, content.length)))
      .rejects.toMatchObject({
        code: 'object_missing',
        message: 'object_missing',
      })
  })

  it('rejects an object-key escape without exposing it in the error', async () => {
    const content = Buffer.from('private')
    const objectKey = '../../../private-object'

    const error = await bytes.readPlacedUtf8Range({
      ...input(content, 0, content.length),
      objectKey,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'storage_inconsistent',
      message: 'storage_inconsistent',
    })
    expect((error as Error).message).not.toContain(objectKey)
  })

  function input(
    content: Buffer,
    byteStart: number,
    byteEnd: number,
  ): SourceUtf8RangeReadInput {
    return {
      objectKey: OBJECT_KEY,
      expectedByteCount: content.length,
      expectedChecksum: checksum(content),
      byteStart,
      byteEnd,
    }
  }

  async function place(content: Buffer): Promise<void> {
    await mkdir(dirname(objectPath), { recursive: true })
    await writeFile(objectPath, content)
  }
})

function checksum(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
