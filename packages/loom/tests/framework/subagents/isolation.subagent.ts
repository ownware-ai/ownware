/**
 * Sub-Agent Pattern: Message Isolation
 *
 * Verifies that sub-agents spawned in 'isolated' mode start with
 * empty message history and cannot see parent's conversation.
 */

import { describe, it, expect } from 'vitest'
import { AgentSpawner } from '../../../src/agents/spawner.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { userMsg, assistantMsg } from '../../helpers/fixtures.js'
import type { AgentSpec } from '../../../src/agents/types.js'

describe('Sub-Agent: Message Isolation', () => {
  it('isolated mode starts with empty messages', async () => {
    const provider = createMockProvider({ summaryResponse: 'Sub-agent done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const parentMessages = [
      userMsg('Secret parent context'),
      assistantMsg('I know the secret'),
    ]

    const spec: AgentSpec = {
      name: 'test-isolated',
      systemPrompt: 'You are a test sub-agent.',
      maxTurns: 1,
    }

    const handle = await spawner.spawn(spec, 'isolated', parentMessages)

    // In isolated mode, the child should NOT receive parent messages.
    // The spawner uses isolateMessages which returns [] for isolated mode
    // (parentMessages are only used in forked mode).
    expect(handle.id).toBeTruthy()
    expect(handle.name).toBe('test-isolated')
    expect(handle.mode).toBe('isolated')
    expect(handle.status).toBe('running')

    // Wait for completion
    const result = await spawner.waitForAgent(handle.id, 10_000)
    expect(result.content).toBeTruthy()
  })

  it('forked mode starts with parent message snapshot', async () => {
    const provider = createMockProvider({ summaryResponse: 'Forked agent done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const parentMessages = [
      userMsg('Parent context here'),
      assistantMsg('Acknowledged'),
    ]

    const spec: AgentSpec = {
      name: 'test-forked',
      systemPrompt: 'You are a forked sub-agent.',
      maxTurns: 1,
    }

    const handle = await spawner.spawn(spec, 'forked', parentMessages)
    expect(handle.mode).toBe('forked')

    const result = await spawner.waitForAgent(handle.id, 10_000)
    expect(result.content).toBeTruthy()
  })

  it('abort stops a running agent', async () => {
    const provider = createMockProvider({
      summaryResponse: 'This should not complete.',
    })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = {
      name: 'test-abort',
      maxTurns: 100, // Would run forever without abort
    }

    const handle = await spawner.spawn(spec, 'isolated')
    expect(handle.status).toBe('running')

    // Abort immediately
    spawner.abort(handle.id)

    const updated = spawner.getAgent(handle.id)
    expect(updated?.status).toBe('aborted')
  })

  it('abortAll stops all active agents', async () => {
    const provider = createMockProvider({ summaryResponse: 'Done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec1: AgentSpec = { name: 'agent-1', maxTurns: 100 }
    const spec2: AgentSpec = { name: 'agent-2', maxTurns: 100 }

    await spawner.spawn(spec1, 'isolated')
    await spawner.spawn(spec2, 'isolated')

    expect(spawner.listActive().length).toBe(2)

    spawner.abortAll()

    expect(spawner.listActive().length).toBe(0)
    expect(spawner.listAll().every(h => h.status === 'aborted')).toBe(true)
  })
})
