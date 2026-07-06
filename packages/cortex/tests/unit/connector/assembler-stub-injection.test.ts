/**
 * Assembler stub-tool injection test.
 *
 * Verifies that when a profile references an MCP server with an
 * unresolved `${VAR}` in its config, the assembler:
 *   1. Does NOT throw.
 *   2. Continues to produce a valid tool list including built-ins.
 *   3. Emits a stub Tool for the not-ready server.
 *   4. The stub's execute() returns a ToolResult whose
 *      metadata.kind === 'connector_not_ready' with the correct
 *      connectorId.
 *
 * This is the agent-loop-level contract Milestone 2 (Composio) and
 * the client's "Connect …" card will key off of.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { ConnectorNotReadyErrorSchema } from '../../../src/connector/schema.js'
import { createTempProfile } from '../../helpers/fixtures.js'
import type { ToolContext, ToolResult } from '@ownware/loom'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-asmstub-'))
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

function fakeContext(): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: process.cwd(),
    config: {} as ToolContext['config'],
    requestPermission: async () => true,
  }
}

describe('assembler — stub tool injection for not-ready MCP connector', () => {
  it('injects a stub when an MCP server has an unresolved required env var', async () => {
    // Make sure the referenced env var is NOT set.
    const prev = process.env['CREDS_MISSING_TEST_TOKEN']
    delete process.env['CREDS_MISSING_TEST_TOKEN']

    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'stub-probe',
        tools: {
          preset: 'none',
          mcp: {
            'notion-like-server': {
              transport: 'stdio',
              command: 'echo',
              args: [],
              env: { TOKEN: '${CREDS_MISSING_TEST_TOKEN}' },
            },
          },
        },
      }),
    })

    try {
      const profile = await loadProfile(dir)
      const agent = await assembleAgent(profile)

      const stub = agent.tools.find(t => t.name === 'notion-like-server')
      expect(stub).toBeDefined()
      expect(stub!.isReadOnly).toBe(true)
      expect(stub!.description).toContain('[NOT CONNECTED]')

      const result = await (stub!.execute({}, fakeContext()) as Promise<ToolResult>)
      expect(result.isError).toBe(true)
      const parsed = ConnectorNotReadyErrorSchema.parse(result.metadata)
      expect(parsed.kind).toBe('connector_not_ready')
      expect(parsed.connectorId).toBe('notion-like-server')
      expect(parsed.source).toBe('mcp')
      expect(parsed.reason.length).toBeGreaterThan(0)

      // Agent should shut down any MCP manager it happened to allocate.
      await agent.mcpManager?.shutdown().catch(() => undefined)
    } finally {
      if (prev !== undefined) process.env['CREDS_MISSING_TEST_TOKEN'] = prev
      await cleanup()
    }
  })

  it('sanitizes server ids containing `.` or `/` for the stub tool name', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'stub-probe-2',
        tools: {
          preset: 'none',
          mcp: {
            'io.github.example/thing': {
              transport: 'stdio',
              command: 'echo',
              args: [],
              env: { TOK: '${UNSET_FOR_STUB_TEST}' },
            },
          },
        },
      }),
    })
    try {
      const profile = await loadProfile(dir)
      const agent = await assembleAgent(profile)
      // Tool name must match ^[a-zA-Z0-9_-]{1,128}$ (provider requirement).
      const stub = agent.tools.find(t => /^io_github_example_thing$/.test(t.name))
      expect(stub).toBeDefined()
      const result = await (stub!.execute({}, fakeContext()) as Promise<ToolResult>)
      const parsed = ConnectorNotReadyErrorSchema.parse(result.metadata)
      // connectorId preserves the original, unsanitized id.
      expect(parsed.connectorId).toBe('io.github.example/thing')

      await agent.mcpManager?.shutdown().catch(() => undefined)
    } finally {
      await cleanup()
    }
  })
})
