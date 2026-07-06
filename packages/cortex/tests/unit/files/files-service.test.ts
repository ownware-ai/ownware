import { describe, expect, it, vi } from 'vitest'
import {
  createFilesService,
  type DiffSide,
  type FileEntry,
  type FileWatcher,
  FilesEventBus,
  type GitAdapter,
  type LoadDiffResult,
  type WorkspaceResolver,
} from '../../../src/files/index.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeResolver(paths: Record<string, string>): WorkspaceResolver {
  return { getWorkspacePath: (id) => paths[id] ?? null }
}

function makeStubAdapter(overrides: Partial<GitAdapter> = {}): GitAdapter {
  return {
    isGitRepo: vi.fn(async (_root: string) => true),
    listStatus: vi.fn(async (_root: string): Promise<FileEntry[]> => []),
    loadDiff: vi.fn(
      async (
        _root: string,
        _path: string,
        _side: DiffSide,
      ): Promise<LoadDiffResult> => ({
        diff: '', truncated: false, kind: 'diff',
      }),
    ),
    showHead: vi.fn(async (_root: string, _path: string): Promise<string | null> => null),
    ...overrides,
  }
}

function makeFakeWatcher(): {
  watcher: FileWatcher
  fire: () => void
  stopped: boolean
} {
  let fire: (() => void) | null = null
  const shell = { stopped: false }
  const watcher: FileWatcher = {
    async stop() { shell.stopped = true },
  }
  return {
    watcher,
    get stopped() { return shell.stopped },
    fire: () => fire?.(),
    // `fire` is set after the factory runs; we rewire via closure below.
  } as unknown as { watcher: FileWatcher; fire: () => void; stopped: boolean }
}

// Simpler: expose a factory that captures the onChange callback so
// the test can invoke it at will.
function wireFakeWatcher(): {
  factory: (
    root: string,
    onChange: () => void,
  ) => FileWatcher
  fire: () => void
  stopped(): boolean
} {
  let captured: (() => void) | null = null
  let stopped = false
  return {
    factory: (_root, onChange) => {
      captured = onChange
      return {
        async stop() { stopped = true },
      }
    },
    fire: () => captured?.(),
    stopped: () => stopped,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFilesService — list()', () => {
  it('returns workspace_unknown when the resolver returns null', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({}),
      bus,
      adapter: makeStubAdapter(),
    })
    const res = await svc.list('ghost')
    expect(res).toEqual({ ok: false, reason: 'workspace_unknown' })
  })

  it('returns not_git_repo when isGitRepo is false', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({
        isGitRepo: async () => false,
      }),
    })
    const res = await svc.list('ws1')
    expect(res).toEqual({ ok: false, reason: 'not_git_repo' })
  })

  it('returns items from listStatus on a git repo', async () => {
    const bus = new FilesEventBus()
    const items: FileEntry[] = [
      { path: 'README.md', status: 'modified', staged: false },
    ]
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({
        isGitRepo: async () => true,
        listStatus: async () => items,
      }),
    })
    const res = await svc.list('ws1')
    expect(res).toEqual({ ok: true, items })
  })

  it('reuses cached items across repeated list() calls within a watcher tick', async () => {
    const bus = new FilesEventBus()
    const listStatus = vi.fn(async (): Promise<FileEntry[]> => [
      { path: 'A.md', status: 'modified', staged: false },
    ])
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({ isGitRepo: async () => true, listStatus }),
    })
    await svc.list('ws1')
    await svc.list('ws1')
    expect(listStatus).toHaveBeenCalledTimes(1)
  })
})

describe('createFilesService — diff()', () => {
  it('returns workspace_unknown for a missing workspace', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({}),
      bus,
      adapter: makeStubAdapter(),
    })
    const res = await svc.diff('ghost', 'x.ts', 'unstaged')
    expect(res).toEqual({ ok: false, reason: 'workspace_unknown' })
  })

  it('rejects path_traversal at the service boundary', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter(),
    })
    const res = await svc.diff('ws1', '../escape', 'unstaged')
    expect(res).toEqual({ ok: false, reason: 'path_traversal' })
  })

  it('rejects blocked_path for .env', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter(),
    })
    const res = await svc.diff('ws1', '.env', 'unstaged')
    expect(res).toEqual({ ok: false, reason: 'blocked_path' })
  })

  it('returns ok with the adapter value on happy path', async () => {
    const bus = new FilesEventBus()
    const value: LoadDiffResult = {
      diff: 'diff --git a/x b/x\n+hi\n',
      truncated: false,
      kind: 'diff',
    }
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({ loadDiff: async () => value }),
    })
    const res = await svc.diff('ws1', 'README.md', 'unstaged')
    expect(res).toEqual({ ok: true, value })
  })
})

