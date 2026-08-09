import { describe, expect, it } from 'vitest'
import { resolvePluginVersion } from '../../../src/plugin/resolver.js'
import type {
  PluginGrantRecord,
  PluginVersionRecord,
} from '../../../src/storage/plugin-repository.js'

function version(value: string): PluginVersionRecord {
  return {
    pluginId: 'documents',
    version: value,
    manifest: {},
    manifestSha256: `sha256:${'a'.repeat(64)}`,
    packageSha256: `sha256:${'b'.repeat(64)}`,
    packageKey: `packages/documents/${value}`,
    sourceKind: 'builtin',
    trustKind: 'builtin',
    installedAt: '2026-08-09T00:00:00.000Z',
  }
}

function grant(
  scopeKind: PluginGrantRecord['scopeKind'],
  scopeId: string | null,
  decision: PluginGrantRecord['decision'],
  selected: string | null,
): PluginGrantRecord {
  return {
    pluginId: 'documents',
    scopeKind,
    scopeId,
    decision,
    version: selected,
    revision: 1,
    updatedAt: '2026-08-09T00:00:00.000Z',
  }
}

describe('plugin scope resolver', () => {
  it('uses the most-specific applicable allow', () => {
    const result = resolvePluginVersion([
      grant('global', null, 'allow', '1.0.0'),
      grant('workspace', 'work-a', 'allow', '2.0.0'),
      grant('agent', 'writer', 'allow', '3.0.0'),
    ], [version('1.0.0'), version('2.0.0'), version('3.0.0')], {
      workspaceId: 'work-a',
      agentId: 'writer',
    })
    expect(result).toMatchObject({ status: 'enabled', version: { version: '3.0.0' } })
  })

  it('lets any applicable deny act as the central emergency stop', () => {
    expect(resolvePluginVersion([
      grant('global', null, 'allow', '1.0.0'),
      grant('workspace', 'work-a', 'deny', null),
      grant('agent', 'writer', 'allow', '2.0.0'),
    ], [version('1.0.0'), version('2.0.0')], {
      workspaceId: 'work-a',
      agentId: 'writer',
    })).toEqual({ status: 'disabled', reason: 'denied' })
  })
})
