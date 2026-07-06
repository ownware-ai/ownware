import { describe, it, expect, vi } from 'vitest'
import { execute } from '../shell.js'
import type { ToolContext, ToolProgress, ToolResult } from '../../types.js'
import type { LoomConfig } from '../../../core/config.js'
import type {
  ShellSessionClient,
  ShellSessionInfo,
  ShellSessionReadResult,
} from '../shell-session-client.js'

/**
 * Session-action tests for `shell_execute`. Validates the dispatch
 * layer in shell.ts that routes `action: "spawn" | "read" | ...`
 * through the injected ShellSessionClient — NOT the gateway HTTP
 * layer (that lives in Cortex and is tested separately).
 *
 * Every test uses a fake client so the assertions pin the contract
 * between Loom (tool) and Cortex (client implementor), independent
 * of any network transport.
 */

// ---------------------------------------------------------------------------
// Fake client + context helpers
// ---------------------------------------------------------------------------

function createFakeClient(
  overrides: Partial<ShellSessionClient> = {},
): ShellSessionClient {
  const defaultInfo: ShellSessionInfo = {
    id: 'sess_1',
    status: 'running',
    exitCode: null,
    pid: 5555,
    createdAt: '2026-04-23T00:00:00.000Z',
    parentThreadId: null,
    parentAgent: null,
  }
  return {
    spawn: vi.fn(async () => ({ id: 'sess_1', info: defaultInfo })),
    read: vi.fn(
      async (): Promise<ShellSessionReadResult> => ({
        lines: [],
        totalLines: 0,
        offset: 0,
        hasMore: false,
        filter: null,
      }),
    ),
    readAgent: vi.fn(
      async (): Promise<ShellSessionReadResult> => ({
        lines: [],
        totalLines: 0,
        offset: 0,
        hasMore: false,
        filter: null,
      }),
    ),
    write: vi.fn(async () => undefined),
    signal: vi.fn(async () => undefined),
    list: vi.fn(async () => [] as readonly ShellSessionInfo[]),
    kill: vi.fn(async () => undefined),
    dump: vi.fn(async () => ({
      path: '/tmp/sessions/sess_1/log.txt',
      byteLength: 0,
      lineCount: 0,
      preview: [],
    })),
    ...overrides,
  }
}

