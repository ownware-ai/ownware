import { describe, expect, it, vi } from 'vitest'
import type { SensitiveInputBinding, Tool } from '@ownware/loom'
import {
  SensitiveInputBroker,
  SensitiveInputBrokerError,
  type SensitiveInputAdapter,
} from '../../../src/gateway/sensitive-input-broker.js'

const binding: SensitiveInputBinding = {
  kind: 'test-target',
  revision: 'test.inject.v1',
}

function tool(name = 'trusted_sensitive_tool'): Tool {
  return {
    name,
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'unused', isError: false }),
  }
}

function adapter(
  inject: SensitiveInputAdapter<SensitiveInputBinding>['inject'] =
    async () => ({ disposition: 'applied' }),
): SensitiveInputAdapter<SensitiveInputBinding> {
  return {
    contractRevision: 'test.inject.v1',
    prepare(value, context) {
      if (context.agentId !== null) throw new Error('root-only')
      if (value.kind !== binding.kind || value.revision !== binding.revision) {
        throw new Error('bad binding')
      }
      return Object.freeze({ ...value })
    },
    inject,
  }
}

function request(
  broker: SensitiveInputBroker,
  trustedTool: Tool,
  requestId = 'request-1',
  agentId: string | null = null,
) {
  return broker.request({
    requestId,
    toolCallId: 'tool-call-1',
    toolName: trustedTool.name,
    agentId,
    tool: trustedTool,
    request: { label: 'Password', usage: 'Sign in', binding },
  })
}

function pendingProvision(
  start: ReturnType<SensitiveInputBroker['request']>,
) {
  if (start.status !== 'pending') throw new Error(`expected pending, got ${start.status}`)
  return start.provision
}

