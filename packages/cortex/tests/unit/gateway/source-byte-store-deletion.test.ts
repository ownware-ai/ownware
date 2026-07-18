import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SourceByteStore,
  SourceByteStoreError,
} from '../../../src/gateway/source-byte-store.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
const SIBLING_SOURCE_ID = '44444444-4444-4444-8444-444444444444'

describe('SourceByteStore deletion', () => {
  let dir: string
  let root: string
  let bytes: SourceByteStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'source-byte-deletion-'))
    root = join(dir, 'source-storage')
    bytes = new SourceByteStore(root)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('removes and independently verifies source-version and upload-owned trees', async () => {
    const versionDir = join(root, 'sources', SOURCE_ID, 'versions', VERSION_ID)
    const quarantineDir = join(root, 'quarantine', 'uploads', UPLOAD_ID)
    await mkdir(versionDir, { recursive: true })
    await mkdir(quarantineDir, { recursive: true })
    await mkdir(join(root, 'staging'), { recursive: true })
    await writeFile(join(versionDir, 'original'), 'synthetic original')
    await writeFile(join(quarantineDir, 'chunk'), 'synthetic chunk')
    await writeFile(join(root, 'staging', `${UPLOAD_ID}.part`), 'synthetic staging')

    await bytes.removeVersionArtifacts(SOURCE_ID, VERSION_ID)
    await bytes.removeUploadArtifacts(UPLOAD_ID)

    await expect(bytes.versionArtifactsAbsent(SOURCE_ID, VERSION_ID)).resolves.toBe(true)
    await expect(bytes.uploadArtifactsAbsent(UPLOAD_ID)).resolves.toBe(true)
  })

  it('refuses traversal identities before touching storage', async () => {
    await expect(bytes.removeVersionArtifacts('../outside', VERSION_ID)).rejects.toMatchObject({
      code: 'storage_inconsistent',
    })
    await expect(bytes.removeUploadArtifacts('../outside')).rejects.toMatchObject({
      code: 'storage_inconsistent',
    })
  })

  it('does not follow a source-directory symlink into a sibling source', async () => {
    const siblingVersionDir = join(
      root, 'sources', SIBLING_SOURCE_ID, 'versions', VERSION_ID,
    )
    await mkdir(siblingVersionDir, { recursive: true })
    const siblingOriginal = join(siblingVersionDir, 'original')
    await writeFile(siblingOriginal, 'sibling evidence')
    await symlink(
      join(root, 'sources', SIBLING_SOURCE_ID),
      join(root, 'sources', SOURCE_ID),
      'dir',
    )

    await expect(bytes.removeVersionArtifacts(SOURCE_ID, VERSION_ID)).rejects.toBeInstanceOf(
      SourceByteStoreError,
    )
    await expect(stat(siblingOriginal)).resolves.toMatchObject({ isFile: expect.any(Function) })
    await expect(lstat(join(root, 'sources', SOURCE_ID))).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    })
  })
})
