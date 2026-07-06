import { describe, it, expect, vi } from 'vitest'
import {
  TerminalSessionRegistry,
  type WorkspaceResolver,
} from '../../../src/terminal/session-registry.js'
import { TerminalEventBus } from '../../../src/terminal/event-bus.js'
import type { PtySession, PtySessionOptions } from '../../../src/terminal/pty-session.js'

// A fake PtySession stub — no real node-pty spawn. Covers the
// registry's lifecycle logic without the native dep.
class FakeSession {
  pid = 1234
  exited: { exitCode: number; signal?: number } | null = null
  status: 'running' | 'killing' | 'exited' | 'killed' = 'running'
  private _scrollback = ''
  private dataListeners: Array<(d: string) => void> = []
  private exitListeners: Array<(info: {
    exitCode: number
    signal: number | undefined
  }) => void> = []

  write(_data: string): void {}
  resize(_cols: number, _rows: number): void {}
  scrollback(): string {
    return this._scrollback
  }
  seedScrollback(s: string): void {
    this._scrollback = s
  }
  kill(): void {
    if (this.exited != null) return
    this.status = 'killed'
    this.exited = { exitCode: 0 }
    for (const l of this.exitListeners) l({ exitCode: 0, signal: undefined })
  }
  onData(l: (d: string) => void): () => void {
    this.dataListeners.push(l)
    return () => {
      this.dataListeners = this.dataListeners.filter((x) => x !== l)
    }
  }
  onExit(l: (info: { exitCode: number; signal: number | undefined }) => void): () => void {
    this.exitListeners.push(l)
    return () => {
      this.exitListeners = this.exitListeners.filter((x) => x !== l)
    }
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

function fakeFactory(fakes: FakeSession[]): (o: PtySessionOptions) => PtySession {
  let i = 0
  return () => {
    const f = fakes[i++] ?? new FakeSession()
    return f as unknown as PtySession
  }
}

describe('TerminalSessionRegistry — agent PTY', () => {
  it('lazy-spawns on first getAgent and reuses on subsequent getAgents', () => {
    const bus = new TerminalEventBus()
    const factory = vi.fn(
      () => new FakeSession() as unknown as PtySession,
    )
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory,
    })
    const a = registry.getAgent('ws1')
    const b = registry.getAgent('ws1')
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('returns null when workspace path unresolvable', () => {
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({}),
    })
    expect(registry.getAgent('ghost')).toBeNull()
  })

  it('forwards output events tagged with kind:agent and terminalId:null', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const events: unknown[] = []
    bus.subscribe((ev) => events.push(ev))
    registry.getAgent('ws1')
    fake.emitData('hello')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'terminal.output',
      workspaceId: 'ws1',
      kind: 'agent',
      terminalId: null,
      data: 'hello',
    })
  })

  it('dropAgent kills + removes; next getAgent spawns a fresh session', () => {
    const bus = new TerminalEventBus()
    const factory = vi.fn(
      () => new FakeSession() as unknown as PtySession,
    )
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory,
    })
    const first = registry.getAgent('ws1')
    registry.dropAgent('ws1')
    expect(registry.hasAgent('ws1')).toBe(false)
    const second = registry.getAgent('ws1')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('emits terminal.exit when an agent session exits, and removes the entry', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const events: unknown[] = []
    bus.subscribe((ev) => events.push(ev))
    registry.getAgent('ws1')
    fake.kill()
    expect(
      events.some(
        (ev) =>
          (ev as { type: string }).type === 'terminal.exit' &&
          (ev as { kind: string }).kind === 'agent',
      ),
    ).toBe(true)
    expect(registry.hasAgent('ws1')).toBe(false)
  })
})

