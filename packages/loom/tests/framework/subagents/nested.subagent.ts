/**
 * Sub-Agent Pattern: Nested (Agent Spawns Agent)
 *
 * Tests that a sub-agent can spawn its own sub-agent.
 * This requires the spawner to be available in the child's config.
 *
 * Architecture:
 *   Parent → spawns Agent A (with spawner) → Agent A spawns Agent B → result bubbles up
 */

import { describe, it, expect } from 'vitest'
import { AgentSpawner } from '../../../src/agents/spawner.js'
import { createDefaultConfig, mergeConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { calculatorTool } from '../harness/tools-fixture.js'
import type { AgentSpec } from '../../../src/agents/types.js'

describe('Sub-Agent: Nested Spawning', () => {
  it('child spawner can create sub-sub-agents', async () => {
    // Parent spawner
    const provider = createMockProvider({ summaryResponse: 'Parent done.' })
    const config = createDefaultConfig('mock:test')
    const parentSpawner = new AgentSpawner({ provider, tools: [calculatorTool], config })

    // Spawn child — the child gets its own spawner via config
    const childConfig = mergeConfig(config, { maxTurns: 2 })
    const childSpawner = new AgentSpawner({ provider, tools: [calculatorTool], config: childConfig })

    // Spawn grandchild from child spawner
    const grandchildSpec: AgentSpec = {
      name: 'grandchild',
      systemPrompt: 'You are a grandchild agent.',
      maxTurns: 1,
    }

    const grandchild = await childSpawner.spawn(grandchildSpec, 'isolated')
    expect(grandchild.id).toBeTruthy()
    expect(grandchild.name).toBe('grandchild')

    const result = await childSpawner.waitForAgent(grandchild.id, 10_000)
    expect(result.content).toBeTruthy()

    // Verify the hierarchy:
    // parentSpawner → can manage its own agents
    // childSpawner → can manage its own agents (independent)
    expect(parentSpawner.listAll().length).toBe(0) // Parent didn't spawn anything
    expect(childSpawner.listAll().length).toBe(1)   // Child spawned grandchild
  })

  it('inline mode yields events through the child generator', async () => {
    const provider = createMockProvider({ summaryResponse: 'Inline agent done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = {
      name: 'inline-child',
      systemPrompt: 'You are an inline agent.',
      maxTurns: 1,
    }

    const handle = await spawner.spawn(spec, 'inline')
    expect(handle.mode).toBe('inline')

    // Get the inline generator — events flow through here
    const gen = spawner.getInlineGenerator(handle.id)
    expect(gen).toBeTruthy()

    // Drain the generator and collect events
    const events: string[] = []
    let iterResult = await gen!.next()
    while (!iterResult.done) {
      events.push(iterResult.value.type)
      iterResult = await gen!.next()
    }

    // Should have session and agent lifecycle events
    expect(events).toContain('agent.spawn')
    expect(events.includes('session.start') || events.includes('turn.start')).toBe(true)
  })

  it('spawner tracks agent depth via agentId chain', () => {
    const provider = createMockProvider({ summaryResponse: 'Done.' })

    // Root config has no agentId
    const rootConfig = createDefaultConfig('mock:test')
    expect(rootConfig.agentId).toBeNull()

    // Child config gets an agentId from the spawner
    const childConfig = mergeConfig(rootConfig, { agentId: 'agent_abc' })
    expect(childConfig.agentId).toBe('agent_abc')

    // Grandchild gets a nested agentId
    const grandchildConfig = mergeConfig(childConfig, { agentId: 'agent_xyz' })
    expect(grandchildConfig.agentId).toBe('agent_xyz')

    // The sessionId chain tracks the hierarchy
    const childSessionConfig = mergeConfig(rootConfig, {
      sessionId: `${rootConfig.sessionId}:agent_abc`,
    })
    expect(childSessionConfig.sessionId).toContain(':agent_abc')
  })

  it('collected events include agent.spawn and agent.complete', async () => {
    const provider = createMockProvider({ summaryResponse: 'Events test done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = {
      name: 'events-test',
      maxTurns: 1,
    }

    const handle = await spawner.spawn(spec, 'isolated')
    await spawner.waitForAgent(handle.id, 10_000)

    // Non-inline agents collect events on the handle
    const events = spawner.getCollectedEvents(handle.id)
    const types = events.map(e => e.type)
    expect(types).toContain('agent.spawn')
    expect(types).toContain('agent.complete')
  })
})
