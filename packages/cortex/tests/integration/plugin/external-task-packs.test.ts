import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemPromptToText, type ToolContext, type ToolResult } from '@ownware/loom'
import { PluginService } from '../../../src/plugin/service.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { SqliteStorageAdapter } from '../../../src/storage/sqlite-adapter.js'
import { createSqlitePluginRepository } from '../../../src/storage/sqlite-plugin-repository.js'
import type { PluginRepository } from '../../../src/storage/plugin-repository.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

const taskPackDirectories = (process.env['OWNWARE_TEST_TASK_PACK_DIRS'] ?? '')
  .split(delimiter)
  .map(value => value.trim())
  .filter(Boolean)

interface ExpectedManifest {
  readonly id: string
  readonly version: string
  readonly schemaVersion: number
  readonly display: { readonly icon: string; readonly composerIcon?: string }
  readonly tasks: readonly {
    readonly id: string
    readonly references: readonly string[]
    readonly resources?: readonly { readonly path: string }[]
  }[]
}

if (taskPackDirectories.length === 0) {
  describe.skip('external task-pack journey', () => {
    it('requires OWNWARE_TEST_TASK_PACK_DIRS', () => {})
  })
} else {
  describe('external task-pack journey', () => {
    let root: string
    let dataDir: string
    let adapter: SqliteStorageAdapter<{ readonly plugins: PluginRepository }, object>
    let service: PluginService
    let expected: readonly ExpectedManifest[]

    beforeAll(async () => {
      expected = await Promise.all(taskPackDirectories.map(async directory =>
        JSON.parse(await readFile(join(directory, 'ownware-plugin.json'), 'utf8')) as ExpectedManifest,
      ))
      root = await mkdtemp(join(tmpdir(), 'ownware-external-task-packs-'))
      dataDir = join(root, 'data')
      adapter = new SqliteStorageAdapter({
        dbPath: join(root, 'ownware.db'),
        openMode: 'eager',
        repositories: {
          createRoot: context => ({ plugins: createSqlitePluginRepository(context) }),
          createTransaction: () => ({}),
        },
      })
      service = new PluginService(dataDir, adapter.repositories.plugins)
      await service.initialize(taskPackDirectories)
    })

    afterAll(async () => {
      await adapter.close()
      await rm(root, { recursive: true, force: true })
    })

    it('installs the real packages, icons, references and unique skills', async () => {
      const catalog = await service.catalog()
      expect(catalog.map(entry => entry.id).sort())
        .toEqual(expected.map(manifest => manifest.id).sort())
      for (const entry of catalog) {
        expect(entry.display).toMatchObject({
          category: 'documents-files',
          iconSvg: expect.stringContaining('viewBox="0 0 24 24"'),
          composerIconDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        })
      }

      const resolved = await service.resolveSkills({ agentId: 'artifact-worker' })
      const expectedTaskIds = expected.flatMap(manifest => manifest.tasks.map(task => task.id)).sort()
      expect(resolved.skills.map(skill => skill.name).sort()).toEqual(expectedTaskIds)
      expect(new Set(expectedTaskIds).size).toBe(expectedTaskIds.length)
      expect(resolved.skills.every(skill => skill.content.includes('## Bundled references'))).toBe(true)
      expect(resolved.skills.every(skill => skill.content.includes('## Verified package resources')))
        .toBe(true)

      const fixture = await createMinimalProfile({ tools: { preset: 'coding' } })
      try {
        const profile = await loadProfile(fixture.dir)
        const assembled = await assembleAgent(profile, { additionalSkills: resolved.skills })
        const prompt = systemPromptToText(assembled.systemPrompt)
        const skillTool = assembled.tools.find(tool => tool.name === 'skill')
        expect(skillTool).toBeDefined()

        for (const taskId of expectedTaskIds) {
          expect(prompt).toContain(`/${taskId}`)
          const result = await skillTool!.execute(
            { name: taskId, args: `exercise ${taskId}` },
            {} as ToolContext,
          ) as ToolResult
          expect(result).toMatchObject({
            isError: false,
            metadata: { skillName: taskId },
          })
          expect(result.content).toContain('## Bundled references')
          expect(result.content).toContain('## Verified package resources')
          expect(result.content).toContain(`exercise ${taskId}`)
        }
      } finally {
        await fixture.cleanup()
      }

      for (const manifest of expected) {
        expect(manifest.schemaVersion).toBe(3)
        const installedIcon = join(
          dataDir,
          'plugins',
          'packages',
          manifest.id,
          manifest.version,
          ...manifest.display.icon.split('/'),
        )
        await expect(readFile(installedIcon, 'utf8')).resolves.toContain('viewBox="0 0 24 24"')
        if (manifest.display.composerIcon !== undefined) {
          const installedComposerIcon = join(
            dataDir,
            'plugins',
            'packages',
            manifest.id,
            manifest.version,
            ...manifest.display.composerIcon.split('/'),
          )
          expect((await readFile(installedComposerIcon)).byteLength).toBeGreaterThan(0)
        }
      }
    })

    it('removes exactly one denied pack from a workspace agent', async () => {
      const denied = expected[0]!
      await service.setGrant({
        pluginId: denied.id,
        scopeKind: 'workspace',
        scopeId: 'restricted',
        decision: 'deny',
        version: null,
      }, null)
      const resolved = await service.resolveSkills({
        agentId: 'artifact-worker',
        workspaceId: 'restricted',
      })
      const deniedTasks = new Set(denied.tasks.map(task => task.id))
      expect(resolved.skills.some(skill => deniedTasks.has(skill.name))).toBe(false)
      expect(resolved.skills).toHaveLength(
        expected.reduce((count, manifest) => count + manifest.tasks.length, 0) - denied.tasks.length,
      )
    })
  })
}