describe('TerminalSessionRegistry — user PTYs', () => {
  it('createUser returns an opaque id and spawns a live session', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const created = registry.createUser('ws1')
    expect(created).not.toBeNull()
    expect(typeof created!.id).toBe('string')
    expect(created!.id.length).toBeGreaterThan(0)
    expect(created!.session).toBe(fake as unknown as PtySession)
    expect(registry.listUser('ws1')).toEqual([created!.id])
  })

  it('createUser returns null when workspace path unresolvable', () => {
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({}),
    })
    expect(registry.createUser('ghost')).toBeNull()
  })

  it('listUser returns every live user id for the workspace and nothing else', () => {
    const bus = new TerminalEventBus()
    const a = new FakeSession()
    const b = new FakeSession()
    const c = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1', ws2: '/tmp/ws2' }),
      factory: fakeFactory([a, b, c]),
    })
    const ua = registry.createUser('ws1')
    const ub = registry.createUser('ws1')
    const uc = registry.createUser('ws2')
    expect(ua).not.toBeNull()
    expect(ub).not.toBeNull()
    expect(uc).not.toBeNull()
    expect(new Set(registry.listUser('ws1'))).toEqual(new Set([ua!.id, ub!.id]))
    expect(registry.listUser('ws2')).toEqual([uc!.id])
  })

  it('getUser returns the session, or null for unknown ids', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const created = registry.createUser('ws1')!
    expect(registry.getUser('ws1', created.id)).toBe(fake as unknown as PtySession)
    expect(registry.getUser('ws1', 'nonexistent')).toBeNull()
    expect(registry.getUser('ws2', created.id)).toBeNull()
  })

  it('dropUser kills the session and removes it from listUser', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const created = registry.createUser('ws1')!
    registry.dropUser('ws1', created.id)
    expect(fake.exited).not.toBeNull()
    expect(registry.listUser('ws1')).toEqual([])
    expect(registry.getUser('ws1', created.id)).toBeNull()
  })

  it('dropUser is a no-op for an unknown id', () => {
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => new FakeSession() as unknown as PtySession,
    })
    expect(() => registry.dropUser('ws1', 'ghost')).not.toThrow()
  })

  it('forwards output events tagged with kind:user and the correct terminalId', () => {
    const bus = new TerminalEventBus()
    const a = new FakeSession()
    const b = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: fakeFactory([a, b]),
    })
    const ua = registry.createUser('ws1')!
    const ub = registry.createUser('ws1')!
    const events: unknown[] = []
    bus.subscribe((ev) => events.push(ev))
    a.emitData('from-a')
    b.emitData('from-b')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'terminal.output',
      workspaceId: 'ws1',
      kind: 'user',
      terminalId: ua.id,
      data: 'from-a',
    })
    expect(events[1]).toMatchObject({
      type: 'terminal.output',
      workspaceId: 'ws1',
      kind: 'user',
      terminalId: ub.id,
      data: 'from-b',
    })
  })

  it('emits terminal.exit and removes entry when a user session exits on its own', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const events: unknown[] = []
    bus.subscribe((ev) => events.push(ev))
    const created = registry.createUser('ws1')!
    fake.kill()
    expect(
      events.some(
        (ev) =>
          (ev as { type: string }).type === 'terminal.exit' &&
          (ev as { kind: string }).kind === 'user' &&
          (ev as { terminalId: string | null }).terminalId === created.id,
      ),
    ).toBe(true)
    expect(registry.listUser('ws1')).toEqual([])
  })
})

