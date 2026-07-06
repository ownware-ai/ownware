import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createFilesHandlers } from '../../../src/gateway/handlers/files.js'
import {
  FilesEventBus,
  type FileEntry,
  type FilesService,
  type LoadDiffResult,
} from '../../../src/files/index.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Captured {
  status: number
  body: unknown
  headers: Record<string, string>
}

function mockReq(urlSuffix = ''): IncomingMessage {
  const req = {
    url: `/api/v1/workspaces/ws1/files${urlSuffix}`,
    headers: { host: 'localhost' },
    method: 'GET',
    on: () => req,
  } as unknown as IncomingMessage
  return req
}

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, body: null, headers: {} }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      if (headers != null) Object.assign(captured.headers, headers)
      return this
    },
    end(payload?: string) {
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

function makeFakeService(overrides: Partial<FilesService> = {}): FilesService {
  return {
    list: vi.fn(async () => ({ ok: true, items: [] as FileEntry[] })),
    diff: vi.fn(async () => ({
      ok: true,
      value: { diff: '', truncated: false, kind: 'diff' } as LoadDiffResult,
    })),
    subscribe: vi.fn(() => () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  } as FilesService
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// GET /files
// ---------------------------------------------------------------------------

describe('GET /api/v1/workspaces/:wsId/files', () => {
  it('returns 200 with the items on the happy path', async () => {
    const items: FileEntry[] = [
      { path: 'README.md', status: 'modified', staged: false },
    ]
    const service = makeFakeService({
      list: vi.fn(async () => ({ ok: true, items })),
    })
    const { listFiles } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await listFiles(mockReq(), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ items })
  })

  it('returns 404 workspace_unknown when the service rejects', async () => {
    const service = makeFakeService({
      list: vi.fn(async () => ({ ok: false, reason: 'workspace_unknown' })),
    })
    const { listFiles } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await listFiles(mockReq(), res, { wsId: 'ghost' })
    await flush()
    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({
      error: 'workspace_unknown',
      message: expect.stringContaining('ghost'),
    })
  })

  it('returns 404 not_git_repo for a workspace without .git', async () => {
    const service = makeFakeService({
      list: vi.fn(async () => ({ ok: false, reason: 'not_git_repo' })),
    })
    const { listFiles } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await listFiles(mockReq(), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(404)
    const body = captured.body as { error: string }
    expect(body.error).toBe('not_git_repo')
  })
})

// ---------------------------------------------------------------------------
// GET /files/diff
// ---------------------------------------------------------------------------

describe('GET /api/v1/workspaces/:wsId/files/diff', () => {
  it('returns 200 with the diff on the happy path', async () => {
    const value: LoadDiffResult = {
      diff: 'diff --git a/x b/x\n+hi\n',
      truncated: false,
      kind: 'diff',
    }
    const service = makeFakeService({
      diff: vi.fn(async () => ({ ok: true, value })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=README.md'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      path: 'README.md',
      side: 'unstaged',
      kind: 'diff',
      diff: value.diff,
      truncated: false,
    })
  })

  it('defaults side to unstaged when omitted', async () => {
    const diffSpy = vi.fn(async () => ({
      ok: true as const,
      value: { diff: '', truncated: false, kind: 'diff' as const },
    }))
    const service = makeFakeService({ diff: diffSpy })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res } = mockRes()
    await getDiff(mockReq('/diff?path=README.md'), res, { wsId: 'ws1' })
    await flush()
    expect(diffSpy).toHaveBeenCalledWith('ws1', 'README.md', 'unstaged')
  })

  it('passes through side=staged', async () => {
    const diffSpy = vi.fn(async () => ({
      ok: true as const,
      value: { diff: '', truncated: false, kind: 'diff' as const },
    }))
    const service = makeFakeService({ diff: diffSpy })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res } = mockRes()
    await getDiff(mockReq('/diff?path=README.md&side=staged'), res, { wsId: 'ws1' })
    await flush()
    expect(diffSpy).toHaveBeenCalledWith('ws1', 'README.md', 'staged')
  })

  it('400 bad_request when side is neither unstaged nor staged', async () => {
    const service = makeFakeService()
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=README.md&side=banana'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(400)
    expect((captured.body as { error: string }).error).toBe('bad_request')
  })

  it('400 bad_request when path is missing', async () => {
    const service = makeFakeService()
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(400)
    expect((captured.body as { error: string }).error).toBe('bad_request')
  })

  it('400 path_traversal when the service rejects an escape attempt', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({ ok: false, reason: 'path_traversal' })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=../../etc/passwd'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(400)
    expect((captured.body as { error: string }).error).toBe('path_traversal')
  })

  it('403 blocked_path for protected files like .env', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({ ok: false, reason: 'blocked_path' })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=.env'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(403)
    expect((captured.body as { error: string }).error).toBe('blocked_path')
  })

  it('404 not_found for a missing file', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=ghost.md'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(404)
    expect((captured.body as { error: string }).error).toBe('not_found')
  })

  it('404 not_git_repo when the workspace has no .git', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({ ok: false, reason: 'not_git_repo' })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=README.md'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(404)
    expect((captured.body as { error: string }).error).toBe('not_git_repo')
  })

  it('returns truncated: true when the service truncated a large diff', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({
        ok: true as const,
        value: { diff: 'x'.repeat(100), truncated: true, kind: 'diff' as const },
      })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=big.txt'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(200)
    expect((captured.body as { truncated: boolean }).truncated).toBe(true)
  })

  it('passes kind: new-file through the response', async () => {
    const service = makeFakeService({
      diff: vi.fn(async () => ({
        ok: true as const,
        value: {
          diff: '--- /dev/null\n+++ b/x\n+hi\n',
          truncated: false,
          kind: 'new-file' as const,
        },
      })),
    })
    const { getDiff } = createFilesHandlers({ service, bus: new FilesEventBus() })
    const { res, captured } = mockRes()
    await getDiff(mockReq('/diff?path=x'), res, { wsId: 'ws1' })
    await flush()
    expect((captured.body as { kind: string }).kind).toBe('new-file')
  })
})

