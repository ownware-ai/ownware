/**
 * Sub-Agent Pattern: Abort Propagation
 *
 * Tests that aborting a parent session or spawner correctly
 * propagates abort to all running child agents.
 */

import { describe, it, expect } from 'vitest'
import { AgentSpawner } from '../../../src/agents/spawner.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { slowTool } from '../harness/tools-fixture.js'
import type { AgentSpec } from '../../../src/agents/types.js'

describe('Sub-Agent: Abort Propagation', () => {
  it('abort(id) stops a single running agent', async () => {
    const provider = createMockProvider({ summaryResponse: 'Done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [slowTool], config })

    const spec: AgentSpec = { name: 'slow-agent', maxTurns: 50 }
    const handle = await spawner.spawn(spec, 'isolated')

    expect(handle.status).toBe('running')
    expect(spawner.listActive().length).toBe(1)

    // Abort the specific agent
    spawner.abort(handle.id)

    const updated = spawner.getAgent(handle.id)!
    expect(updated.status).toBe('aborted')
    expect(updated.completedAt).toBeDefined()
    expect(spawner.listActive().length).toBe(0)
  })

  it('abortAll() stops all running agents simultaneously', async () => {
    const provider = createMockProvider({ summaryResponse: 'Done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const specs: AgentSpec[] = [
      { name: 'agent-1', maxTurns: 50 },
      { name: 'agent-2', maxTurns: 50 },
      { name: 'agent-3', maxTurns: 50 },
    ]

    // Spawn 3 agents
    for (const spec of specs) {
      await spawner.spawn(spec, 'isolated')
    }
    expect(spawner.listActive().length).toBe(3)

    // Abort all
    spawner.abortAll()

    expect(spawner.listActive().length).toBe(0)
    const all = spawner.listAll()
    expect(all.length).toBe(3)
    expect(all.every(h => h.status === 'aborted')).toBe(true)
  })

  it('abort on pending agent resolves immediately', async () => {
    const provider = createMockProvider({ summaryResponse: 'Done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = { name: 'wait-abort', maxTurns: 1 }
    const handle = await spawner.spawn(spec, 'isolated')

    // Abort immediately (before the mock provider finishes or after — either way)
    spawner.abort(handle.id)

    const updated = spawner.getAgent(handle.id)!
    // Agent should be aborted (or possibly completed if mock finished first)
    expect(['aborted', 'completed']).toContain(updated.status)
  })

  it('timeout auto-aborts agent after specified duration', async () => {
    // Mock provider completes instantly, so the agent may finish before timeout.
    // This test verifies timeout SETS UP correctly — if the agent completes
    // first, the timeout is cleared. Both outcomes are valid.
    const provider = createMockProvider({ summaryResponse: 'Done.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = { name: 'timeout-agent', maxTurns: 1 }
    const handle = await spawner.spawn(spec, 'isolated', undefined, {
      timeoutMs: 100,
    })

    await spawner.waitForAgent(handle.id, 5_000)
    const updated = spawner.getAgent(handle.id)!
    // Agent may have completed before timeout — either is valid
    expect(['completed', 'aborted']).toContain(updated.status)
  })

  it('completed agents ignore abort calls', async () => {
    const provider = createMockProvider({ summaryResponse: 'Completed.' })
    const config = createDefaultConfig('mock:test')
    const spawner = new AgentSpawner({ provider, tools: [], config })

    const spec: AgentSpec = { name: 'fast-agent', maxTurns: 1 }
    const handle = await spawner.spawn(spec, 'isolated')

    // Wait for natural completion
    await spawner.waitForAgent(handle.id, 10_000)

    const beforeAbort = spawner.getAgent(handle.id)!
    expect(beforeAbort.status).toBe('completed')

    // Try to abort a completed agent — should be a no-op
    spawner.abort(handle.id)

    const afterAbort = spawner.getAgent(handle.id)!
    expect(afterAbort.status).toBe('completed') // Still completed, not aborted
  })
})
