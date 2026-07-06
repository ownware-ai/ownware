import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createTerminalAgentHandlers,
  createTerminalUserHandlers,
} from '../../../src/gateway/handlers/terminal.js'
import { TerminalEventBus } from '../../../src/terminal/event-bus.js'
import {
  TerminalSessionRegistry,
  type WorkspaceResolver,
} from '../../../src/terminal/session-registry.js'
import type { PtySession } from '../../../src/terminal/pty-session.js'

class FakeSession {
  pid = 1234
  exited: { exitCode: number; signal?: number } | null = null
  // Mirror the PtyStatus union (pty-session.ts). FakeSession is cast
  // to PtySession via the registry factory, so we must expose the
  // same shape.
  status: 'running' | 'killing' | 'exited' | 'killed' = 'running'
  writes: string[] = []
  resizes: Array<[number, number]> = []
  private dataListeners: Array<(d: string) => void> = []
  private exitListeners: Array<(i: {
    exitCode: number
    signal: number | undefined
  }) => void> = []
  private buffer = ''
  write(d: string): void {
    this.writes.push(d)
  }
  resize(c: number, r: number): void {
    this.resizes.push([c, r])
  }
  scrollback(): string {
    return this.buffer
  }
  seedScrollback(s: string): void {
    this.buffer = s
  }
  // Minimal readLines shim mirroring PtySession.readLines() so handler
  // tests can assert the HTTP contract without spinning up a real PTY.
  readLines(opts: {
    offset?: number
    limit?: number
    pattern?: RegExp
  } = {}): {
    lines: ReadonlyArray<{ lineNumber: number; text: string; truncated?: boolean }>
    totalLines: number
    offset: number
    hasMore: boolean
    filter: { pattern: string; ignoreCase: boolean; matchCount: number } | null
  } {
    const offset = Math.max(0, Math.floor(opts.offset ?? 0))
    const limit = opts.limit == null ? Number.POSITIVE_INFINITY : opts.limit
    const split = this.buffer.length === 0 ? [] : this.buffer.split('\n')
    if (split.length > 0 && split[split.length - 1] === '') split.pop()
    if (opts.pattern != null) {
      const matches: Array<{ lineNumber: number; text: string }> = []
      for (let i = 0; i < split.length; i++) {
        if (opts.pattern.test(split[i]!)) {
          matches.push({ lineNumber: i + 1, text: split[i]! })
        }
        opts.pattern.lastIndex = 0
      }
      const page = matches.slice(offset, offset + limit)
      return {
        lines: page,
        totalLines: matches.length,
        offset,
        hasMore: offset + page.length < matches.length,
        filter: {
          pattern: opts.pattern.source,
          ignoreCase: opts.pattern.flags.includes('i'),
          matchCount: matches.length,
        },
      }
    }
    const page = split
      .slice(offset, offset + limit)
      .map((text, idx) => ({ lineNumber: offset + idx + 1, text }))
    return {
      lines: page,
      totalLines: split.length,
      offset,
      hasMore: offset + page.length < split.length,
      filter: null,
    }
  }
  kill(): void {
    if (this.exited != null) return
    this.status = 'killed'
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
    url: '/api/v1/workspaces/ws1/terminal/agent/resize',
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

describe('POST /api/v1/workspaces/:wsId/terminal/agent/resize', () => {
  it('spawns the agent PTY if needed and calls session.resize', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { resize } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await resize(mockReq({ cols: 120, rows: 40 }), res, { wsId: 'ws1' })
    await flushMicrotasks()
    expect(captured.status).toBe(200)
    expect(fake.resizes).toEqual([[120, 40]])
  })

  it('rejects non-positive values', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { resize } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await resize(mockReq({ cols: 0, rows: 40 }), res, { wsId: 'ws1' })
    await flushMicrotasks()
    expect(captured.status).toBe(400)
  })

  it('returns 404 when workspace is unknown', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const { resize } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await resize(mockReq({ cols: 80, rows: 24 }), res, { wsId: 'ghost' })
    await flushMicrotasks()
    expect(captured.status).toBe(404)
  })
})

describe('POST /api/v1/workspaces/:wsId/terminal/agent/reset', () => {
  it('kills the agent session via registry.dropAgent', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    registry.getAgent('ws1')
    expect(registry.hasAgent('ws1')).toBe(true)
    const { reset } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await reset(mockReq(), res, { wsId: 'ws1' })
    expect(captured.status).toBe(200)
    expect(registry.hasAgent('ws1')).toBe(false)
  })
})

