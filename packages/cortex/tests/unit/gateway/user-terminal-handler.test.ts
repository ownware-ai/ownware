import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createTerminalUserHandlers } from '../../../src/gateway/handlers/terminal.js'
import { TerminalEventBus, type TerminalEvent } from '../../../src/terminal/event-bus.js'
import {
  TerminalSessionRegistry,
  type WorkspaceResolver,
} from '../../../src/terminal/session-registry.js'
import type { PtySession } from '../../../src/terminal/pty-session.js'

class FakeSession {
  pid = 1234
  exited: { exitCode: number; signal?: number } | null = null
  // Mirror PtyStatus (pty-session.ts) — the registry expects this
  // property on every session it manages.
  status: 'running' | 'killing' | 'exited' | 'killed' = 'running'
  writes: string[] = []
  resizes: Array<[number, number]> = []
  killSignal: string | null = null
  private dataListeners: Array<(d: string) => void> = []
  private exitListeners: Array<(i: {
    exitCode: number
    signal: number | undefined
  }) => void> = []
  write(d: string): void {
    this.writes.push(d)
  }
  resize(c: number, r: number): void {
    this.resizes.push([c, r])
  }
  private _scrollback = ''
  scrollback(): string {
    return this._scrollback
  }
  seedScrollback(s: string): void {
    this._scrollback = s
  }
  // Mirror PtySession.readLines() minimally for dump's preview path.
  readLines(opts: { offset?: number; limit?: number } = {}): {
    lines: ReadonlyArray<{ lineNumber: number; text: string }>
    totalLines: number
    offset: number
    hasMore: boolean
    filter: null
  } {
    const offset = opts.offset ?? 0
    const limit = opts.limit ?? Infinity
    const lines = this._scrollback.length === 0 ? [] : this._scrollback.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const page = lines
      .slice(offset, offset + limit)
      .map((text, idx) => ({ lineNumber: offset + idx + 1, text }))
    return {
      lines: page,
      totalLines: lines.length,
      offset,
      hasMore: offset + page.length < lines.length,
      filter: null,
    }
  }
  kill(sig?: string): void {
    if (this.exited != null) return
    this.status = 'killed'
    this.killSignal = sig ?? null
    this.exited = { exitCode: 0 }
    for (const l of this.exitListeners) l({ exitCode: 0, signal: undefined })
  }
  onData(l: (d: string) => void): () => void {
    this.dataListeners.push(l)
    return () => {}
  }
  onExit(l: (i: { exitCode: number; signal: number | undefined }) => void): () => void {
    this.exitListeners.push(l)
    return () => {}
  }
  emitData(d: string): void {
    for (const l of this.dataListeners) l(d)
  }
}

function makeResolver(paths: Record<string, string>): WorkspaceResolver {
  return {
    getWorkspacePath: (id) => paths[id] ?? null,
  }
}

interface Captured {
  status: number
  body: unknown
}

function mockReq(body?: unknown): IncomingMessage {
  const req = {
    url: '/api/v1/workspaces/ws1/terminals/user',
    headers: { host: 'localhost' },
    method: body == null ? 'GET' : 'POST',
  } as unknown as IncomingMessage
  if (body != null) {
    const chunks: Buffer[] = [Buffer.from(JSON.stringify(body))]
    let emitted = false
    ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on =
      (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'data' && !emitted) {
          emitted = true
          queueMicrotask(() => {
            for (const c of chunks) cb(c)
          })
        }
        if (event === 'end') queueMicrotask(() => cb())
        return req
      }
  } else {
    ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on =
      () => req
  }
  return req
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return this
    },
    end(payload: string) {
      if (payload != null && payload.length > 0) {
        try {
          captured.body = JSON.parse(payload)
        } catch {
          captured.body = payload
        }
      }
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function makeRegistry(fakes: FakeSession[], paths: Record<string, string>) {
  const bus = new TerminalEventBus()
  let i = 0
  const registry = new TerminalSessionRegistry({
    bus,
    workspaces: makeResolver(paths),
    factory: () => {
      const f = fakes[i++] ?? new FakeSession()
      return f as unknown as PtySession
    },
  })
  return { bus, registry }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('POST /api/v1/workspaces/:wsId/terminals/user', () => {
  it('creates a user PTY and returns its id', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { create } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await create(mockReq({}), res, { wsId: 'ws1' })
    await flushMicrotasks()
    expect(captured.status).toBe(201)
    const body = captured.body as { id?: unknown }
    expect(typeof body.id).toBe('string')
    expect((body.id as string).length).toBeGreaterThan(0)
    expect(registry.listUser('ws1')).toEqual([body.id])
  })

  it('returns 404 when workspace is unknown', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { create } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await create(mockReq({}), res, { wsId: 'ghost' })
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })
})