function makeContext(
  client: ShellSessionClient | null,
): ToolContext {
  const config = (
    client != null ? { shellSessionClient: client } : {}
  ) as unknown as LoomConfig
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: process.cwd(),
    config,
    requestPermission: vi.fn().mockResolvedValue(true),
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

async function drain(
  gen: AsyncGenerator<ToolProgress, ToolResult>,
): Promise<ToolResult> {
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  return next.value
}

async function runTool(
  input: Record<string, unknown>,
  client: ShellSessionClient | null,
): Promise<ToolResult> {
  const gen = execute.execute(input, makeContext(client)) as AsyncGenerator<
    ToolProgress,
    ToolResult
  >
  return drain(gen)
}

// ---------------------------------------------------------------------------
// no-client fallback
// ---------------------------------------------------------------------------

describe('shell_execute — session actions without a client', () => {
  it('returns a clear error when no shellSessionClient is wired up', async () => {
    const r = await runTool({ action: 'spawn', command: 'npm run dev' }, null)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/no shellSessionClient|persistent-shell/i)
    expect(r.metadata?.reason).toBe('no_client')
  })

  it('does NOT downgrade session actions to `run` when the client is missing', async () => {
    // Key invariant: if the agent asks for "spawn" and the host has
    // no session backend, we MUST fail loudly — never silently run
    // the command as a one-shot and confuse the agent's state.
    const r = await runTool({ action: 'spawn', command: 'echo hello' }, null)
    expect(r.isError).toBe(true)
    expect(r.content).not.toContain('hello') // proves we didn't execute it
  })
})

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('shell_execute — action: spawn', () => {
  it('calls client.spawn with the command and returns session_id + info', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'spawn', command: 'npm run dev', title: 'Dev Server' },
      client,
    )
    expect(client.spawn).toHaveBeenCalledWith({
      command: 'npm run dev',
      title: 'Dev Server',
    })
    expect(r.isError).toBe(false)
    expect(r.metadata?.sessionAction).toBe('spawn')
    expect(r.metadata?.sessionId).toBe('sess_1')
  })

  it('forwards notifyOnExit + timeoutSeconds to the client', async () => {
    const client = createFakeClient()
    await runTool(
      {
        action: 'spawn',
        command: 'npm run build',
        notifyOnExit: true,
        timeoutSeconds: 900,
      },
      client,
    )
    expect(client.spawn).toHaveBeenCalledWith({
      command: 'npm run build',
      notifyOnExit: true,
      timeoutSeconds: 900,
    })
  })

  it('content mentions the exit-event pattern when notifyOnExit=true', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'spawn', command: 'npm test', notifyOnExit: true },
      client,
    )
    expect(r.content).toMatch(/terminal\.exited|do not poll|notify/i)
  })

  it('errors when `command` is missing on spawn', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'spawn' }, client)
    expect(r.isError).toBe(true)
    expect(client.spawn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe('shell_execute — action: read', () => {
  it('renders lines in cat -n style and echoes pagination metadata', async () => {
    const client = createFakeClient({
      read: vi.fn(async () => ({
        lines: [
          { lineNumber: 1, text: 'starting' },
          { lineNumber: 2, text: 'ready on :3000' },
        ],
        totalLines: 2,
        offset: 0,
        hasMore: false,
        filter: null,
      })),
    })
    const r = await runTool({ action: 'read', session_id: 'sess_1' }, client)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/^\s+1\s+starting/m)
    expect(r.content).toMatch(/^\s+2\s+ready on :3000/m)
    expect(r.content).toMatch(/totalLines=2/)
    expect(r.content).toMatch(/hasMore=false/)
  })

  it('surfaces filter info in the footer when a pattern matched', async () => {
    const client = createFakeClient({
      read: vi.fn(async () => ({
        lines: [
          { lineNumber: 3, text: 'error: port busy' },
          { lineNumber: 7, text: 'error: giving up' },
        ],
        totalLines: 2,
        offset: 0,
        hasMore: false,
        filter: { pattern: 'error', ignoreCase: false, matchCount: 2 },
      })),
    })
    const r = await runTool(
      {
        action: 'read',
        session_id: 'sess_1',
        pattern: 'error',
      },
      client,
    )
    expect(r.content).toMatch(/filter: \/error\/.*2 matches/)
    // Original line numbers preserved across pagination of matches.
    expect(r.content).toMatch(/^\s+3\s+error: port busy/m)
    expect(r.content).toMatch(/^\s+7\s+error: giving up/m)
  })

  it('shows an explicit "no lines match" hint when pattern produced zero hits', async () => {
    const client = createFakeClient({
      read: vi.fn(async () => ({
        lines: [],
        totalLines: 0,
        offset: 0,
        hasMore: false,
        filter: { pattern: 'foo', ignoreCase: false, matchCount: 0 },
      })),
    })
    const r = await runTool(
      { action: 'read', session_id: 'sess_1', pattern: 'foo' },
      client,
    )
    expect(r.content).toMatch(/no lines match/i)
  })

  it('forwards offset/limit/ignoreCase to the client', async () => {
    const client = createFakeClient()
    await runTool(
      {
        action: 'read',
        session_id: 'sess_1',
        offset: 50,
        limit: 100,
        pattern: 'ERROR',
        ignoreCase: true,
      },
      client,
    )
    expect(client.read).toHaveBeenCalledWith({
      id: 'sess_1',
      offset: 50,
      limit: 100,
      pattern: 'ERROR',
      ignoreCase: true,
    })
  })

  it('errors when session_id is missing', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'read' }, client)
    expect(r.isError).toBe(true)
    expect(client.read).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// write / signal / list / kill
// ---------------------------------------------------------------------------

describe('shell_execute — action: read-agent', () => {
  it('calls client.readAgent (no session_id) with offset/limit/pattern forwarded', async () => {
    const client = createFakeClient({
      readAgent: vi.fn(async () => ({
        lines: [
          { lineNumber: 1, text: '$ pytest -v' },
          { lineNumber: 2, text: 'collected 0 items' },
        ],
        totalLines: 2,
        offset: 0,
        hasMore: false,
        filter: null,
      })),
    })
    const r = await runTool(
      {
        action: 'read-agent',
        offset: 0,
        limit: 200,
        pattern: 'pytest',
        ignoreCase: false,
      },
      client,
    )
    expect(r.isError).toBe(false)
    expect(client.readAgent).toHaveBeenCalledWith({
      offset: 0,
      limit: 200,
      pattern: 'pytest',
      ignoreCase: false,
    })
    // Lines rendered cat -n style, same as `read`.
    expect(r.content).toMatch(/^\s+1\s+\$ pytest -v/m)
    expect(r.content).toMatch(/^\s+2\s+collected 0 items/m)
    expect(r.metadata?.sessionAction).toBe('read-agent')
  })

  it('does NOT require session_id (the agent PTY is singular per workspace)', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'read-agent' }, client)
    expect(r.isError).toBe(false)
    expect(client.readAgent).toHaveBeenCalled()
    // Crucially, the `read` method for user sessions must NOT be
    // called — otherwise a missing session_id would slip through.
    expect(client.read).not.toHaveBeenCalled()
  })

  it('surfaces a "no lines match" hint when the filter produced zero hits', async () => {
    const client = createFakeClient({
      readAgent: vi.fn(async () => ({
        lines: [],
        totalLines: 0,
        offset: 0,
        hasMore: false,
        filter: { pattern: 'xyz', ignoreCase: false, matchCount: 0 },
      })),
    })
    const r = await runTool(
      { action: 'read-agent', pattern: 'xyz' },
      client,
    )
    expect(r.content).toMatch(/no lines match.*agent terminal/i)
  })

  it('says "agent terminal has no output yet" when buffer is empty and no filter', async () => {
    const client = createFakeClient({
      readAgent: vi.fn(async () => ({
        lines: [],
        totalLines: 0,
        offset: 0,
        hasMore: false,
        filter: null,
      })),
    })
    const r = await runTool({ action: 'read-agent' }, client)
    expect(r.content).toMatch(/no output yet/i)
  })
})

