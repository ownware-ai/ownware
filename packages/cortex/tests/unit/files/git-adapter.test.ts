import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  BlockedPathError,
  PathNotFoundError,
  PathTraversalError,
  __testables,
  createGitAdapter,
  parsePorcelainV1,
  resolveInsideRoot,
} from '../../../src/files/git-adapter.js'

// Access the parser via the module's named export — re-export from
// git-adapter.js since the function is defined there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = parsePorcelainV1 as (b: Buffer) => any

// ---------------------------------------------------------------------------
// Parser — pure, no spawn
// ---------------------------------------------------------------------------

describe('parsePorcelainV1', () => {
  it('parses untracked (??) entries', () => {
    const raw = '?? new.txt\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'new.txt', status: 'untracked', staged: false },
    ])
  })

  it('parses worktree-modified ( M) entries', () => {
    const raw = ' M src/foo.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'src/foo.ts', status: 'modified', staged: false },
    ])
  })

  it('parses index-modified (M ) entries', () => {
    const raw = 'M  src/foo.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'src/foo.ts', status: 'modified', staged: true },
    ])
  })

  it('parses both-sides-modified (MM) as two entries', () => {
    const raw = 'MM src/foo.ts\0'
    const entries = parse(Buffer.from(raw, 'utf8'))
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({
      path: 'src/foo.ts', status: 'modified', staged: true,
    })
    expect(entries).toContainEqual({
      path: 'src/foo.ts', status: 'modified', staged: false,
    })
  })

  it('parses added (A ) entries', () => {
    const raw = 'A  src/new.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'src/new.ts', status: 'added', staged: true },
    ])
  })

  it('parses worktree-deleted ( D) entries', () => {
    const raw = ' D src/gone.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'src/gone.ts', status: 'deleted', staged: false },
    ])
  })

  it('parses renamed (R ) with a second-field old path', () => {
    // R <newPath>\0<oldPath>\0
    const raw = 'R  b.ts\0a.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'b.ts', status: 'renamed', staged: true, renamedFrom: 'a.ts' },
    ])
  })

  it('parses copied (C ) with a second-field old path', () => {
    const raw = 'C  b.ts\0a.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'b.ts', status: 'copied', staged: true, renamedFrom: 'a.ts' },
    ])
  })

  it('classifies conflict markers (UU) as conflict', () => {
    const raw = 'UU conflict.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'conflict.ts', status: 'conflict', staged: false },
    ])
  })

  it('classifies AA as conflict', () => {
    const raw = 'AA conflict.ts\0'
    expect(parse(Buffer.from(raw, 'utf8'))).toEqual([
      { path: 'conflict.ts', status: 'conflict', staged: false },
    ])
  })

  it('returns empty list for empty input', () => {
    expect(parse(Buffer.from('', 'utf8'))).toEqual([])
  })

  it('parses multiple mixed records in one payload', () => {
    const raw = '?? new.txt\0 M foo.ts\0A  bar.ts\0'
    const entries = parse(Buffer.from(raw, 'utf8'))
    expect(entries).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// resolveInsideRoot — path traversal defence
// ---------------------------------------------------------------------------

describe('resolveInsideRoot', () => {
  it('returns the absolute path for a direct child', () => {
    const r = resolveInsideRoot('/tmp/foo', 'bar.ts')
    expect(r.endsWith('/tmp/foo/bar.ts') || r.endsWith('\\tmp\\foo\\bar.ts')).toBe(true)
  })

  it('allows nested descendants', () => {
    const r = resolveInsideRoot('/tmp/foo', 'a/b/c.ts')
    expect(r).toContain('/tmp/foo')
  })

  it('rejects ../escape', () => {
    expect(() => resolveInsideRoot('/tmp/foo', '../sibling')).toThrow(PathTraversalError)
  })

  it('rejects absolute /etc/passwd', () => {
    expect(() => resolveInsideRoot('/tmp/foo', '/etc/passwd')).toThrow(PathTraversalError)
  })

  it('rejects nested ../escape', () => {
    expect(() => resolveInsideRoot('/tmp/foo', 'bar/../../escape')).toThrow(
      PathTraversalError,
    )
  })
})

// ---------------------------------------------------------------------------
// Adapter against a real temp git repo
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore' })
  return res.status === 0
}

const GIT_AVAILABLE = hasGit()
const describeIfGit = GIT_AVAILABLE ? describe : describe.skip

describeIfGit('GitAdapter — real repo', () => {
  const adapter = createGitAdapter()
  let repo = ''

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cortex-files-test-'))
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: repo })
    spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(join(repo, 'tracked.txt'), 'original\n')
    spawnSync('git', ['add', '.'], { cwd: repo })
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  })

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true })
  })

  it('isGitRepo returns true for a repo, false for a plain dir', async () => {
    expect(await adapter.isGitRepo(repo)).toBe(true)
    const plain = mkdtempSync(join(tmpdir(), 'cortex-plain-'))
    try {
      expect(await adapter.isGitRepo(plain)).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('listStatus surfaces a worktree modification', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n')
    const items = await adapter.listStatus(repo)
    expect(items).toContainEqual({
      path: 'tracked.txt', status: 'modified', staged: false,
    })
  })

  it('listStatus surfaces an untracked file', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n')
    const items = await adapter.listStatus(repo)
    expect(items).toContainEqual({
      path: 'new.txt', status: 'untracked', staged: false,
    })
  })

  it('loadDiff returns a real diff for a tracked modification', async () => {
    const res = await adapter.loadDiff(repo, 'tracked.txt', 'unstaged')
    expect(res.kind).toBe('diff')
    expect(res.truncated).toBe(false)
    expect(res.diff).toContain('-original')
    expect(res.diff).toContain('+changed')
  })

  it('loadDiff synthesises a new-file diff for an untracked path', async () => {
    const res = await adapter.loadDiff(repo, 'new.txt', 'unstaged')
    expect(res.kind).toBe('new-file')
    expect(res.diff).toContain('+++ b/new.txt')
    expect(res.diff).toContain('+hello')
  })

  it('loadDiff throws BlockedPathError on a .env target', async () => {
    writeFileSync(join(repo, '.env'), 'SECRET=abc\n')
    await expect(adapter.loadDiff(repo, '.env', 'unstaged')).rejects.toBeInstanceOf(
      BlockedPathError,
    )
  })

  it('loadDiff throws PathTraversalError on escape attempts', async () => {
    await expect(
      adapter.loadDiff(repo, '../escape', 'unstaged'),
    ).rejects.toBeInstanceOf(PathTraversalError)
  })

  it('loadDiff throws PathNotFoundError for a missing path', async () => {
    await expect(
      adapter.loadDiff(repo, 'does-not-exist.txt', 'unstaged'),
    ).rejects.toBeInstanceOf(PathNotFoundError)
  })

  it('loadDiff truncates a >1 MiB new file', async () => {
    // 1.2 MiB of 'x' — well over the 1 MiB cap.
    const big = 'x'.repeat(1_300_000)
    writeFileSync(join(repo, 'big.txt'), big)
    const res = await adapter.loadDiff(repo, 'big.txt', 'unstaged')
    expect(res.kind).toBe('new-file')
    expect(res.truncated).toBe(true)
    // Diff should be under the cap (with header overhead).
    expect(res.diff.length).toBeLessThan(__testables.DIFF_SIZE_CAP_BYTES + 200)
  })
})

if (!GIT_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn('[files] git not available — GitAdapter real-repo tests skipped.')
}