describe('SensitiveInputBroker', () => {
  it('binds authority to the exact final Tool object and injects once', async () => {
    const inject = vi.fn(async () => ({ disposition: 'applied' as const }))
    const trustedTool = tool()
    const broker = new SensitiveInputBroker({ issueToken: () => 'handle-1' })
    broker.register(trustedTool, adapter(inject))
    broker.beginRun('run-1')

    const waiting = pendingProvision(request(broker, trustedTool))
    const metadata = broker.respond('run-1', 'request-1', 'plain-secret-canary')
    const provision = await waiting
    if (provision.status !== 'provided') throw new Error('expected handle')

    expect(metadata).not.toHaveProperty('value')
    await expect(broker.consume(provision.handle)).resolves.toEqual({ status: 'injected' })
    expect(inject).toHaveBeenCalledWith(binding, 'plain-secret-canary')
    await expect(broker.consume(provision.handle)).rejects.toMatchObject({
      code: 'sensitive_input_handle_unknown',
    })

    const sameNameSpoof = tool(trustedTool.name)
    expect(request(broker, sameNameSpoof, 'spoof')).toEqual({ status: 'unavailable' })
    expect(broker.getPending('run-1', 'spoof')).toBeUndefined()
  })

  it('registers a pending request synchronously before returning it', () => {
    const trustedTool = tool()
    const broker = new SensitiveInputBroker()
    broker.register(trustedTool, adapter())
    broker.beginRun('run-1')

    const start = request(broker, trustedTool)
    expect(start).toMatchObject({ status: 'pending', adapterRevision: 'test.inject.v1' })
    expect(broker.getPending('run-1', 'request-1')).toMatchObject({
      agentId: null,
      adapterRevision: 'test.inject.v1',
    })
  })

  it('fails unsupported helper preparation without publishing pending state', () => {
    const trustedTool = tool()
    const broker = new SensitiveInputBroker()
    broker.register(trustedTool, adapter())
    broker.beginRun('run-1')

    expect(request(broker, trustedTool, 'helper', 'agent-1')).toEqual({
      status: 'unavailable',
    })
    expect(broker.pendingCount).toBe(0)
  })

  it('claims parallel responses atomically and never returns either value', async () => {
    const trustedTool = tool()
    const broker = new SensitiveInputBroker()
    broker.register(trustedTool, adapter())
    broker.beginRun('run-1')
    const waiting = pendingProvision(request(broker, trustedTool))
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => broker.respond('run-1', 'request-1', 'first-secret')),
      Promise.resolve().then(() => broker.respond('run-1', 'request-1', 'second-secret')),
    ])

    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(JSON.stringify(outcomes)).not.toContain('first-secret')
    expect(JSON.stringify(outcomes)).not.toContain('second-secret')
    await expect(waiting).resolves.toMatchObject({ status: 'provided' })
  })

  it('expires pending requests and issued handles without injection', async () => {
    let now = 1_000
    const inject = vi.fn(async () => ({ disposition: 'applied' as const }))
    const trustedTool = tool()
    const broker = new SensitiveInputBroker({
      now: () => now,
      requestTtlMs: 10,
      handleTtlMs: 10,
    })
    broker.register(trustedTool, adapter(inject))
    broker.beginRun('run-1')

    const requestWait = pendingProvision(request(broker, trustedTool, 'expired-request'))
    now = 1_010
    expect(() => broker.respond('run-1', 'expired-request', 'secret')).toThrow(
      expect.objectContaining({ code: 'sensitive_input_request_expired' }),
    )
    await expect(requestWait).resolves.toEqual({ status: 'expired' })

    now = 2_000
    const handleWait = pendingProvision(request(broker, trustedTool, 'expired-handle'))
    broker.respond('run-1', 'expired-handle', 'secret')
    const provision = await handleWait
    if (provision.status !== 'provided') throw new Error('expected handle')
    now = 2_010
    await expect(broker.consume(provision.handle)).resolves.toEqual({
      status: 'failed',
      reason: 'expired',
    })
    expect(inject).not.toHaveBeenCalled()
  })

  it('distinguishes deny, revoke, run end and indeterminate injection', async () => {
    const trustedTool = tool()
    const broker = new SensitiveInputBroker()
    broker.register(trustedTool, adapter(async () => ({ disposition: 'indeterminate' })))
    broker.beginRun('run-1')

    const denied = pendingProvision(request(broker, trustedTool, 'denied'))
    expect(broker.deny('run-1', 'denied')).toBe(true)
    await expect(denied).resolves.toEqual({ status: 'denied' })

    const waiting = pendingProvision(request(broker, trustedTool, 'revoked'))
    broker.respond('run-1', 'revoked', 'secret')
    const provision = await waiting
    if (provision.status !== 'provided') throw new Error('expected handle')
    expect(broker.revoke(provision.handle)).toBe(true)
    await expect(broker.consume(provision.handle)).rejects.toBeInstanceOf(
      SensitiveInputBrokerError,
    )

    const uncertain = pendingProvision(request(broker, trustedTool, 'uncertain'))
    broker.respond('run-1', 'uncertain', 'secret')
    const uncertainProvision = await uncertain
    if (uncertainProvision.status !== 'provided') throw new Error('expected handle')
    await expect(broker.consume(uncertainProvision.handle)).resolves.toEqual({
      status: 'indeterminate',
    })

    const terminal = pendingProvision(request(broker, trustedTool, 'terminal'))
    broker.endRun('run-1')
    await expect(terminal).resolves.toEqual({ status: 'revoked' })
  })

  it('never reissues a token after consumption or across runs', async () => {
    const trustedTool = tool()
    const broker = new SensitiveInputBroker({ issueToken: () => 'same-token' })
    broker.register(trustedTool, adapter())
    broker.beginRun('run-1')

    const first = pendingProvision(request(broker, trustedTool, 'first'))
    broker.respond('run-1', 'first', 'first-secret')
    const firstProvision = await first
    if (firstProvision.status !== 'provided') throw new Error('expected handle')
    await expect(broker.consume(firstProvision.handle)).resolves.toEqual({
      status: 'injected',
    })

    broker.endRun('run-1')
    broker.beginRun('run-2')

    request(broker, trustedTool, 'second')
    expect(() => broker.respond('run-2', 'second', 'second-secret')).toThrow(
      expect.objectContaining({ code: 'sensitive_input_handle_collision' }),
    )
    expect(broker.getPending('run-2', 'second')).toBeDefined()
  })

  it('redacts exact plain, Unicode, JSON-escaped and multiline canaries', async () => {
    const values = [
      'plain-secret',
      '秘密🔐value',
      '{"token":"json-secret"}',
      'line-one\nline-two\nline-three',
    ]
    for (const [index, value] of values.entries()) {
      const trustedTool = tool()
      const broker = new SensitiveInputBroker()
      broker.register(trustedTool, adapter())
      broker.beginRun('run-1')
      const waiting = pendingProvision(request(broker, trustedTool, `redact-${index}`))
      broker.respond('run-1', `redact-${index}`, value)
      await waiting

      expect(broker.redact(`before ${value} after`)).not.toContain(value)
      expect(broker.redact(JSON.stringify({ value })))
        .not.toContain(JSON.stringify(value).slice(1, -1))
    }
  })
})