describe('shell_execute — action: write', () => {
  it('forwards session_id + data to client.write', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'write', session_id: 'sess_1', data: 'y\n' },
      client,
    )
    expect(client.write).toHaveBeenCalledWith({ id: 'sess_1', data: 'y\n' })
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/2 bytes/)
  })

  it('errors when data is missing', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'write', session_id: 'sess_1' }, client)
    expect(r.isError).toBe(true)
    expect(client.write).not.toHaveBeenCalled()
  })
})

describe('shell_execute — action: signal', () => {
  it('forwards SIGINT', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'signal', session_id: 'sess_1', signal: 'SIGINT' },
      client,
    )
    expect(client.signal).toHaveBeenCalledWith({
      id: 'sess_1',
      signal: 'SIGINT',
    })
    expect(r.isError).toBe(false)
  })

  it('rejects unknown signals without calling the client', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'signal', session_id: 'sess_1', signal: 'SIGWAT' },
      client,
    )
    expect(r.isError).toBe(true)
    expect(client.signal).not.toHaveBeenCalled()
  })
})

describe('shell_execute — action: list', () => {
  it('returns "(no active sessions)" when empty', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'list' }, client)
    expect(r.content).toMatch(/no active sessions/i)
    expect(r.metadata?.count).toBe(0)
  })

  it('renders one line per session with id + status + agent', async () => {
    const client = createFakeClient({
      list: vi.fn(async () => [
        {
          id: 'sess_1',
          status: 'running',
          exitCode: null,
          pid: 100,
          createdAt: '2026-04-23T00:00:00.000Z',
          parentThreadId: 'thr-A',
          parentAgent: 'coder',
        },
        {
          id: 'sess_2',
          status: 'exited',
          exitCode: 0,
          pid: 200,
          createdAt: '2026-04-23T00:01:00.000Z',
          parentThreadId: null,
          parentAgent: null,
        },
      ]),
    })
    const r = await runTool({ action: 'list' }, client)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/sess_1.*running.*agent=coder/)
    expect(r.content).toMatch(/sess_2.*exited.*exit=0/)
  })
})

