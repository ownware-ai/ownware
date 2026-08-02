import { afterEach, describe, expect, test } from 'vitest'
import type { CoreStorageRepositories } from '../../src/storage/core-repositories.js'
import type { GatewayRepositories } from '../../src/storage/gateway-repositories.js'

export interface GatewayRepositoryHarness {
  readonly repositories: GatewayRepositories
  readonly core: CoreStorageRepositories
  reopen(): Promise<void>
  close(): Promise<void>
}

export function runGatewayRepositoryContract(
  label: string,
  createHarness: () => Promise<GatewayRepositoryHarness>,
): void {
  describe(`${label} gateway repositories`, () => {
    let harness: GatewayRepositoryHarness | undefined

    afterEach(async () => {
      await harness?.close()
      harness = undefined
    })

    test('preserves workspace and MCP inventory semantics across reopen', async () => {
      harness = await createHarness()
      const workspace = await harness.repositories.workspaces.create('/tmp/ownware-contract', 'Contract')
      const thread = await harness.core.threads.create('profile-a', 'Thread', workspace.id)

      expect(await harness.repositories.workspaces.get(workspace.id)).toEqual(workspace)
      expect(await harness.repositories.workspaces.getByPath(workspace.path)).toEqual(workspace)
      expect((await harness.repositories.workspaces.list('active')).items).toEqual([workspace])
      expect(await harness.repositories.workspaces.listThreads(workspace.id)).toEqual([thread])
      expect(await harness.repositories.workspaces.detail(workspace.id)).toMatchObject({
        id: workspace.id,
        activeThreads: 1,
        totalThreads: 1,
      })

      const updated = await harness.repositories.workspaces.update(workspace.id, {
        pinned: true,
        activeProducts: ['ownware', 'contract'],
      })
      expect(updated).toMatchObject({ pinned: true, activeProducts: ['ownware', 'contract'] })
      await harness.repositories.workspaces.touch(workspace.id)

      const server = await harness.repositories.mcpServers.create({
        id: 'mcp-contract',
        name: 'Contract MCP',
        transport: 'stdio',
        command: 'contract-command',
        args: ['--safe'],
        env: { API_TOKEN: '' },
        headers: { 'x-contract': 'yes' },
        registryId: 'registry-contract',
      })
      expect(server).toMatchObject({
        id: 'mcp-contract',
        args: ['--safe'],
        env: { API_TOKEN: '' },
      })
      await harness.repositories.mcpServers.assignToProfile(server.id, 'profile-a')
      await harness.repositories.mcpServers.assignToProfile(server.id, 'profile-a')
      expect((await harness.repositories.mcpServers.get(server.id))?.profileIds).toEqual(['profile-a'])
      expect((await harness.repositories.mcpServers.list()).items[0]?.profileIds).toEqual(['profile-a'])
      expect(await harness.repositories.mcpServers.listForProfile('profile-a')).toHaveLength(1)
      expect(await harness.repositories.mcpServers.update(server.id, {
        status: 'connected',
        toolCount: 2,
        toolsJson: JSON.stringify([{ name: 'read', description: 'Read' }]),
      })).toMatchObject({ status: 'connected', toolCount: 2 })

      await harness.reopen()
      expect(await harness.repositories.workspaces.get(workspace.id)).toMatchObject({ pinned: true })
      expect(await harness.repositories.workspaces.listThreads(workspace.id)).toHaveLength(1)
      expect(await harness.repositories.mcpServers.listForProfile('profile-a')).toHaveLength(1)
      expect(await harness.repositories.mcpServers.removeFromProfile(server.id, 'profile-a')).toBe(true)
      expect(await harness.repositories.mcpServers.removeFromProfile(server.id, 'profile-a')).toBe(false)
      expect(await harness.repositories.mcpServers.delete(server.id)).toBe(true)
      expect(await harness.repositories.mcpServers.delete(server.id)).toBe(false)
    })

    test('preserves profile preferences, audit and portable diagnostics', async () => {
      harness = await createHarness()
      const local = await harness.repositories.localProfile.create('Owner')
      expect(await harness.repositories.localProfile.update(local.id, {
        displayName: 'Owner Updated',
        avatarUrl: 'https://example.invalid/avatar.png',
      })).toMatchObject({ displayName: 'Owner Updated' })

      expect(await harness.repositories.settings.set('theme', 'dark')).toMatchObject({
        key: 'theme',
        value: 'dark',
      })
      expect(await harness.repositories.settings.set('theme', 'light')).toMatchObject({ value: 'light' })
      expect(await harness.repositories.settings.list()).toHaveLength(1)

      expect(await harness.repositories.profileMetadata.set('profile-a', {
        icon: 'spark',
        color: '#123456',
      })).toMatchObject({ icon: 'spark', color: '#123456', category: null })
      expect(await harness.repositories.profileMetadata.set('profile-a', {
        category: 'work',
      })).toMatchObject({ icon: 'spark', color: '#123456', category: 'work' })

      await harness.repositories.appState.set('layout', 'wide')
      await harness.repositories.appState.setWorkspaceSideTrackWidth('workspace-a', 720)
      expect(await harness.repositories.appState.get('layout')).toMatchObject({ value: 'wide' })
      expect(await harness.repositories.appState.getWorkspaceSideTrackWidth('workspace-a')).toBe(720)

      const audit = await harness.repositories.auditLog.add({
        action: 'contract.checked',
        entityType: 'repository',
        entityId: 'gateway',
      })
      expect(audit).toMatchObject({ action: 'contract.checked', entityId: 'gateway' })

      const workspace = await harness.repositories.workspaces.create('/tmp/export-contract')
      const thread = await harness.core.threads.create('profile-a', 'Exported', workspace.id)
      await harness.core.messages.add(thread.id, {
        id: 'message-contract',
        role: 'user',
        content: 'portable',
        timestamp: '2026-08-02T09:00:00.000Z',
      })
      await harness.core.usage.add({
        threadId: thread.id,
        profileId: 'profile-a',
        model: 'test-model',
        provider: 'test-provider',
        inputTokens: 2,
        outputTokens: 3,
        costUsd: 0.5,
      })

      expect(await harness.repositories.diagnostics.stats()).toMatchObject({
        threadCount: 1,
        messageCount: 1,
        usageRecordCount: 1,
      })
      expect((await harness.repositories.diagnostics.stats()).databaseSizeBytes).toBeGreaterThan(0)
      expect(await harness.repositories.diagnostics.threadCount()).toBe(1)
      expect(await harness.repositories.diagnostics.exportAll()).toMatchObject({
        threads: [{ id: thread.id }],
        messages: { [thread.id]: [{ id: 'message-contract', content: 'portable' }] },
        workspaces: [{ id: workspace.id }],
        settings: [{ key: 'theme', value: 'light' }],
        usage: { totalTokens: 5, totalCost: 0.5, recordCount: 1 },
      })

      await harness.reopen()
      expect(await harness.repositories.localProfile.get()).toMatchObject({
        displayName: 'Owner Updated',
      })
      expect(await harness.repositories.settings.get('theme')).toMatchObject({ value: 'light' })
      expect(await harness.repositories.profileMetadata.list()).toHaveLength(1)
      expect(await harness.repositories.appState.getWorkspaceSideTrackWidth('workspace-a')).toBe(720)
      expect(await harness.repositories.settings.delete('theme')).toBe(true)
      expect(await harness.repositories.settings.delete('theme')).toBe(false)
    })
  })
}