describe('TerminalSessionRegistry — status + ownership + notify + timeout (Items 3–6)', () => {
  function makeRegistry(fakes: FakeSession[], paths: Record<string, string>) {
    const bus = new TerminalEventBus()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver(paths),
      factory: fakeFactory(fakes),
    })
    return { registry, bus }
  }

  it('createUser accepts parentThreadId + parentAgent and exposes them via getInfo', () => {
    const fake = new FakeSession()
    const { registry } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1', {
      parentThreadId: 'thr-42',
      parentAgent: 'coder',
    })!
    const info = registry.getInfo('ws1', 'user', created.id)!
    expect(info.parentThreadId).toBe('thr-42')
    expect(info.parentAgent).toBe('coder')
    expect(info.kind).toBe('user')
    expect(info.status).toBe('running')
  })

  it('cleanupByThread kills every session owned by the thread and leaves others', () => {
    const a = new FakeSession()
    const b = new FakeSession()
    const c = new FakeSession()
    const d = new FakeSession() // human-owned, no parent — must survive
    const { registry } = makeRegistry([a, b, c, d], { ws1: '/tmp' })
    const ua = registry.createUser('ws1', { parentThreadId: 'thr-1', parentAgent: 'coder' })!
    const ub = registry.createUser('ws1', { parentThreadId: 'thr-1', parentAgent: 'coder' })!
    const uc = registry.createUser('ws1', { parentThreadId: 'thr-2', parentAgent: 'coder' })!
    const ud = registry.createUser('ws1')! // human-owned

    registry.cleanupByThread('thr-1')

    expect(registry.getUser('ws1', ua.id)).toBeNull()
    expect(registry.getUser('ws1', ub.id)).toBeNull()
    expect(registry.getUser('ws1', uc.id)).not.toBeNull()
    expect(registry.getUser('ws1', ud.id)).not.toBeNull()
  })

  it('cleanupByThread does NOT touch the workspace agent PTY', () => {
    const agentFake = new FakeSession()
    const userFake = new FakeSession()
    const { registry } = makeRegistry([agentFake, userFake], { ws1: '/tmp' })
    registry.getAgent('ws1') // spawn agent
    registry.createUser('ws1', { parentThreadId: 'thr-1', parentAgent: 'coder' })

    registry.cleanupByThread('thr-1')

    expect(registry.hasAgent('ws1')).toBe(true)
  })

  it('listByThread returns info only for sessions owned by that thread', () => {
    const a = new FakeSession()
    const b = new FakeSession()
    const c = new FakeSession()
    const { registry } = makeRegistry([a, b, c], { ws1: '/tmp' })
    registry.createUser('ws1', { parentThreadId: 'thr-X', parentAgent: 'explorer' })
    registry.createUser('ws1', { parentThreadId: 'thr-X', parentAgent: 'explorer' })
    registry.createUser('ws1', { parentThreadId: 'thr-Y', parentAgent: 'coder' })

    const xs = registry.listByThread('thr-X')
    expect(xs.length).toBe(2)
    expect(xs.every((i) => i.parentThreadId === 'thr-X')).toBe(true)
    expect(registry.listByThread('thr-Z').length).toBe(0)
  })

  it('notifyOnExit: true emits terminal.exited with lineCount + lastLine + timedOut=false', async () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const exited: Array<Record<string, unknown>> = []
    bus.subscribe((ev) => {
      if (ev.type === 'terminal.exited') exited.push(ev as unknown as Record<string, unknown>)
    })
    const created = registry.createUser('ws1', { notifyOnExit: true })!
    // Seed the FakeSession's scrollback so summarizeScrollback sees
    // real content.
    ;(fake as unknown as { seedScrollback: (s: string) => void }).seedScrollback(
      'line-1\nline-2\nfinal-line\n',
    )
    // Trigger exit.
    fake.kill()
    expect(exited.length).toBe(1)
    const ev = exited[0]!
    expect(ev.type).toBe('terminal.exited')
    expect(ev.kind).toBe('user')
    expect(ev.terminalId).toBe(created.id)
    expect(ev.lineCount).toBe(3)
    expect(ev.lastLine).toBe('final-line')
    expect(ev.timedOut).toBe(false)
  })

  it('notifyOnExit: false suppresses the terminal.exited event (terminal.exit still fires)', () => {
    const fake = new FakeSession()
    const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
    const exited: unknown[] = []
    const exits: unknown[] = []
    bus.subscribe((ev) => {
      if (ev.type === 'terminal.exited') exited.push(ev)
      if (ev.type === 'terminal.exit') exits.push(ev)
    })
    registry.createUser('ws1')
    fake.kill()
    expect(exited.length).toBe(0)
    expect(exits.length).toBe(1)
  })

  it('timeoutSeconds auto-kills the session and flags timedOut=true in the exit event', async () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeSession()
      const { registry, bus } = makeRegistry([fake], { ws1: '/tmp' })
      const exited: Array<{ timedOut: boolean }> = []
      bus.subscribe((ev) => {
        if (ev.type === 'terminal.exited') {
          exited.push(ev as unknown as { timedOut: boolean })
        }
      })
      registry.createUser('ws1', { notifyOnExit: true, timeoutSeconds: 2 })

      // Advance past the 2-second timeout. The fake session's `kill()`
      // fires its exit listener synchronously, which triggers the
      // exit handler that emits the `terminal.exited` event.
      vi.advanceTimersByTime(2_500)

      expect(exited.length).toBe(1)
      expect(exited[0]!.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeoutSeconds rejects non-positive / non-integer values synchronously', () => {
    const { registry } = makeRegistry([new FakeSession()], { ws1: '/tmp' })
    expect(() => registry.createUser('ws1', { timeoutSeconds: 0 })).toThrow()
    expect(() => registry.createUser('ws1', { timeoutSeconds: -1 })).toThrow()
    expect(() => registry.createUser('ws1', { timeoutSeconds: 1.5 })).toThrow()
  })

  it('natural exit clears the timeout (no double-kill on timer fire)', () => {
    vi.useFakeTimers()
    try {
      const fake = new FakeSession()
      const { registry } = makeRegistry([fake], { ws1: '/tmp' })
      registry.createUser('ws1', { timeoutSeconds: 10 })
      // Process exits on its own before the timeout.
      fake.kill()
      // Advancing past the timeout must NOT throw or re-kill.
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('session status reflects the PtyStatus union from the underlying session', () => {
    const fake = new FakeSession()
    const { registry } = makeRegistry([fake], { ws1: '/tmp' })
    const created = registry.createUser('ws1')!
    expect(registry.getInfo('ws1', 'user', created.id)?.status).toBe('running')
    // FakeSession.kill flips `exited` directly, which we don't care
    // about for status — real PtyStatus transitions are covered in
    // pty-session.test.ts. Here we just confirm getInfo reads the
    // live PtySession.status field.
  })
})

describe('TerminalSessionRegistry — peek + workspaceExists (read-only helpers)', () => {
  it('peekAgent returns null before any spawn and the session after', () => {
    const bus = new TerminalEventBus()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: fakeFactory([new FakeSession()]),
    })
    expect(registry.peekAgent('ws1')).toBeNull()
    const spawned = registry.getAgent('ws1')
    expect(registry.peekAgent('ws1')).toBe(spawned)
  })

  it('peekAgent does NOT spawn the agent PTY (side-effect free)', () => {
    const bus = new TerminalEventBus()
    const factory = vi.fn(
      () => new FakeSession() as unknown as PtySession,
    )
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory,
    })
    registry.peekAgent('ws1')
    registry.peekAgent('ws1')
    registry.peekAgent('ws1')
    expect(factory).not.toHaveBeenCalled()
    expect(registry.hasAgent('ws1')).toBe(false)
  })

  it('peekAgent returns null after the session exits', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: fakeFactory([fake]),
    })
    registry.getAgent('ws1')
    expect(registry.peekAgent('ws1')).not.toBeNull()
    fake.kill()
    expect(registry.peekAgent('ws1')).toBeNull()
  })

  it('workspaceExists mirrors the resolver without touching the PTY', () => {
    const bus = new TerminalEventBus()
    const factory = vi.fn(
      () => new FakeSession() as unknown as PtySession,
    )
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory,
    })
    expect(registry.workspaceExists('ws1')).toBe(true)
    expect(registry.workspaceExists('ghost')).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('TerminalSessionRegistry — bulk cleanup', () => {
  it('dropWorkspace kills the agent and every user PTY for that workspace', () => {
    const bus = new TerminalEventBus()
    const agentWs1 = new FakeSession()
    const userWs1a = new FakeSession()
    const userWs1b = new FakeSession()
    const agentWs2 = new FakeSession()
    const userWs2 = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1', ws2: '/tmp/ws2' }),
      factory: fakeFactory([agentWs1, userWs1a, userWs1b, agentWs2, userWs2]),
    })
    registry.getAgent('ws1')
    registry.createUser('ws1')
    registry.createUser('ws1')
    registry.getAgent('ws2')
    registry.createUser('ws2')

    registry.dropWorkspace('ws1')

    expect(agentWs1.exited).not.toBeNull()
    expect(userWs1a.exited).not.toBeNull()
    expect(userWs1b.exited).not.toBeNull()
    expect(registry.hasAgent('ws1')).toBe(false)
    expect(registry.listUser('ws1')).toEqual([])

    // ws2 untouched.
    expect(agentWs2.exited).toBeNull()
    expect(userWs2.exited).toBeNull()
    expect(registry.hasAgent('ws2')).toBe(true)
    expect(registry.listUser('ws2')).toHaveLength(1)
  })

  it('shutdown kills every live session across every workspace', () => {
    const bus = new TerminalEventBus()
    const fakes = [new FakeSession(), new FakeSession(), new FakeSession(), new FakeSession()]
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/ws1', ws2: '/ws2' }),
      factory: fakeFactory(fakes),
    })
    registry.getAgent('ws1')
    registry.createUser('ws1')
    registry.getAgent('ws2')
    registry.createUser('ws2')

    registry.shutdown()

    for (const f of fakes) expect(f.exited).not.toBeNull()
    expect(registry.hasAgent('ws1')).toBe(false)
    expect(registry.hasAgent('ws2')).toBe(false)
    expect(registry.listUser('ws1')).toEqual([])
    expect(registry.listUser('ws2')).toEqual([])
  })
})