describe('GET /api/v1/workspaces/:wsId/terminals/user', () => {
  it('returns every live user id', async () => {
    const a = new FakeSession()
    const b = new FakeSession()
    const { registry, bus } = makeRegistry([a, b], { ws1: '/tmp' })
    const ua = registry.createUser('ws1')!
    const ub = registry.createUser('ws1')!
    const { list } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await list(mockReq(), res, { wsId: 'ws1' })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    const body = captured.body as { ids: string[] }
    expect(new Set(body.ids)).toEqual(new Set([ua.id, ub.id]))
  })

  it('returns empty array when no user terminals exist', async () => {
    const { registry, bus } = makeRegistry([], { ws1: '/tmp' })
    const { list } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await list(mockReq(), res, { wsId: 'ws1' })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    // Response now includes `infos` alongside `ids` for the client's
    // tab-label render path (see session-registry.SessionInfo).
    expect(captured.body).toEqual({ ids: [], infos: [] })
  })
})

describe('POST /api/v1/workspaces/:wsId/terminals/user/:id/input', () => {
  it('writes bytes to the addressed user PTY only', async () => {
    const a = new FakeSession()
    const b = new FakeSession()
    const { registry, bus } = makeRegistry([a, b], { ws1: '/tmp' })
    const ua = registry.createUser('ws1')!
    registry.createUser('ws1')!
    const { writeInput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await writeInput(mockReq({ data: 'echo hi\n' }), res, { wsId: 'ws1', id: ua.id })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    expect(a.writes).toEqual(['echo hi\n'])
    expect(b.writes).toEqual([])
  })

  it('returns 400 when data is missing or not a string', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { writeInput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await writeInput(mockReq({ data: 42 }), res, { wsId: 'ws1', id: created.id })
    await flushMicrotasks()
    expect(captured.status).toBe(400)
  })

  it('returns 404 for an unknown terminal id', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    registry.createUser('ws1')
    const { writeInput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await writeInput(mockReq({ data: 'x' }), res, { wsId: 'ws1', id: 'ghost' })
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })
})

describe('POST /api/v1/workspaces/:wsId/terminals/user/:id/resize', () => {
  it('resizes the addressed PTY', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { resize } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await resize(mockReq({ cols: 120, rows: 40 }), res, { wsId: 'ws1', id: created.id })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    expect(fake.resizes).toEqual([[120, 40]])
  })

  it('returns 404 for an unknown id', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    registry.createUser('ws1')
    const { resize } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await resize(mockReq({ cols: 80, rows: 24 }), res, { wsId: 'ws1', id: 'ghost' })
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })
})

describe('DELETE /api/v1/workspaces/:wsId/terminals/user/:id', () => {
  it('kills the PTY and removes the entry', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { drop } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await drop(mockReq(), res, { wsId: 'ws1', id: created.id })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    expect(fake.exited).not.toBeNull()
    expect(registry.listUser('ws1')).toEqual([])
  })

  it('returns 404 for an unknown id', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { drop } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await drop(mockReq(), res, { wsId: 'ws1', id: 'ghost' })
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })
})