// ---------------------------------------------------------------------------
// Structural — factory shape
// ---------------------------------------------------------------------------

describe('createFilesHandlers — factory surface', () => {
  it('exposes exactly the handlers the router registers', () => {
    const handlers = createFilesHandlers({
      service: makeFakeService(),
      bus: new FilesEventBus(),
    })
    expect(Object.keys(handlers).sort()).toEqual([
      'getDiff',
      'getOriginal',
      'listFiles',
      'listTree',
      'streamEvents',
    ])
  })
})

// ---------------------------------------------------------------------------
// SSE open-time rejection (no connection for non-git / unknown workspaces)
// ---------------------------------------------------------------------------

describe('GET /api/v1/workspaces/:wsId/files/events (pre-open checks)', () => {
  it('rejects with 404 not_git_repo when the workspace is not a repo', async () => {
    const service = makeFakeService({
      list: vi.fn(async () => ({ ok: false, reason: 'not_git_repo' })),
    })
    const { streamEvents } = createFilesHandlers({
      service,
      bus: new FilesEventBus(),
    })
    const { res, captured } = mockRes()
    await streamEvents(mockReq('/events'), res, { wsId: 'ws1' })
    await flush()
    expect(captured.status).toBe(404)
    expect((captured.body as { error: string }).error).toBe('not_git_repo')
  })

  it('rejects with 404 workspace_unknown for an unknown wsId', async () => {
    const service = makeFakeService({
      list: vi.fn(async () => ({ ok: false, reason: 'workspace_unknown' })),
    })
    const { streamEvents } = createFilesHandlers({
      service,
      bus: new FilesEventBus(),
    })
    const { res, captured } = mockRes()
    await streamEvents(mockReq('/events'), res, { wsId: 'ghost' })
    await flush()
    expect(captured.status).toBe(404)
    expect((captured.body as { error: string }).error).toBe('workspace_unknown')
  })
})
