import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CodexAppServerClient,
  CodexAppServerError,
  SUPPORTED_CODEX_VERSION_RANGE,
  parseCodexVersion,
  probeCodexVersion,
  type CodexChildProcess,
} from '../../../../src/runtime/codex/app-server-client.js'

class ScriptedChild extends EventEmitter implements CodexChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  exitCode: number | null = null
  readonly writes: unknown[] = []
  readonly signals: NodeJS.Signals[] = []
  onWrite?: (message: Record<string, unknown>) => void

  constructor() {
    super()
    let pending = ''
    this.stdin.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.length > 0) {
          const message = JSON.parse(line) as Record<string, unknown>
          this.writes.push(message)
          this.onWrite?.(message)
        }
        newline = pending.indexOf('\n')
      }
    })
  }

  reply(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  raw(line: string): void {
    this.stdout.write(`${line}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.exit(null, signal)
    return true
  }
}

class StubbornChild extends ScriptedChild {
  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }
}

function successfulChild(codexHome: string): ScriptedChild {
  const child = new ScriptedChild()
  child.onWrite = (message) => {
    if (message['method'] === 'initialize') {
      child.reply({
        id: message['id'],
        result: {
          userAgent: 'codex-cli/0.145.0',
          codexHome,
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      })
    }
  }
  return child
}

async function startClient(
  child: ScriptedChild,
  overrides: Partial<Parameters<typeof CodexAppServerClient.start>[0]> = {},
): Promise<CodexAppServerClient> {
  return CodexAppServerClient.start({
    codexHome: '/private/tmp/ownware-codex-home',
    clientVersion: '0.3.0',
    probeVersion: async () => 'codex-cli 0.145.0',
    spawnProcess: () => child,
    requestTimeoutMs: 50,
    closeTimeoutMs: 10,
    ...overrides,
  })
}

describe('Codex app-server compatibility', () => {
  it('pins the generated protocol to the supported Codex minor line', () => {
    expect(SUPPORTED_CODEX_VERSION_RANGE).toBe(
      '>=0.145.0 <0.146.0 || >=0.147.0 <0.148.0',
    )
    expect(parseCodexVersion('codex-cli 0.145.0')).toEqual({
      raw: '0.145.0',
      major: 0,
      minor: 145,
      patch: 0,
    })
    expect(parseCodexVersion('not a version')).toBeNull()
  })

  it('accepts the separately proven 0.147 protocol line', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child, {
      probeVersion: async () => 'codex-cli 0.147.0',
    })

    expect(client.diagnostics().version).toBe('0.147.0')
    await client.close()
  })

  it.each(['codex-cli 0.144.9', 'codex-cli 0.146.0', 'codex-cli 0.148.0', 'garbled'])(
    'fails an incompatible binary before spawning: %s',
    async (version) => {
      const child = successfulChild('/private/tmp/ownware-codex-home')
      let spawnCalls = 0

      await expect(startClient(child, {
        probeVersion: async () => version,
        spawnProcess: () => {
          spawnCalls++
          return child
        },
      })).rejects.toMatchObject({ code: 'incompatible_version' })
      expect(spawnCalls).toBe(0)
    },
  )

  it('reports a missing binary without exposing an operating-system error', async () => {
    await expect(
      probeCodexVersion('/private/tmp/ownware-no-such-codex-binary'),
    ).rejects.toMatchObject({
      code: 'binary_not_found',
      message: 'Codex app-server failed (binary_not_found).',
    })
  })
})

describe('Codex app-server handshake and isolation', () => {
  it('initializes as Ownware, accepts the current JSONL response shape, and verifies CODEX_HOME', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    let spawnOptions: unknown
    let spawnArgs: readonly string[] = []
    const client = await startClient(child, {
      spawnProcess: (_binary, args, options) => {
        spawnArgs = args
        spawnOptions = options
        return child
      },
    })

    expect(child.writes).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'ownware',
            title: 'Ownware',
            version: '0.3.0',
          },
          capabilities: {},
        },
      },
      { method: 'initialized', params: {} },
    ])
    expect(spawnOptions).toMatchObject({
      env: { CODEX_HOME: '/private/tmp/ownware-codex-home' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(spawnArgs).toEqual(['app-server', '--strict-config'])
    expect(JSON.stringify(child.writes)).not.toContain('jsonrpc')
    await client.close()
  })

  it('accepts the standards-shaped response used by older fixtures', async () => {
    const child = new ScriptedChild()
    child.onWrite = (message) => {
      if (message['method'] === 'initialize') {
        child.reply({
          jsonrpc: '2.0',
          id: message['id'],
          result: {
            userAgent: 'codex-cli/0.145.0',
            codexHome: '/private/tmp/ownware-codex-home',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
      }
    }
    const client = await startClient(child)
    await client.close()
  })

  it('fails closed when the server reports a different configuration home', async () => {
    const child = successfulChild('/Users/customer/.codex')
    await expect(startClient(child)).rejects.toMatchObject({
      code: 'configuration_isolation_failed',
    })
    expect(child.signals).toContain('SIGTERM')
  })
})

describe('Codex app-server protocol failures', () => {
  it('poisons the connection on malformed JSON without retaining the line', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const pending = client.request('model/list', {})

    child.raw('secret-token-that-is-not-json')

    await expect(pending).rejects.toMatchObject({ code: 'malformed_message' })
    expect(client.diagnostics()).toEqual(expect.objectContaining({
      state: 'failed',
      failureCode: 'malformed_message',
    }))
    expect(JSON.stringify(client.diagnostics())).not.toContain('secret-token')
  })

  it('poisons the connection when a response id cannot be correlated', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const pending = client.request('model/list', {})
    child.reply({ id: 999, result: {} })

    await expect(pending).rejects.toMatchObject({ code: 'unknown_response_id' })
  })

  it('fails when unconsumed notifications exceed the bounded inbox', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child, { inboxCapacity: 1 })
    child.reply({ method: 'first', params: {} })
    child.reply({ method: 'second', params: {} })

    expect(client.diagnostics()).toMatchObject({
      state: 'failed',
      failureCode: 'inbox_overflow',
    })
  })

  it('correlates concurrent responses even when they arrive in reverse order', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const first = client.request('model/list', { cursor: 'one' })
    const second = client.request('thread/list', { cursor: 'two' })
    await new Promise((resolve) => setImmediate(resolve))

    const firstRequest = child.writes.at(-2) as { id: number }
    const secondRequest = child.writes.at(-1) as { id: number }
    child.reply({ id: secondRequest.id, result: { value: 'second' } })
    child.reply({ id: firstRequest.id, result: { value: 'first' } })

    await expect(first).resolves.toEqual({ value: 'first' })
    await expect(second).resolves.toEqual({ value: 'second' })
    await client.close()
  })

  it('surfaces unknown notifications and server requests instead of dropping or approving them', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)

    child.reply({ method: 'future/notification', params: { secret: 'kept on the wire' } })
    child.reply({ id: 'approval-1', method: 'future/approval', params: { command: 'no' } })

    await expect(client.nextNotification(50)).resolves.toEqual({
      method: 'future/notification',
      params: { secret: 'kept on the wire' },
    })
    await expect(client.nextServerRequest(50)).resolves.toEqual({
      id: 'approval-1',
      method: 'future/approval',
      params: { command: 'no' },
    })
    expect(child.writes).toHaveLength(2)
    await client.close()
  })

  it('preserves notification and server-request arrival order in one driver inbox', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)

    child.reply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    child.reply({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1' },
    })
    child.reply({ method: 'item/completed', params: { item: { id: 'item-1' } } })

    await expect(client.nextInbound(50)).resolves.toEqual({
      kind: 'notification',
      message: {
        method: 'turn/started',
        params: { turn: { id: 'turn-1' } },
      },
    })
    await expect(client.nextInbound(50)).resolves.toEqual({
      kind: 'server_request',
      message: {
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-1' },
      },
    })
    await expect(client.nextInbound(50)).resolves.toEqual({
      kind: 'notification',
      message: {
        method: 'item/completed',
        params: { item: { id: 'item-1' } },
      },
    })
    await client.close()
  })

  it('returns typed JSON-RPC errors without logging provider data', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const pending = client.request('model/list', {})
    await new Promise((resolve) => setImmediate(resolve))
    const request = child.writes.at(-1) as { id: number }
    child.reply({
      id: request.id,
      error: { code: -32001, message: 'overloaded', data: { token: 'do-not-log' } },
    })

    await expect(pending).rejects.toEqual(expect.objectContaining({
      name: 'CodexAppServerError',
      rpcCode: -32001,
      message: 'Codex app-server rejected "model/list" (-32001).',
    }))
    expect(JSON.stringify(client.diagnostics())).not.toContain('do-not-log')
    await client.close()
  })
})

describe('Codex app-server process lifecycle', () => {
  it('times out initialization and terminates the child', async () => {
    const child = new ScriptedChild()
    await expect(startClient(child, { requestTimeoutMs: 5 })).rejects.toMatchObject({
      code: 'request_timeout',
    })
    expect(child.signals).toContain('SIGTERM')
  })

  it('rejects pending work when the process exits mid-request', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const pending = client.request('turn/start', {})
    child.exit(17)

    await expect(pending).rejects.toMatchObject({
      code: 'process_exited',
      exitCode: 17,
    })
  })

  it('counts but never retains a stderr flood', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    child.stderr.write('raw-prompt-and-token'.repeat(100_000))
    await new Promise((resolve) => setImmediate(resolve))

    const diagnostics = client.diagnostics()
    expect(diagnostics.stderrBytes).toBeGreaterThan(1_000_000)
    expect(JSON.stringify(diagnostics)).not.toContain('raw-prompt')
    await client.close()
  })

  it('sends an exact turn interrupt and makes close idempotent', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    child.onWrite = (message) => {
      if (message['method'] === 'initialize') {
        child.reply({
          id: message['id'],
          result: {
            userAgent: 'codex-cli/0.145.0',
            codexHome: '/private/tmp/ownware-codex-home',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
      } else if (message['method'] === 'turn/interrupt') {
        child.reply({ id: message['id'], result: {} })
      }
    }
    const client = await startClient(child)

    await client.interrupt('thread-1', 'turn-1')
    expect(child.writes.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    const first = client.close()
    const second = client.close()
    expect(first).toBe(second)
    await first
    expect(child.signals.filter((signal) => signal === 'SIGTERM')).toHaveLength(1)
  })

  it('rejects in-flight work immediately when the client closes', async () => {
    const child = successfulChild('/private/tmp/ownware-codex-home')
    const client = await startClient(child)
    const pending = client.request('turn/start', {})
    const closing = client.close()

    await expect(pending).rejects.toMatchObject({ code: 'client_closed' })
    await closing
    expect(client.diagnostics().state).toBe('closed')
  })

  it('does not claim closed when process death is unobservable after SIGKILL', async () => {
    const child = new StubbornChild()
    child.onWrite = (message) => {
      if (message['method'] === 'initialize') {
        child.reply({
          id: message['id'],
          result: {
            userAgent: 'codex-cli/0.145.0',
            codexHome: '/private/tmp/ownware-codex-home',
            platformFamily: 'unix',
            platformOs: 'macos',
          },
        })
      }
    }
    const client = await startClient(child, { closeTimeoutMs: 2 })

    await expect(client.close()).rejects.toMatchObject({
      code: 'shutdown_timeout',
    })
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(client.diagnostics()).toMatchObject({
      state: 'failed',
      failureCode: 'shutdown_timeout',
    })
  })
})

describe('Codex error shape', () => {
  it('does not preserve raw RPC message or data on the thrown error', () => {
    const error = new CodexAppServerError('model/list', -1)
    expect(error).toMatchObject({
      name: 'CodexAppServerError',
      rpcCode: -1,
      method: 'model/list',
    })
    expect(error).not.toHaveProperty('data')
  })
})