describe('createFilesService — subscribe + watcher', () => {
  it('lazy-starts a watcher on first subscribe and tears it down on last unsubscribe', async () => {
    const bus = new FilesEventBus()
    const w = wireFakeWatcher()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter(),
      watcherFactory: (root, onChange) => w.factory(root, onChange),
    })
    const unsub = svc.subscribe('ws1', () => {})
    // Let the async `subscribe` warmup finish.
    await new Promise((r) => setTimeout(r, 0))
    expect(w.stopped()).toBe(false)
    unsub()
    // The service calls `stop()` without awaiting, so give the
    // microtask a chance to run.
    await new Promise((r) => setTimeout(r, 0))
    expect(w.stopped()).toBe(true)
  })

  it('keeps the watcher alive while any subscriber remains', async () => {
    const bus = new FilesEventBus()
    const w = wireFakeWatcher()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter(),
      watcherFactory: (root, onChange) => w.factory(root, onChange),
    })
    const un1 = svc.subscribe('ws1', () => {})
    const un2 = svc.subscribe('ws1', () => {})
    await new Promise((r) => setTimeout(r, 0))
    un1()
    await new Promise((r) => setTimeout(r, 0))
    expect(w.stopped()).toBe(false)
    un2()
    await new Promise((r) => setTimeout(r, 0))
    expect(w.stopped()).toBe(true)
  })

  it('emits a validated files.updated event when the watcher fires', async () => {
    const bus = new FilesEventBus()
    const w = wireFakeWatcher()
    const items: FileEntry[] = [
      { path: 'README.md', status: 'modified', staged: false },
    ]
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({
        isGitRepo: async () => true,
        listStatus: async () => items,
      }),
      watcherFactory: (root, onChange) => w.factory(root, onChange),
    })
    const received: unknown[] = []
    svc.subscribe('ws1', (ev) => received.push(ev))
    // Wait for the initial warmup emit.
    await new Promise((r) => setTimeout(r, 5))
    // Fire a watcher tick manually.
    w.fire()
    await new Promise((r) => setTimeout(r, 5))
    expect(received.length).toBeGreaterThanOrEqual(1)
    const last = received[received.length - 1] as {
      type: string
      workspaceId: string
      items: FileEntry[]
    }
    expect(last).toMatchObject({
      type: 'files.updated',
      workspaceId: 'ws1',
      items,
    })
  })

  it('does not emit when the workspace is not a repo', async () => {
    const bus = new FilesEventBus()
    const w = wireFakeWatcher()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/tmp/ws1' }),
      bus,
      adapter: makeStubAdapter({ isGitRepo: async () => false }),
      watcherFactory: (root, onChange) => w.factory(root, onChange),
    })
    const received: unknown[] = []
    svc.subscribe('ws1', (ev) => received.push(ev))
    await new Promise((r) => setTimeout(r, 5))
    expect(received).toEqual([])
  })
})