describe('TerminalSessionRegistry — agent shell (unified dock)', () => {
  it('get-or-creates ONE stable user session that appears in listUser', () => {
    const factory = vi.fn(() => new FakeSession() as unknown as PtySession)
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory,
    })
    const a = registry.getOrCreateAgentShell('ws1')
    const b = registry.getOrCreateAgentShell('ws1')
    expect(a).not.toBeNull()
    expect(a).toBe(b) // reused, not re-spawned
    expect(factory).toHaveBeenCalledTimes(1)
    // Shows up as a normal user tab (so the dock lists it like a human shell).
    expect(registry.listUser('ws1')).toEqual(['agent'])
  })

  it('emits output tagged kind:user (indistinguishable from a human shell)', () => {
    const bus = new TerminalEventBus()
    const fake = new FakeSession()
    const registry = new TerminalSessionRegistry({
      bus,
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => fake as unknown as PtySession,
    })
    const events: Array<{ type: string; kind?: string; terminalId?: string | null }> = []
    bus.subscribe((ev) => events.push(ev as typeof events[number]))
    registry.getOrCreateAgentShell('ws1')
    fake.emitData('npm test\n')
    // Creation announces a `terminal.created` (so the dock adds a tab live),
    // then output streams — both tagged kind:user, terminalId 'agent'.
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'terminal.created', kind: 'user', terminalId: 'agent' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'terminal.output', kind: 'user', terminalId: 'agent' }),
    )
  })

  it('is NOT reaped by cleanupByThread (workspace-stable)', () => {
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      factory: () => new FakeSession() as unknown as PtySession,
    })
    registry.getOrCreateAgentShell('ws1')
    registry.cleanupByThread('some-thread')
    expect(registry.listUser('ws1')).toEqual(['agent'])
  })

  it('returns null when the workspace path is unresolvable', () => {
    const registry = new TerminalSessionRegistry({
      bus: new TerminalEventBus(),
      workspaces: makeResolver({}),
    })
    expect(registry.getOrCreateAgentShell('ghost')).toBeNull()
  })
})