describe('Cross-terminal bus isolation', () => {
  it('user PTY writes never surface on the agent stream for the same workspace', () => {
    const agentFake = new FakeSession()
    const userFake = new FakeSession()
    const { registry, bus } = makeRegistry([agentFake, userFake], { ws1: '/tmp' })
    registry.getAgent('ws1')
    registry.createUser('ws1')

    const agentEvents: TerminalEvent[] = []
    const userEvents: TerminalEvent[] = []
    bus.subscribe((ev) => {
      if (ev.workspaceId !== 'ws1') return
      if (ev.kind === 'agent' && ev.terminalId === null) agentEvents.push(ev)
      if (ev.kind === 'user') userEvents.push(ev)
    })

    userFake.emitData('user-only')
    agentFake.emitData('agent-only')

    expect(agentEvents.map((e) => (e.type === 'terminal.output' ? e.data : ''))).toEqual([
      'agent-only',
    ])
    expect(userEvents.map((e) => (e.type === 'terminal.output' ? e.data : ''))).toEqual([
      'user-only',
    ])
  })

  it('POST /signal with SIGINT writes 0x03 to the session', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { sendSignal } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await sendSignal(
      mockReq({ signal: 'SIGINT' }),
      res,
      { wsId: 'ws1', id: created.id },
    )
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    // SIGINT is delivered as a raw 0x03 byte over /input so the tty
    // line discipline propagates it to the foreground process group,
    // same as Ctrl+C from a human. The session MUST still be alive.
    expect(fake.writes).toContain('\x03')
    expect(fake.exited).toBeNull()
  })

  it('POST /signal with SIGTERM calls session.kill(SIGTERM)', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { sendSignal } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await sendSignal(
      mockReq({ signal: 'SIGTERM' }),
      res,
      { wsId: 'ws1', id: created.id },
    )
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    expect(fake.killSignal).toBe('SIGTERM')
    expect(fake.exited).not.toBeNull()
  })

  it('POST /signal rejects unknown signals with 400', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    const { sendSignal } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await sendSignal(
      mockReq({ signal: 'SIGWAT' }),
      res,
      { wsId: 'ws1', id: created.id },
    )
    await flushMicrotasks()
    expect(captured.status).toBe(400)
    expect(fake.writes).not.toContain('\x03')
    expect(fake.killSignal).toBeNull()
  })

  it('GET /output/dump writes the buffer to disk and returns path + preview', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dataDir = mkdtempSync(join(tmpdir(), 'cortex-dump-test-'))
    try {
      const fake = new FakeSession()
      const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
      const created = registry.createUser('ws1')!
      // Seed scrollback so the dump has something to write.
      ;(fake as unknown as { seedScrollback: (s: string) => void }).seedScrollback(
        'line-1\nline-2\nline-3\n',
      )
      const { dumpOutput } = createTerminalUserHandlers({
        registry,
        bus,
        dataDir,
      })
      const { res, captured } = mockRes()
      await dumpOutput(mockReq(), res, { wsId: 'ws1', id: created.id })
      await flushMicrotasks()
      expect(captured.status).toBe(200)
      const body = captured.body as {
        path: string
        byteLength: number
        lineCount: number
        preview: Array<{ lineNumber: number; text: string }>
      }
      expect(body.path).toContain(created.id)
      expect(body.lineCount).toBe(3)
      expect(body.preview.map((l) => l.text)).toEqual([
        'line-1',
        'line-2',
        'line-3',
      ])
      // The file actually exists and contains the full buffer.
      const onDisk = readFileSync(body.path, 'utf8')
      expect(onDisk).toBe('line-1\nline-2\nline-3\n')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('GET /output/dump returns 503 when no dataDir is configured', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    // No dataDir passed → dump is unavailable.
    const { dumpOutput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await dumpOutput(mockReq(), res, { wsId: 'ws1', id: created.id })
    await flushMicrotasks()
    expect(captured.status).toBe(503)
  })

  it('GET /output/dump returns 404 for unknown session', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dataDir = mkdtempSync(join(tmpdir(), 'cortex-dump-test-'))
    try {
      const { registry, bus } = makeRegistry([], { ws1: '/tmp' })
      const { dumpOutput } = createTerminalUserHandlers({
        registry,
        bus,
        dataDir,
      })
      const { res, captured } = mockRes()
      await dumpOutput(mockReq(), res, { wsId: 'ws1', id: 'ghost' })
      await flushMicrotasks()
      expect(captured.status).toBe(404)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('POST /signal returns 404 for unknown session', async () => {
    const { registry, bus } = makeRegistry([], { ws1: '/tmp' })
    const { sendSignal } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await sendSignal(
      mockReq({ signal: 'SIGINT' }),
      res,
      { wsId: 'ws1', id: 'ghost' },
    )
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })

  it('two user PTYs for the same workspace do not cross-talk', () => {
    const fakeA = new FakeSession()
    const fakeB = new FakeSession()
    const { registry, bus } = makeRegistry([fakeA, fakeB], { ws1: '/tmp' })
    const ua = registry.createUser('ws1')!
    const ub = registry.createUser('ws1')!

    const eventsForA: TerminalEvent[] = []
    const eventsForB: TerminalEvent[] = []
    bus.subscribe((ev) => {
      if (ev.workspaceId !== 'ws1' || ev.kind !== 'user') return
      if (ev.terminalId === ua.id) eventsForA.push(ev)
      if (ev.terminalId === ub.id) eventsForB.push(ev)
    })

    fakeA.emitData('hello-from-a')
    fakeB.emitData('hello-from-b')

    expect(eventsForA).toHaveLength(1)
    expect(eventsForB).toHaveLength(1)
    expect(
      eventsForA[0]!.type === 'terminal.output' ? eventsForA[0]!.data : null,
    ).toBe('hello-from-a')
    expect(
      eventsForB[0]!.type === 'terminal.output' ? eventsForB[0]!.data : null,
    ).toBe('hello-from-b')
  })
})