describe('createFilesService — shutdown()', () => {
  it('closes every live watcher', async () => {
    const bus = new FilesEventBus()
    const stops: boolean[] = [false, false]
    const factories = stops.map((_, i) => ({
      factory: (_root: string, _on: () => void): FileWatcher => ({
        async stop() { stops[i] = true },
      }),
    }))
    // Round-robin the factory so each workspace gets a distinct
    // watcher in the `stops` array.
    let n = 0
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/ws1', ws2: '/ws2' }),
      bus,
      adapter: makeStubAdapter(),
      watcherFactory: (root, onChange) => {
        const f = factories[n++]!.factory
        return f(root, onChange)
      },
    })
    svc.subscribe('ws1', () => {})
    svc.subscribe('ws2', () => {})
    await new Promise((r) => setTimeout(r, 5))
    await svc.shutdown()
    expect(stops).toEqual([true, true])
  })

  it('shutdown is safe to call twice', async () => {
    const bus = new FilesEventBus()
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: '/ws1' }),
      bus,
      adapter: makeStubAdapter(),
      watcherFactory: (_r, _o) => ({ async stop() {} }),
    })
    svc.subscribe('ws1', () => {})
    await new Promise((r) => setTimeout(r, 0))
    await svc.shutdown()
    await expect(svc.shutdown()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// original() — HEAD content for the diff editor's "original" side
// ---------------------------------------------------------------------------

describe('FilesService.original', () => {
  function svc(overrides: Parameters<typeof makeStubAdapter>[0] = {}) {
    return createFilesService({
      workspaces: makeResolver({ ws1: '/ws1' }),
      bus: new FilesEventBus(),
      adapter: makeStubAdapter(overrides),
      watcherFactory: (_r, _o) => ({ async stop() {} }),
    })
  }

  it('returns HEAD content for a tracked file', async () => {
    const res = await svc({ showHead: vi.fn(async () => 'export const x = 1\n') }).original('ws1', 'src/x.ts')
    expect(res).toEqual({ ok: true, content: 'export const x = 1\n' })
  })

  it('returns null content for a path not in HEAD (new file)', async () => {
    const res = await svc({ showHead: vi.fn(async () => null) }).original('ws1', 'new.ts')
    expect(res).toEqual({ ok: true, content: null })
  })

  it('rejects an unknown workspace', async () => {
    const bad = createFilesService({
      workspaces: makeResolver({}),
      bus: new FilesEventBus(),
      adapter: makeStubAdapter(),
      watcherFactory: (_r, _o) => ({ async stop() {} }),
    })
    expect(await bad.original('ghost', 'a.ts')).toEqual({ ok: false, reason: 'workspace_unknown' })
  })

  it('rejects a non-git workspace', async () => {
    const res = await svc({ isGitRepo: vi.fn(async () => false) }).original('ws1', 'a.ts')
    expect(res).toEqual({ ok: false, reason: 'not_git_repo' })
  })

  it('rejects path traversal', async () => {
    const res = await svc().original('ws1', '../../etc/passwd')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('path_traversal')
  })
})

// ---------------------------------------------------------------------------
// tree() — lazy directory listing for the coder explorer (real filesystem)
// ---------------------------------------------------------------------------

describe('FilesService.tree', () => {
  async function makeRepoDir(): Promise<string> {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'cortex-tree-'))
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'src', 'api'))
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# hi\n')
    await writeFile(join(root, 'package.json'), '{}\n')
    await writeFile(join(root, 'src', 'index.ts'), 'export {}\n')
    await writeFile(join(root, 'src', 'api', 'auth.ts'), 'export {}\n')
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), '\n')
    return root
  }

  function svcFor(root: string) {
    return createFilesService({
      workspaces: makeResolver({ ws1: root }),
      bus: new FilesEventBus(),
      adapter: makeStubAdapter(),
      watcherFactory: (_r, _o) => ({ async stop() {} }),
    })
  }

  it('lists the root: dirs first, files after, noise pruned, no git needed', async () => {
    const root = await makeRepoDir()
    // Note: adapter.isGitRepo isn't consulted by tree() — prove it by using
    // an adapter that would FAIL the repo check.
    const svc = createFilesService({
      workspaces: makeResolver({ ws1: root }),
      bus: new FilesEventBus(),
      adapter: makeStubAdapter({ isGitRepo: vi.fn(async () => false) }),
      watcherFactory: (_r, _o) => ({ async stop() {} }),
    })
    const res = await svc.tree('ws1', '')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Dirs first; files case-insensitive alphabetical (VS Code-style),
    // so `package.json` precedes `README.md`.
    expect(res.entries).toEqual([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'package.json', path: 'package.json', type: 'file' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ])
    // node_modules and .git are pruned by the shared ignore set.
    expect(res.entries.some((e) => e.name === 'node_modules')).toBe(false)
    expect(res.entries.some((e) => e.name === '.git')).toBe(false)
  })

  it('lists a subdirectory with workspace-relative forward-slash paths', async () => {
    const root = await makeRepoDir()
    const res = await svcFor(root).tree('ws1', 'src')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entries).toEqual([
      { name: 'api', path: 'src/api', type: 'dir' },
      { name: 'index.ts', path: 'src/index.ts', type: 'file' },
    ])
  })

  it('rejects an unknown workspace', async () => {
    const res = await svcFor('/nope').tree('ghost', '')
    expect(res).toEqual({ ok: false, reason: 'workspace_unknown' })
  })

  it('rejects path traversal outside the root', async () => {
    const root = await makeRepoDir()
    const res = await svcFor(root).tree('ws1', '../..')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('path_traversal')
  })

  it('404s a missing directory', async () => {
    const root = await makeRepoDir()
    const res = await svcFor(root).tree('ws1', 'does-not-exist')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not_found')
  })

  it('rejects a file path as not_a_directory', async () => {
    const root = await makeRepoDir()
    const res = await svcFor(root).tree('ws1', 'README.md')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('not_a_directory')
  })
})
