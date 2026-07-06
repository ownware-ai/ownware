/**
 * MCP Test: Tool Call via LLM
 *
 * Tests that a real LLM can discover and call MCP tools through
 * a Loom session. The echo server tools are exposed to the model
 * and the model calls them to complete a task.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session, resolveProvider, createDefaultConfig, mergeConfig, MCPManager } from '../../../src/index.js'
import type { MCPServerConfig } from '../../../src/mcp/types.js'
import { collectEvents } from '../harness/event-collector.js'
import { createSandbox, type Sandbox } from '../harness/sandbox.js'
import {
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
  assertHasUsage,
} from '../harness/assertions.js'
import { FixtureRecorder } from '../harness/fixture-recorder.js'

const __filename2 = fileURLToPath(import.meta.url)
const __dirname2 = dirname(__filename2)
const ECHO_SERVER = join(__dirname2, '..', '..', '..', 'src', '__tests__', 'e2e', 'mcp-echo-server.ts')

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('MCP: LLM Tool Call', () => {
  let manager: MCPManager
  let sandbox: Sandbox
  const recorder = new FixtureRecorder({ enabled: true })

  afterEach(async () => {
    if (manager) await manager.shutdown()
    if (sandbox) await sandbox.cleanup()
    await recorder.flush()
  })

  it('LLM calls MCP echo tool and uses the result', async () => {
    sandbox = await createSandbox()
    manager = new MCPManager()
    await manager.addServers([{
      name: 'echo',
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', ECHO_SERVER],
    } as MCPServerConfig])

    const mcpTools = manager.getAdaptedTools()
    expect(mcpTools.length).toBeGreaterThan(0)

    const model = 'anthropic:claude-sonnet-4-20250514'
    const { provider } = resolveProvider(model)
    const config = mergeConfig(createDefaultConfig(model), {
      model,
      maxTurns: 3,
      maxTokens: 256,
      systemPrompt:
        'You have MCP tools available. Use mcp__echo__echo to echo messages, ' +
        'mcp__echo__reverse to reverse strings, mcp__echo__uppercase to uppercase. ' +
        'ALWAYS use these tools when asked.',
      workspacePath: sandbox.path,
    })

    const session = new Session({ config, provider, tools: mcpTools })

    const stream = await collectEvents(
      session.submitMessage(
        'Use the mcp__echo__reverse tool to reverse the string "FRAMEWORK_TEST". Report the result.',
      ),
      60_000,
    )

    recorder.record('mcp-tool-call-reverse', stream, {
      prompt: 'Reverse FRAMEWORK_TEST via MCP echo server',
      expectedBehavior: 'mcp__echo__reverse called → returns TSET_KROWEMARF',
    })

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'mcp__echo__reverse')
    assertToolSucceeded(stream, 'mcp__echo__reverse')

    // The reversed string
    assertTextContains(stream, 'TSET_KROWEMARF')
    assertHasUsage(stream)
  }, 30_000)

  it('LLM calls multiple MCP tools in sequence', async () => {
    sandbox = await createSandbox()
    manager = new MCPManager()
    await manager.addServers([{
      name: 'echo',
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', ECHO_SERVER],
    } as MCPServerConfig])

    const mcpTools = manager.getAdaptedTools()
    const model = 'anthropic:claude-sonnet-4-20250514'
    const { provider } = resolveProvider(model)
    const config = mergeConfig(createDefaultConfig(model), {
      model,
      maxTurns: 5,
      maxTokens: 512,
      systemPrompt:
        'You have MCP tools: mcp__echo__echo, mcp__echo__reverse, mcp__echo__uppercase. ' +
        'Use the tools as instructed. ALWAYS use tools, never compute manually.',
      workspacePath: sandbox.path,
    })

    const session = new Session({
      config,
      provider,
      tools: mcpTools,
      checkPermission: async () => 'allow',
      requestApproval: async () => true,
    })

    const stream = await collectEvents(
      session.submitMessage(
        'First use mcp__echo__uppercase on "hello world", ' +
        'then use mcp__echo__echo to echo "MCP_WORKS". Report both results.',
      ),
      60_000,
    )

    recorder.record('mcp-tool-call-multi', stream, {
      prompt: 'Uppercase then echo via MCP',
      expectedBehavior: 'mcp__echo__uppercase → HELLO WORLD, mcp__echo__echo → MCP_WORKS',
    })

    assertStreamCompleted(stream)

    // Should have called at least 2 MCP tools
    const tools = stream.tools()
    const mcpCalls = tools.filter(t => t.toolName.startsWith('mcp__echo__'))
    expect(mcpCalls.length).toBeGreaterThanOrEqual(2)
    expect(mcpCalls.every(c => !c.isError)).toBe(true)

    assertHasUsage(stream)
  }, 60_000)
})
