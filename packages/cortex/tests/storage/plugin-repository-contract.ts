import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PluginGrantConflictError,
  PluginMigrationConflictError,
  PluginVersionNotFoundError,
  PluginVersionConflictError,
  canonicalPluginJson,
  sha256,
  type PluginRepository,
  type RegisterPluginVersionInput,
} from '../../src/storage/plugin-repository.js'

export interface PluginRepositoryHarness {
  readonly repository: PluginRepository
  reopen(): Promise<PluginRepository>
  close(): Promise<void>
}

export type PluginRepositoryHarnessFactory = () => Promise<PluginRepositoryHarness>

function version(
  value: string,
  marker = value,
): RegisterPluginVersionInput {
  const manifest = {
    id: 'documents',
    version: value,
    capabilities: [{ id: 'create-document', label: 'Create a document' }],
    marker,
  }
  return {
    pluginId: 'documents',
    version: value,
    manifest,
    manifestSha256: sha256(canonicalPluginJson(manifest)),
    packageSha256: sha256(`package:${marker}`),
    packageKey: `documents/${value}`,
    sourceKind: 'builtin',
    trustKind: 'builtin',
  }
}

/** One behavior suite is mandatory for every production database adapter. */
export function runPluginRepositoryContract(
  name: string,
  createHarness: PluginRepositoryHarnessFactory,
): void {
  describe(`plugin repository contract — ${name}`, () => {
    let harness: PluginRepositoryHarness
    let repository: PluginRepository

    beforeEach(async () => {
      harness = await createHarness()
      repository = harness.repository
    })

    afterEach(async () => {
      await harness.close()
    })

    it('registers immutable versions idempotently and preserves them across restart', async () => {
      const first = await repository.registerVersion(version('1.0.0'))
      expect(await repository.registerVersion(version('1.0.0'))).toEqual(first)
      await repository.registerVersion(version('1.1.0-beta.1'))
      await repository.registerVersion(version('1.1.0'))
      expect((await repository.listVersions('documents')).map(item => item.version))
        .toEqual(['1.1.0', '1.1.0-beta.1', '1.0.0'])

      await expect(repository.registerVersion(version('1.0.0', 'different')))
        .rejects.toBeInstanceOf(PluginVersionConflictError)

      repository = await harness.reopen()
      expect(await repository.getVersion('documents', '1.0.0')).toEqual(first)
    })

    it('uses revisioned global, workspace and agent decisions with idempotent retries', async () => {
      await repository.registerVersion(version('1.0.0'))
      await repository.registerVersion(version('2.0.0'))
      const global = await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '1.0.0',
      }, null)
      expect(global.revision).toBe(1)
      expect(await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '1.0.0',
      }, null)).toEqual(global)

      const upgraded = await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '2.0.0',
      }, 1)
      expect(upgraded.revision).toBe(2)
      expect(await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '2.0.0',
      }, 1)).toEqual(upgraded)

      await expect(repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '1.0.0',
      }, 1)).rejects.toBeInstanceOf(PluginGrantConflictError)

      const denied = await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'global',
        scopeId: null,
        decision: 'deny',
        version: null,
      }, 2)
      expect(denied).toMatchObject({ decision: 'deny', version: null, revision: 3 })

      const workspace = await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'workspace',
        scopeId: 'workspace-a',
        decision: 'allow',
        version: '1.0.0',
      }, null)
      const agent = await repository.putGrant({
        pluginId: 'documents',
        scopeKind: 'agent',
        scopeId: 'writer',
        decision: 'allow',
        version: '2.0.0',
      }, null)
      expect(await repository.getGrant({
        pluginId: 'documents',
        scopeKind: 'workspace',
        scopeId: 'workspace-a',
      })).toEqual(workspace)
      expect(await repository.listGrants('documents')).toEqual([agent, denied, workspace])
    })

    it('rejects allow and deny decisions for an unknown package consistently', async () => {
      await expect(repository.putGrant({
        pluginId: 'missing',
        scopeKind: 'global',
        scopeId: null,
        decision: 'allow',
        version: '1.0.0',
      }, null)).rejects.toBeInstanceOf(PluginVersionNotFoundError)

      await expect(repository.putGrant({
        pluginId: 'missing',
        scopeKind: 'global',
        scopeId: null,
        decision: 'deny',
        version: null,
      }, null)).rejects.toBeInstanceOf(PluginVersionNotFoundError)
    })

    it('records immutable per-version migration evidence idempotently', async () => {
      await repository.registerVersion(version('1.0.0'))
      const input = {
        pluginId: 'documents',
        version: '1.0.0',
        migrationId: '001-initialize',
        migrationSha256: sha256('migration:one'),
      }
      const receipt = await repository.recordMigration(input)
      expect(await repository.recordMigration(input)).toEqual(receipt)
      expect(await repository.listMigrations({
        pluginId: 'documents',
        version: '1.0.0',
      })).toEqual([receipt])
      await expect(repository.recordMigration({
        ...input,
        migrationSha256: sha256('migration:different'),
      })).rejects.toBeInstanceOf(PluginMigrationConflictError)
    })
  })
}