describe('Agent handlers — factory surface', () => {
  it('does NOT expose a writeInput handler — the agent PTY is client-read-only', () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const handlers = createTerminalAgentHandlers({ registry, bus })
    // Tests the contract: any callsite trying to resolve `writeInput`
    // on the agent handler bag should fail at type-check. Here we
    // assert the runtime shape carries only the handlers the router
    // registers — `readOutput` was added for the shell-sessions
    // pull-delta read, but input remains forbidden.
    expect(Object.keys(handlers).sort()).toEqual([
      'readOutput',
      'reset',
      'resize',
      'streamEvents',
    ])
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/workspaces/:wsId/terminal/agent/output
// GET /api/v1/workspaces/:wsId/terminals/user/:id/output
//
// Paginated line-based read. See `handlers/terminal.ts` for full
// contract — these tests pin each query-parsing branch and both the
// "fresh workspace, no PTY yet" and "existing scrollback" cases.
// ---------------------------------------------------------------------------

function outputReq(
  path: string,
  search: Record<string, string> = {},
): IncomingMessage {
  const qs = new URLSearchParams(search).toString()
  const url = qs.length > 0 ? `${path}?${qs}` : path
  const req = {
    url,
    headers: { host: 'localhost' },
    method: 'GET',
  } as unknown as IncomingMessage
  ;(req as unknown as { on: (ev: string, cb: (...a: unknown[]) => void) => IncomingMessage }).on =
    () => req
  return req
}

describe('GET /api/v1/workspaces/:wsId/terminal/agent/output', () => {
  it('returns an empty result when the agent PTY has never been spawned', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output'),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      lines: [],
      totalLines: 0,
      offset: 0,
      hasMore: false,
      filter: null,
    })
    // Key invariant: the read MUST NOT warm a PTY for the workspace.
    expect(registry.hasAgent('ws1')).toBe(false)
  })

  it('returns 404 when the workspace does not exist', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ghost/terminal/agent/output'),
      res,
      { wsId: 'ghost' },
    )
    expect(captured.status).toBe(404)
  })

  it('paginates the scrollback when the agent has output', async () => {
    const fake = new FakeSession()
    fake.seedScrollback('line-1\nline-2\nline-3\nline-4\nline-5\n')
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    // Warm the agent so peekAgent finds it.
    registry.getAgent('ws1')
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        offset: '1',
        limit: '2',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      lines: [
        { lineNumber: 2, text: 'line-2' },
        { lineNumber: 3, text: 'line-3' },
      ],
      totalLines: 5,
      offset: 1,
      hasMore: true,
      filter: null,
    })
  })

  it('filters via regex and paginates the MATCHES (not raw lines)', async () => {
    const fake = new FakeSession()
    fake.seedScrollback(
      'info: started\nerror: port busy\ninfo: retrying\nerror: giving up\nfatal: crashed\n',
    )
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    registry.getAgent('ws1')
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        pattern: 'error',
        limit: '10',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(200)
    const body = captured.body as {
      lines: Array<{ lineNumber: number; text: string }>
      totalLines: number
      filter: { pattern: string; ignoreCase: boolean; matchCount: number }
    }
    expect(body.lines).toEqual([
      { lineNumber: 2, text: 'error: port busy' },
      { lineNumber: 4, text: 'error: giving up' },
    ])
    expect(body.totalLines).toBe(2) // matches, not raw line count
    expect(body.filter).toEqual({
      pattern: 'error',
      ignoreCase: false,
      matchCount: 2,
    })
  })

  it('honours ignoreCase=1 on the regex', async () => {
    const fake = new FakeSession()
    fake.seedScrollback('ERROR: uppercase\nerror: lowercase\ninfo: neither\n')
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    registry.getAgent('ws1')
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        pattern: 'error',
        ignoreCase: '1',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(200)
    const body = captured.body as {
      lines: Array<{ lineNumber: number }>
      filter: { ignoreCase: boolean }
    }
    expect(body.lines.map((l) => l.lineNumber)).toEqual([1, 2])
    expect(body.filter.ignoreCase).toBe(true)
  })

  it('rejects a malformed regex with 400 and the parser error', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        pattern: '(unclosed',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(400)
    // `error` is the code ("invalid_request"); `message` carries the
    // specific regex parser error the agent needs to fix the pattern.
    const body = captured.body as { error: string; message: string }
    expect(body.error).toBe('invalid_request')
    expect(body.message).toMatch(/pattern/i)
  })

  it('rejects a negative offset with 400', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        offset: '-1',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(400)
  })

  it('rejects a limit above MAX_READ_LIMIT with 400', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalAgentHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminal/agent/output', {
        limit: '99999',
      }),
      res,
      { wsId: 'ws1' },
    )
    expect(captured.status).toBe(400)
  })
})

describe('GET /api/v1/workspaces/:wsId/terminals/user/:id/output', () => {
  it('returns 404 when the user PTY does not exist', async () => {
    const { registry, bus } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    const { readOutput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq('/api/v1/workspaces/ws1/terminals/user/abc/output'),
      res,
      { wsId: 'ws1', id: 'abc' },
    )
    expect(captured.status).toBe(404)
  })

  it('reads lines from an existing user PTY', async () => {
    const fake = new FakeSession()
    fake.seedScrollback('u-1\nu-2\nu-3\n')
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')
    expect(created).not.toBeNull()
    const { readOutput } = createTerminalUserHandlers({ registry, bus })
    const { res, captured } = mockRes()
    await readOutput(
      outputReq(`/api/v1/workspaces/ws1/terminals/user/${created!.id}/output`),
      res,
      { wsId: 'ws1', id: created!.id },
    )
    expect(captured.status).toBe(200)
    const body = captured.body as {
      lines: Array<{ lineNumber: number; text: string }>
      totalLines: number
    }
    expect(body.lines.map((l) => l.text)).toEqual(['u-1', 'u-2', 'u-3'])
    expect(body.totalLines).toBe(3)
  })
})