describe('shell_execute — action: kill', () => {
  it('forwards session_id to client.kill', async () => {
    const client = createFakeClient()
    const r = await runTool(
      { action: 'kill', session_id: 'sess_1' },
      client,
    )
    expect(client.kill).toHaveBeenCalledWith('sess_1')
    expect(r.isError).toBe(false)
  })

  it('errors when session_id is missing', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'kill' }, client)
    expect(r.isError).toBe(true)
    expect(client.kill).not.toHaveBeenCalled()
  })
})

describe('shell_execute — action: dump (file offload)', () => {
  it('forwards session_id to client.dump and renders path + preview', async () => {
    const client = createFakeClient({
      dump: vi.fn(async () => ({
        path: '/tmp/sessions/sess_1/log.txt',
        byteLength: 12_345,
        lineCount: 820,
        preview: [
          { lineNumber: 1, text: '> npm run build' },
          { lineNumber: 2, text: 'webpack 5.0.0 compiled successfully' },
        ],
      })),
    })
    const r = await runTool(
      { action: 'dump', session_id: 'sess_1' },
      client,
    )
    expect(client.dump).toHaveBeenCalledWith('sess_1')
    expect(r.isError).toBe(false)
    // Agent-facing body must carry both the path (so it can re-read
    // specific windows later) AND the preview (so it has immediate
    // signal without having to issue another call).
    expect(r.content).toContain('/tmp/sessions/sess_1/log.txt')
    expect(r.content).toContain('820 lines')
    expect(r.content).toContain('12345 bytes')
    expect(r.content).toContain('> npm run build')
    expect(r.content).toContain('webpack 5.0.0 compiled')
    // Metadata exposes structured fields for programmatic callers.
    expect(r.metadata?.sessionAction).toBe('dump')
    expect(r.metadata?.path).toBe('/tmp/sessions/sess_1/log.txt')
    expect(r.metadata?.lineCount).toBe(820)
  })

  it('handles an empty buffer gracefully (says "buffer is empty")', async () => {
    const client = createFakeClient({
      dump: vi.fn(async () => ({
        path: '/tmp/sessions/sess_1/log.txt',
        byteLength: 0,
        lineCount: 0,
        preview: [],
      })),
    })
    const r = await runTool(
      { action: 'dump', session_id: 'sess_1' },
      client,
    )
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/buffer is empty/i)
  })

  it('errors when session_id is missing', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'dump' }, client)
    expect(r.isError).toBe(true)
    expect(client.dump).not.toHaveBeenCalled()
  })
})

describe('shell_execute — action: run (backwards-compat)', () => {
  it('is the default when action is omitted — no client required', async () => {
    // Prove the one-shot path is unaffected by the session-action
    // additions: no client, no action field, works like before.
    const r = await runTool({ command: 'echo OK' }, null)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('OK')
  })

  it('action: "run" behaves identically to omitting it', async () => {
    const r = await runTool({ action: 'run', command: 'echo OK-run' }, null)
    expect(r.isError).toBe(false)
    expect(r.content).toContain('OK-run')
  })
})

describe('shell_execute — unknown action', () => {
  it('rejects unknown action with a clear message', async () => {
    const client = createFakeClient()
    const r = await runTool({ action: 'nuke' }, client)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/unknown action/i)
  })
})

describe('shell_execute — backend errors', () => {
  it('wraps client errors with the action name and surfaces metadata', async () => {
    const client = createFakeClient({
      spawn: vi.fn(async () => {
        throw new Error('gateway offline')
      }),
    })
    const r = await runTool(
      { action: 'spawn', command: 'echo x' },
      client,
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/"spawn" failed: gateway offline/)
    expect(r.metadata?.reason).toBe('backend_error')
  })
})
