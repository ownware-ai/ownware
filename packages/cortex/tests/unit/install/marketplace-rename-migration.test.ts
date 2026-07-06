/**
 * Tests for `migrateMarketplaceInstalledNames` — the one-shot FS shim
 * that renames installed marketplace profile dirs from the pre-PR-B
 * names (counsel/finance/marketing/researcher/sentinel/trading-coach/
 * trading-research) to the ownware-* prefix.
 *
 * Each test seeds a fake userDir, writes a sidecar, runs the shim,
 * and asserts: dir was renamed, sidecar's profileName flipped to the
 * new name, everything else preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  migrateMarketplaceInstalledNames,
  MARKETPLACE_RENAME_MAP,
} from '../../../src/profile/ownware-bundle.js'

const SIDECAR_FILE = '.ownware-origin.json'

let userDir: string

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function seedMarketplaceProfile(opts: {
  readonly userDir: string
  readonly profileName: string
  readonly bundleVersion?: string
  readonly extraFile?: { name: string; body: string }
}): Promise<void> {
  const dir = join(opts.userDir, opts.profileName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, SIDECAR_FILE), JSON.stringify({
    kind: 'ownware-marketplace',
    profileName: opts.profileName,
    bundledFrom: 'ownware-profiles',
    bundleVersion: opts.bundleVersion ?? 'dev',
    installedAt: '2026-05-01T00:00:00.000Z',
    installedHash: 'sha-fake',
  }, null, 2))
  if (opts.extraFile) {
    await writeFile(join(dir, opts.extraFile.name), opts.extraFile.body)
  }
}

beforeEach(async () => {
  userDir = await mkdtemp(join(tmpdir(), 'cortex-mkt-rename-'))
})

afterEach(async () => {
  await rm(userDir, { recursive: true, force: true })
})

describe('migrateMarketplaceInstalledNames', () => {
  it('renames every old marketplace name to its ownware-* equivalent', async () => {
    for (const oldName of Object.keys(MARKETPLACE_RENAME_MAP)) {
      await seedMarketplaceProfile({ userDir, profileName: oldName })
    }

    const result = await migrateMarketplaceInstalledNames(userDir)

    expect(result.failed).toEqual([])
    expect(result.skippedTargetExists).toEqual([])
    expect(result.renamed.length).toBe(Object.keys(MARKETPLACE_RENAME_MAP).length)

    for (const [oldName, newName] of Object.entries(MARKETPLACE_RENAME_MAP)) {
      expect(await exists(join(userDir, oldName))).toBe(false)
      expect(await exists(join(userDir, newName))).toBe(true)
      const sidecarRaw = await readFile(join(userDir, newName, SIDECAR_FILE), 'utf-8')
      const sidecar = JSON.parse(sidecarRaw) as { profileName: string; kind: string; bundleVersion: string }
      expect(sidecar.profileName).toBe(newName)
      expect(sidecar.kind).toBe('ownware-marketplace')
      expect(sidecar.bundleVersion).toBe('dev')
    }
  })

  it('preserves user files inside the renamed profile', async () => {
    await seedMarketplaceProfile({
      userDir,
      profileName: 'counsel',
      extraFile: { name: 'AGENTS.md', body: 'user notes survive rename' },
    })

    await migrateMarketplaceInstalledNames(userDir)

    const body = await readFile(join(userDir, 'ownware-law', 'AGENTS.md'), 'utf-8')
    expect(body).toBe('user notes survive rename')
  })

  it('is idempotent on re-run — second call is a no-op', async () => {
    await seedMarketplaceProfile({ userDir, profileName: 'counsel' })
    const first = await migrateMarketplaceInstalledNames(userDir)
    const second = await migrateMarketplaceInstalledNames(userDir)

    expect(first.renamed).toEqual([{ from: 'counsel', to: 'ownware-law' }])
    expect(second.renamed).toEqual([])
    expect(second.skippedTargetExists).toEqual([])
    expect(second.failed).toEqual([])
  })

  it('skips when both old and new dirs exist (never clobbers user data)', async () => {
    await seedMarketplaceProfile({ userDir, profileName: 'counsel' })
    await seedMarketplaceProfile({ userDir, profileName: 'ownware-law', bundleVersion: 'user-fork' })

    const result = await migrateMarketplaceInstalledNames(userDir)

    expect(result.renamed).toEqual([])
    expect(result.skippedTargetExists).toEqual(['counsel'])
    expect(await exists(join(userDir, 'counsel'))).toBe(true)
    expect(await exists(join(userDir, 'ownware-law'))).toBe(true)
    // ownware-law sidecar untouched — bundleVersion still 'user-fork'.
    const sidecar = JSON.parse(
      await readFile(join(userDir, 'ownware-law', SIDECAR_FILE), 'utf-8'),
    ) as { bundleVersion: string }
    expect(sidecar.bundleVersion).toBe('user-fork')
  })

  it('leaves dirs without a sidecar untouched (user forks)', async () => {
    // No sidecar — pure user-owned dir that happens to share an old name.
    const dir = join(userDir, 'counsel')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'agent.json'), '{"name":"counsel"}')

    const result = await migrateMarketplaceInstalledNames(userDir)

    expect(result.renamed).toEqual([])
    expect(await exists(join(userDir, 'counsel'))).toBe(true)
    expect(await exists(join(userDir, 'ownware-law'))).toBe(false)
  })

  it('leaves dirs with non-marketplace sidecars untouched', async () => {
    const dir = join(userDir, 'finance')
    await mkdir(dir, { recursive: true })
    // Fork-kind sidecar — not ours to rename.
    await writeFile(join(dir, SIDECAR_FILE), JSON.stringify({ kind: 'fork', forkedAt: 'now' }))

    const result = await migrateMarketplaceInstalledNames(userDir)

    expect(result.renamed).toEqual([])
    expect(await exists(join(userDir, 'finance'))).toBe(true)
  })

  it('handles missing userDir gracefully', async () => {
    const result = await migrateMarketplaceInstalledNames(join(userDir, 'does-not-exist'))
    expect(result.renamed).toEqual([])
    expect(result.failed).toEqual([])
  })

  it('ignores unrelated dirs not in the rename map', async () => {
    await seedMarketplaceProfile({ userDir, profileName: 'ownware-browser' }) // not in map
    await seedMarketplaceProfile({ userDir, profileName: 'counsel' })

    const result = await migrateMarketplaceInstalledNames(userDir)

    expect(result.renamed).toEqual([{ from: 'counsel', to: 'ownware-law' }])
    expect(await exists(join(userDir, 'ownware-browser'))).toBe(true)
  })
})
