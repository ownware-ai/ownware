/**
 * ConnectorsToolProvider — Phase 5-B.2 tests.
 *
 * Verifies the provider contributes the connectors() tool, threads
 * the profile name through to the registry-backed deps, and
 * respects the optional enabledSources / maxItems settings.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectorRegistry } from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { ConnectorsToolProvider } from '../../../src/connector/providers/connectors-tool-provider.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import type { ConnectorAgentToolResult } from '../../../src/connector/agent-tool-results.js'
import { createTempProfile } from '../../helpers/fixtures.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-ctp-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
})

async function buildOneProfile(): Promise<{
  profile: Awaited<ReturnType<ProfileRegistry['get']>>
  registry: ConnectorRegistry
  cleanup: () => Promise<void>
}> {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-ctp-prof-'))
  const { dir: profileDir, cleanup } = await createTempProfile({
    'agent.json': JSON.stringify({
      name: 'test-agent',
      tools: { mcp: {} },
    }),
  })
  const { rename, mkdir } = await import('node:fs/promises')
  await mkdir(parent, { recursive: true })
  const finalPath = join(parent, 'test-agent')
  await rename(profileDir, finalPath)
  const profileRegistry = new ProfileRegistry()
  await profileRegistry.discover(parent)
  const profile = await profileRegistry.get('test-agent')
  const registry = new ConnectorRegistry(profileRegistry)
  return {
    profile,
    registry,
    cleanup: async () => {
      await cleanup().catch(() => undefined)
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

describe('ConnectorsToolProvider', () => {
  it('contributes exactly one tool named "connectors"', async () => {
    const { profile, registry, cleanup } = await buildOneProfile()
    try {
      const provider = new ConnectorsToolProvider({ registry })
      const result = await provider.getToolsForProfile(profile, {
        existingTools: [],
      })
      expect(result.tools.length).toBe(1)
      expect(result.tools[0]?.name).toBe('connectors')
      expect(result.stubs.length).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('threads profile.config.name through to the tool deps', async () => {
    const { profile, registry, cleanup } = await buildOneProfile()
    try {
      const provider = new ConnectorsToolProvider({ registry })
      const result = await provider.getToolsForProfile(profile, {
        existingTools: [],
      })
      const tool = result.tools[0]!
      // Run list_attached; the tool resolves connectors via
      // registry.listForProfile(profileId). The wiring is correct
      // if the call runs without throwing a "profile not found"
      // error and returns a connector_attached_list. (Pre-2026-05-12
      // this test used the search action; that action was removed.)
      const out = (await tool.execute(
        { action: 'list_attached' },
        {} as never,
      )) as { content: string; metadata?: { connectorAgentResult?: ConnectorAgentToolResult } }
      const meta = out.metadata?.connectorAgentResult
      expect(meta?.type).toBe('connector_attached_list')
    } finally {
      await cleanup()
    }
  })

  // The "passes enabledSources through so suggestion banners reflect user
  // state" test was removed 2026-05-12. The enabledSources option and the
  // suggestion-banner pass it fed both retired alongside the search action.

  it('exposes source identifier "connectors" for assembler routing', async () => {
    const { profile, registry, cleanup } = await buildOneProfile()
    try {
      const provider = new ConnectorsToolProvider({ registry })
      expect(provider.source).toBe('connectors')
      // Drain the result so the registry's listForProfile cache
      // doesn't leak across the test.
      await provider.getToolsForProfile(profile, { existingTools: [] })
    } finally {
      await cleanup()
    }
  })
})
