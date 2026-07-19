import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SourceByteStore,
  type PrepareCsvDataViewArtifactInput,
} from '../../../src/gateway/source-byte-store.js'
import { CsvDataViewError } from '../../../src/gateway/csv-data-view.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const VIEW_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_VIEW_ID = '44444444-4444-4444-8444-444444444444'
const OBJECT_KEY = `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`

describe('SourceByteStore CSV Data View artifacts', () => {
  let dir: string
  let root: string
  let originalPath: string
  let store: SourceByteStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-data-view-'))
    root = join(dir, 'source-storage')
    originalPath = join(root, OBJECT_KEY)
    store = new SourceByteStore(root)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('atomically publishes a private inert artifact and a content-free manifest', async () => {
    const original = Buffer.from('Name,Formula\nAda,=2+2\nBob,"@SUM(1,2)"')
    await place(original)

    const prepared = await store.prepareCsvDataViewArtifact(input(original))

    expect(prepared.privateObjectKey).toBe(
      `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${VIEW_ID}.json`,
    )
    expect(prepared.manifest).toMatchObject({
      dataViewId: VIEW_ID,
      implementationVersion: 'csv_data_view.v1',
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      fieldCount: 2,
      rowCount: 2,
      fields: [
        { ordinal: 0, label: 'Name' },
        { ordinal: 1, label: 'Formula' },
      ],
    })
    expect(JSON.stringify(prepared.manifest)).not.toContain('=2+2')
    expect(JSON.stringify(prepared.manifest)).not.toContain('@SUM')
    expect(prepared.manifest.artifactChecksum).toMatch(/^sha256:[0-9a-f]{64}$/)

    const raw = JSON.parse(await readFile(join(root, prepared.privateObjectKey), 'utf8'))
    expect(raw.rows).toEqual([['Ada', '=2+2'], ['Bob', '@SUM(1,2)']])
    expect(raw).not.toHaveProperty('fieldIds')
    expect(raw).not.toHaveProperty('rowIds')
  })

  it('replays byte-identically and a fresh store reads the verified artifact after restart', async () => {
    const original = Buffer.from('name,note\nAda,"hello, world"')
    await place(original)
    const first = await store.prepareCsvDataViewArtifact(input(original))
    const replay = await store.prepareCsvDataViewArtifact(input(original))

    expect(replay).toEqual(first)
    const restarted = new SourceByteStore(root)
    await expect(restarted.readCsvDataViewArtifact({
      privateObjectKey: first.privateObjectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      artifactChecksum: first.manifest.artifactChecksum,
      artifactByteCount: first.manifest.artifactByteCount,
    })).resolves.toMatchObject({
      sourceVersionId: VERSION_ID,
      fieldCount: 2,
      rowCount: 1,
      rows: [{ ordinal: 0, values: ['Ada', 'hello, world'] }],
    })
  })

  it('selects only requested stable fields and rows after verifying the exact artifact', async () => {
    const original = Buffer.from('name,formula\nAda,=2+2\nBob,@SUM(A1)')
    await place(original)
    const prepared = await store.prepareCsvDataViewArtifact(input(original))
    const formulaId = prepared.manifest.fields[1]!.fieldId

    const result = await store.selectCsvDataViewArtifact({
      privateObjectKey: prepared.privateObjectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      artifactChecksum: prepared.manifest.artifactChecksum,
      artifactByteCount: prepared.manifest.artifactByteCount,
      fieldIds: [formulaId],
      rowOffset: 1,
      rowCount: 1,
    })

    expect(result).toMatchObject({
      returnedRowCount: 1,
      complete: true,
      fields: [{ fieldId: formulaId, ordinal: 1 }],
      rows: [{ ordinal: 1, values: ['@SUM(A1)'] }],
    })
    expect(JSON.stringify(result)).not.toContain('Ada')
    expect(JSON.stringify(result)).not.toContain('=2+2')

    await writeFile(join(root, prepared.privateObjectKey), 'tampered')
    await expect(store.selectCsvDataViewArtifact({
      privateObjectKey: prepared.privateObjectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      artifactChecksum: prepared.manifest.artifactChecksum,
      artifactByteCount: prepared.manifest.artifactByteCount,
      fieldIds: [formulaId],
      rowOffset: 0,
      rowCount: 1,
    })).rejects.toMatchObject({ code: 'data_view_invalid' })
  })

  it('applies one deadline across artifact verification and projection', async () => {
    const original = Buffer.from('name\nAda')
    await place(original)
    const prepared = await store.prepareCsvDataViewArtifact(input(original))
    let ticks = 0

    await expect(store.selectCsvDataViewArtifact({
      privateObjectKey: prepared.privateObjectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      artifactChecksum: prepared.manifest.artifactChecksum,
      artifactByteCount: prepared.manifest.artifactByteCount,
      fieldIds: [prepared.manifest.fields[0]!.fieldId],
      rowOffset: 0,
      rowCount: 1,
    }, () => ticks++ * 1_001)).rejects.toMatchObject({
      code: 'data_view_timeout',
    })
  })

  it('verifies the exact full original before publishing any artifact', async () => {
    const expected = Buffer.from('name\nAda')
    const tampered = Buffer.from('name\nEve')
    await place(tampered)

    await expect(store.prepareCsvDataViewArtifact(input(expected))).rejects.toMatchObject({
      code: 'object_mismatch',
    })
    await expect(store.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, VIEW_ID))
      .resolves.toBe(true)
  })

  it('does not publish hostile malformed CSV or leave a temporary artifact', async () => {
    const original = Buffer.from('a,b\n1')
    await place(original)

    await expect(store.prepareCsvDataViewArtifact(input(original)))
      .rejects.toBeInstanceOf(CsvDataViewError)
    const viewDirectory = join(dirname(originalPath), 'data-views')
    await expect(readFile(viewDirectory)).rejects.toBeDefined()
    await expect(store.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, VIEW_ID))
      .resolves.toBe(true)
  })

  it('refuses a conflicting pre-existing target without overwriting it', async () => {
    const original = Buffer.from('name\nAda')
    await place(original)
    const target = join(
      dirname(originalPath), 'data-views', `${VIEW_ID}.json`,
    )
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, 'conflicting artifact')

    await expect(store.prepareCsvDataViewArtifact(input(original))).rejects.toMatchObject({
      code: 'data_view_invalid',
    })
    await expect(readFile(target, 'utf8')).resolves.toBe('conflicting artifact')
  })

  it('detects artifact tampering and lineage substitution on restart', async () => {
    const original = Buffer.from('name\nAda')
    await place(original)
    const prepared = await store.prepareCsvDataViewArtifact(input(original))
    const artifactPath = join(root, prepared.privateObjectKey)
    const persisted = await readFile(artifactPath)
    await writeFile(artifactPath, Buffer.alloc(persisted.length, 'x'))

    const read = {
      privateObjectKey: prepared.privateObjectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(original),
      artifactChecksum: prepared.manifest.artifactChecksum,
      artifactByteCount: prepared.manifest.artifactByteCount,
    }
    await expect(store.readCsvDataViewArtifact(read)).rejects.toMatchObject({
      code: 'data_view_invalid',
    })
    await expect(store.readCsvDataViewArtifact({ ...read, dataViewId: OTHER_VIEW_ID }))
      .rejects.toMatchObject({ code: 'data_view_invalid' })
  })

  it('rejects a malformed matching-checksum envelope, invalid UTF-8 and missing bytes', async () => {
    const objectKey = `sources/${SOURCE_ID}/versions/${VERSION_ID}/data-views/${VIEW_ID}.json`
    const artifactPath = join(root, objectKey)
    await mkdir(dirname(artifactPath), { recursive: true })
    const malformed = Buffer.from(JSON.stringify({
      schemaVersion: 'ownware.csv-data-view/v1',
      implementationVersion: 'csv_data_view.v1',
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(Buffer.from('source')),
      labels: ['name'],
      rows: [['Ada']],
      undeclared: 'must not survive',
    }))
    await writeFile(artifactPath, malformed)

    const read = {
      privateObjectKey: objectKey,
      dataViewId: VIEW_ID,
      sourceVersionId: VERSION_ID,
      sourceChecksum: checksum(Buffer.from('source')),
      artifactChecksum: checksum(malformed),
      artifactByteCount: malformed.length,
    }
    await expect(store.readCsvDataViewArtifact(read)).rejects.toMatchObject({
      code: 'data_view_invalid',
    })

    const invalidUtf8 = Buffer.from([0xff])
    await writeFile(artifactPath, invalidUtf8)
    await expect(store.readCsvDataViewArtifact({
      ...read,
      artifactChecksum: checksum(invalidUtf8),
      artifactByteCount: invalidUtf8.length,
    })).rejects.toMatchObject({ code: 'data_view_invalid' })

    await rm(artifactPath)
    await expect(store.readCsvDataViewArtifact(read)).rejects.toMatchObject({
      code: 'object_missing',
    })
  })

  it('refuses path escapes and symlinked artifact targets', async () => {
    const original = Buffer.from('name\nAda')
    await place(original)
    const outside = join(dir, 'outside')
    await mkdir(outside)
    await symlink(outside, join(dirname(originalPath), 'data-views'), 'dir')

    await expect(store.prepareCsvDataViewArtifact(input(original))).rejects.toMatchObject({
      code: 'storage_inconsistent',
    })
    await expect(store.removeDataViewArtifact('../outside', VERSION_ID, VIEW_ID))
      .rejects.toMatchObject({ code: 'storage_inconsistent' })
  })

  it('removes one exact artifact and independently verifies absence', async () => {
    const original = Buffer.from('name\nAda')
    await place(original)
    await store.prepareCsvDataViewArtifact(input(original))

    await store.removeDataViewArtifact(SOURCE_ID, VERSION_ID, VIEW_ID)

    await expect(store.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, VIEW_ID))
      .resolves.toBe(true)
    await expect(store.dataViewArtifactAbsent(SOURCE_ID, VERSION_ID, OTHER_VIEW_ID))
      .resolves.toBe(true)
  })

  function input(original: Buffer): PrepareCsvDataViewArtifactInput {
    return {
      objectKey: OBJECT_KEY,
      expectedByteCount: original.length,
      expectedChecksum: checksum(original),
      sourceId: SOURCE_ID,
      sourceVersionId: VERSION_ID,
      dataViewId: VIEW_ID,
    }
  }

  async function place(original: Buffer): Promise<void> {
    await mkdir(dirname(originalPath), { recursive: true })
    await writeFile(originalPath, original)
  }
})

function checksum(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
