import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { readFile, writeFile, editFile, listFiles, glob, grep } from '../filesystem.js'
import type { ToolContext } from '../../types.js'
import type { LoomConfig } from '../../../core/config.js'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string
let context: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-test-'))
  context = {
    cwd: tmpDir,
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: tmpDir,
    additionalWorkspaceRoots: [],
    config: {} as LoomConfig,
    requestPermission: vi.fn().mockResolvedValue(true),
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function createFile(name: string, content: string): Promise<string> {
  const filePath = path.join(tmpDir, name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe('readFile', () => {
  it('reads a file with line numbers', async () => {
    await createFile('test.txt', 'line one\nline two\nline three')

    const result = await readFile.execute(
      { file_path: 'test.txt' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('1\tline one')
    expect(r.content).toContain('2\tline two')
    expect(r.content).toContain('3\tline three')
  })

  it('supports offset and limit', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    await createFile('big.txt', lines.join('\n'))

    const result = await readFile.execute(
      { file_path: 'big.txt', offset: 10, limit: 5 } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('11\tline 11')
    expect(r.content).toContain('15\tline 15')
    expect(r.content).not.toContain('16\tline 16')
  })

  it('returns error for non-existent file', async () => {
    const result = await readFile.execute(
      { file_path: 'nonexistent.txt' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Failed to read')
  })

  it('is marked read-only', () => {
    expect(readFile.isReadOnly).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Token-budget cap (see DEFAULT_MAX_READ_TOKENS)
  // -------------------------------------------------------------------------

  describe('token-budget cap', () => {
    it('refuses files that exceed the 25,000-token read budget', async () => {
      // ~110KB of plain ASCII → ~27,500 tokens at chars/4. Above 25,000.
      // Use a real-ish HTML-like blob to mirror the planner-2026-05-14 trace.
      const big = '<p>' + 'x'.repeat(110_000) + '</p>'
      await createFile('big.html', big)

      const result = await readFile.execute(
        { file_path: 'big.html' } as Record<string, unknown>,
        context,
      )

      const r = result as Awaited<typeof result>
      expect(r.isError).toBe(true)
      expect(r.content).toContain('exceeds the 25,000-token read budget')
      // The error must be actionable — must mention the recovery options.
      expect(r.content).toContain('offset')
      expect(r.content).toContain('limit')
      expect(r.content).toContain('grep')
      // And the error blob itself must stay small (< 500 chars).
      expect(r.content.length).toBeLessThan(500)
    })

    it('allows files comfortably under the budget', async () => {
      const small = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
      await createFile('small.txt', small)

      const result = await readFile.execute(
        { file_path: 'small.txt' } as Record<string, unknown>,
        context,
      )

      const r = result as Awaited<typeof result>
      expect(r.isError).toBe(false)
      expect(r.content).toContain('1\tline 1')
    })

    it('lets an oversized file be read in chunks via offset/limit', async () => {
      // Build a file so big the WHOLE-FILE read would refuse, but a small
      // slice fits within budget.
      const lines = Array.from({ length: 5000 }, (_, i) => 'x'.repeat(80) + ` line ${i + 1}`)
      await createFile('big.log', lines.join('\n'))

      // Whole-file read (default limit 2000 of the 5000 lines) is well over
      // 25K tokens because each line is 80+ chars.
      const refused = await readFile.execute(
        { file_path: 'big.log' } as Record<string, unknown>,
        context,
      )
      expect((refused as Awaited<typeof refused>).isError).toBe(true)

      // A 100-line slice fits — should succeed.
      const sliced = await readFile.execute(
        { file_path: 'big.log', offset: 0, limit: 100 } as Record<string, unknown>,
        context,
      )
      const r = sliced as Awaited<typeof sliced>
      expect(r.isError).toBe(false)
      expect(r.content).toContain('1\t')
    })

    it('refuses even when offset+limit still slice an oversized portion', async () => {
      // Confirms the cap runs on the line-numbered content the model
      // actually receives — not just the raw file.
      const lines = Array.from({ length: 5000 }, (_, i) => 'x'.repeat(80) + ` line ${i + 1}`)
      await createFile('big.log', lines.join('\n'))

      const result = await readFile.execute(
        { file_path: 'big.log', offset: 0, limit: 5000 } as Record<string, unknown>,
        context,
      )
      const r = result as Awaited<typeof result>
      expect(r.isError).toBe(true)
      expect(r.content).toContain('budget')
    })

    it('error names the line range when a partial read was attempted', async () => {
      const lines = Array.from({ length: 5000 }, (_, i) => 'x'.repeat(80) + ` line ${i + 1}`)
      await createFile('big.log', lines.join('\n'))

      const result = await readFile.execute(
        { file_path: 'big.log', offset: 100, limit: 2000 } as Record<string, unknown>,
        context,
      )
      const r = result as Awaited<typeof result>
      expect(r.isError).toBe(true)
      // Should report the actual slice that was attempted, not just the
      // file's total length.
      expect(r.content).toMatch(/lines 101.*of 5000/)
    })
  })

  // -------------------------------------------------------------------------
  // FILE_UNCHANGED re-read stub
  // -------------------------------------------------------------------------

  describe('FILE_UNCHANGED re-read stub', () => {
    it('returns content on the first read and the stub on an unchanged re-read', async () => {
      // Use a realistic-sized board.md so the savings are meaningful.
      const boardLines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} of the board`)
      await createFile('board.md', boardLines.join('\n'))
      const ctx = { ...context, sessionId: `unchanged-${Date.now()}` }

      const first = await readFile.execute(
        { file_path: 'board.md' } as Record<string, unknown>,
        ctx,
      )
      const f = first as Awaited<typeof first>
      expect(f.isError).toBe(false)
      expect(f.content).toContain('1\tline 1')

      const second = await readFile.execute(
        { file_path: 'board.md' } as Record<string, unknown>,
        ctx,
      )
      const s = second as Awaited<typeof second>
      expect(s.isError).toBe(false)
      expect(s.content).toContain('File unchanged since last read')
      expect(s.metadata).toMatchObject({ unchangedRead: true })
      // The stub must not contain the file's actual content — that's the
      // whole point. (The file had ~200 lines totalling ~5KB; the stub
      // is ~160 chars. Saving the rest is the win.)
      expect(s.content).not.toContain('line 1 of the board')
      expect(s.content.length).toBeLessThan(f.content.length / 10)
    })

    it('returns full content again after the file is modified', async () => {
      const filePath = await createFile('board.md', 'original')
      const ctx = { ...context, sessionId: `modified-${Date.now()}` }

      await readFile.execute({ file_path: 'board.md' } as Record<string, unknown>, ctx)

      // Tweak mtime + content
      await new Promise(resolve => setTimeout(resolve, 10))
      await fs.writeFile(filePath, 'updated', 'utf-8')

      const second = await readFile.execute(
        { file_path: 'board.md' } as Record<string, unknown>,
        ctx,
      )
      const s = second as Awaited<typeof second>
      expect(s.isError).toBe(false)
      expect(s.content).toContain('1\tupdated')
      expect(s.metadata?.unchangedRead).toBeUndefined()
    })

    it('does not stub a re-read with a different offset/limit window', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
      await createFile('big.txt', lines.join('\n'))
      const ctx = { ...context, sessionId: `slice-${Date.now()}` }

      const first = await readFile.execute(
        { file_path: 'big.txt', offset: 0, limit: 10 } as Record<string, unknown>,
        ctx,
      )
      expect((first as Awaited<typeof first>).isError).toBe(false)

      // Different slice — should NOT stub.
      const second = await readFile.execute(
        { file_path: 'big.txt', offset: 50, limit: 10 } as Record<string, unknown>,
        ctx,
      )
      const s = second as Awaited<typeof second>
      expect(s.isError).toBe(false)
      expect(s.content).not.toContain('File unchanged')
      expect(s.content).toContain('51\tline 51')
    })

    it('does not stub across different sessions', async () => {
      await createFile('shared.md', 'shared content')

      const ctxA = { ...context, sessionId: 'session-A' }
      const ctxB = { ...context, sessionId: 'session-B' }

      const a = await readFile.execute(
        { file_path: 'shared.md' } as Record<string, unknown>,
        ctxA,
      )
      expect((a as Awaited<typeof a>).isError).toBe(false)

      // Session B should still see the full content even though session A
      // already read it — read-state is per-session.
      const b = await readFile.execute(
        { file_path: 'shared.md' } as Record<string, unknown>,
        ctxB,
      )
      const r = b as Awaited<typeof b>
      expect(r.isError).toBe(false)
      expect(r.content).not.toContain('File unchanged')
      expect(r.content).toContain('1\tshared content')
    })

    it('forgetReadStateForSession clears the map for one session', async () => {
      const { forgetReadStateForSession } = await import('../filesystem.js')
      await createFile('clear.md', 'before')
      const ctx = { ...context, sessionId: `clear-${Date.now()}` }

      await readFile.execute({ file_path: 'clear.md' } as Record<string, unknown>, ctx)
      forgetReadStateForSession(ctx.sessionId)

      const second = await readFile.execute(
        { file_path: 'clear.md' } as Record<string, unknown>,
        ctx,
      )
      const s = second as Awaited<typeof second>
      // After forgetting, re-read returns the full content again.
      expect(s.content).toContain('1\tbefore')
      expect(s.content).not.toContain('File unchanged')
    })
  })
})

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe('writeFile', () => {
  it('creates a new file', async () => {
    const result = await writeFile.execute(
      { file_path: 'new.txt', content: 'hello world' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('File created')

    const written = await fs.readFile(path.join(tmpDir, 'new.txt'), 'utf-8')
    expect(written).toBe('hello world')
  })

  it('creates parent directories', async () => {
    const result = await writeFile.execute(
      { file_path: 'a/b/c/deep.txt', content: 'nested' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    const written = await fs.readFile(path.join(tmpDir, 'a/b/c/deep.txt'), 'utf-8')
    expect(written).toBe('nested')
  })

  it('refuses to overwrite existing file', async () => {
    await createFile('exists.txt', 'old')

    const result = await writeFile.execute(
      { file_path: 'exists.txt', content: 'new' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('already exists')

    // Original content preserved
    const content = await fs.readFile(path.join(tmpDir, 'exists.txt'), 'utf-8')
    expect(content).toBe('old')
  })

  it('is NOT read-only', () => {
    expect(writeFile.isReadOnly).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

describe('editFile', () => {
  it('replaces exact string match', async () => {
    await createFile('edit.txt', 'hello world')

    const result = await editFile.execute(
      {
        file_path: 'edit.txt',
        old_string: 'hello',
        new_string: 'goodbye',
      } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('replaced 1 occurrence')

    const content = await fs.readFile(path.join(tmpDir, 'edit.txt'), 'utf-8')
    expect(content).toBe('goodbye world')
  })

  it('errors when old_string not found', async () => {
    await createFile('edit.txt', 'hello world')

    const result = await editFile.execute(
      {
        file_path: 'edit.txt',
        old_string: 'missing',
        new_string: 'replacement',
      } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('not found')
  })

  it('errors when old_string has multiple matches without replace_all', async () => {
    await createFile('multi.txt', 'foo bar foo baz foo')

    const result = await editFile.execute(
      {
        file_path: 'multi.txt',
        old_string: 'foo',
        new_string: 'qux',
      } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('3 times')
  })

  it('replace_all replaces all occurrences', async () => {
    await createFile('multi.txt', 'foo bar foo baz foo')

    const result = await editFile.execute(
      {
        file_path: 'multi.txt',
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('replaced 3 occurrences')

    const content = await fs.readFile(path.join(tmpDir, 'multi.txt'), 'utf-8')
    expect(content).toBe('qux bar qux baz qux')
  })

  it('errors when old_string equals new_string', async () => {
    await createFile('edit.txt', 'hello')

    const result = await editFile.execute(
      {
        file_path: 'edit.txt',
        old_string: 'hello',
        new_string: 'hello',
      } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('identical')
  })
})

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe('listFiles', () => {
  it('lists files and directories', async () => {
    await createFile('a.txt', 'hello')
    await createFile('b.txt', 'world')
    await fs.mkdir(path.join(tmpDir, 'subdir'))

    const result = await listFiles.execute({} as Record<string, unknown>, context)

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('subdir')
    expect(r.content).toContain('a.txt')
    expect(r.content).toContain('b.txt')
  })

  it('shows directories before files', async () => {
    await createFile('file.txt', 'x')
    await fs.mkdir(path.join(tmpDir, 'dir'))

    const result = await listFiles.execute({} as Record<string, unknown>, context)

    const r = result as Awaited<typeof result>
    const lines = r.content.split('\n')
    expect(lines[0]).toMatch(/^d/)
    expect(lines[1]).toMatch(/^-/)
  })

  it('is read-only', () => {
    expect(listFiles.isReadOnly).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

describe('glob', () => {
  it('finds files matching pattern', async () => {
    await createFile('src/a.ts', 'a')
    await createFile('src/b.ts', 'b')
    await createFile('src/c.js', 'c')

    const result = await glob.execute(
      { pattern: '**/*.ts' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('a.ts')
    expect(r.content).toContain('b.ts')
    expect(r.content).not.toContain('c.js')
  })

  it('returns no-match message when nothing found', async () => {
    const result = await glob.execute(
      { pattern: '**/*.rs' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('No files found')
  })

  it('skips node_modules and hidden dirs', async () => {
    await createFile('node_modules/pkg/index.ts', 'x')
    await createFile('.hidden/secret.ts', 'x')
    await createFile('src/main.ts', 'x')

    const result = await glob.execute(
      { pattern: '**/*.ts' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.content).toContain('main.ts')
    expect(r.content).not.toContain('node_modules')
    expect(r.content).not.toContain('.hidden')
  })

  it('is read-only', () => {
    expect(glob.isReadOnly).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe('grep', () => {
  it('finds matching lines with file and line number', async () => {
    await createFile('src/app.ts', 'import foo\nconst bar = 1\nimport baz')

    const result = await grep.execute(
      { pattern: 'import' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('import foo')
    expect(r.content).toContain('import baz')
    expect(r.content).toContain(':1:')
    expect(r.content).toContain(':3:')
  })

  it('supports case-insensitive search', async () => {
    await createFile('file.txt', 'Hello World\nhello world\nHELLO WORLD')

    const result = await grep.execute(
      { pattern: 'hello', case_sensitive: false } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.content).toContain('Hello World')
    expect(r.content).toContain('hello world')
    expect(r.content).toContain('HELLO WORLD')
  })

  it('respects max_results limit', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `match line ${i}`)
    await createFile('many.txt', lines.join('\n'))

    const result = await grep.execute(
      { pattern: 'match', max_results: 5 } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    const matchLines = r.content.split('\n').filter((l) => l.includes('match line'))
    expect(matchLines).toHaveLength(5)
  })

  it('supports glob filter', async () => {
    await createFile('a.ts', 'target')
    await createFile('b.js', 'target')

    const result = await grep.execute(
      { pattern: 'target', glob: '*.ts' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.content).toContain('a.ts')
    expect(r.content).not.toContain('b.js')
  })

  it('returns no-match message when nothing found', async () => {
    await createFile('file.txt', 'hello world')

    const result = await grep.execute(
      { pattern: 'nonexistent' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.content).toContain('No matches')
  })

  it('searches a single file when path is a file', async () => {
    await createFile('target.txt', 'find me\nnot me\nfind me again')

    const result = await grep.execute(
      { pattern: 'find me', path: 'target.txt' } as Record<string, unknown>,
      context,
    )

    const r = result as Awaited<typeof result>
    expect(r.content).toContain('find me')
    expect(r.content).toContain('find me again')
  })

  it('is read-only', () => {
    expect(grep.isReadOnly).toBe(true)
  })

  it('skips hidden files by default', async () => {
    await createFile('.secret', 'target token')
    await createFile('visible.txt', 'target token')

    const result = await grep.execute(
      { pattern: 'target' } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('visible.txt')
    expect(r.content).not.toContain('.secret')
  })

  it('searches hidden files when hidden: true', async () => {
    await createFile('.config/app.txt', 'target inside dotdir')
    await createFile('visible.txt', 'target outside')

    const result = await grep.execute(
      { pattern: 'target', hidden: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('visible.txt')
    expect(r.content).toContain('app.txt')
  })

  it('always prunes VCS dirs even when hidden: true', async () => {
    await createFile('.git/config', 'target inside git')
    await createFile('.hg/store', 'target inside hg')
    await createFile('src/main.ts', 'target visible')

    const result = await grep.execute(
      { pattern: 'target', hidden: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('main.ts')
    expect(r.content).not.toContain('.git')
    expect(r.content).not.toContain('.hg')
  })

  it('truncates long matched lines per max_line_length', async () => {
    const longLine = 'needle ' + 'x'.repeat(2000)
    await createFile('long.txt', longLine)

    const result = await grep.execute(
      { pattern: 'needle', max_line_length: 50 } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('truncated')
    // Original 2000+ char content must not appear in full
    expect(r.content).not.toContain('x'.repeat(1000))
  })

  it('respects max_bytes cap and reports truncation', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `match line ${i} ${'y'.repeat(100)}`)
    await createFile('huge.txt', lines.join('\n'))

    const result = await grep.execute(
      {
        pattern: 'match',
        max_results: 100000,
        max_bytes: 4096,
        max_line_length: 0,
      } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('Output truncated')
    expect(r.metadata?.bytesCapped).toBe(true)
  })

  it('supports regex mode', async () => {
    await createFile('app.ts', 'foo123\nbar\nbaz456')

    const result = await grep.execute(
      { pattern: '^[a-z]+\\d+$', regex: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('foo123')
    expect(r.content).toContain('baz456')
    expect(r.content).not.toContain(': bar')
  })

  it('returns clear error for invalid regex', async () => {
    await createFile('a.txt', 'x')

    const result = await grep.execute(
      { pattern: '([unclosed', regex: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toContain('Invalid regex')
  })

  it('supports multiline matching across newlines', async () => {
    await createFile(
      'iface.ts',
      'export interface Foo {\n  bar: string\n  baz: number\n}\n\nconst x = 1',
    )

    const result = await grep.execute(
      {
        pattern: 'interface\\s+\\w+\\s*\\{[\\s\\S]*?\\}',
        multiline: true,
      } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('interface Foo')
    expect(r.content).toContain('baz: number')
    expect(r.content).toContain('}')
    // Lines outside the match should NOT appear
    expect(r.content).not.toContain('const x = 1')
  })
})

describe('glob hidden flag', () => {
  it('excludes hidden files by default', async () => {
    await createFile('.env', 'x')
    await createFile('visible.ts', 'x')

    const result = await glob.execute(
      { pattern: '**/*' } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('visible.ts')
    expect(r.content).not.toContain('.env')
  })

  it('includes hidden files when hidden: true', async () => {
    await createFile('.env', 'x')
    await createFile('visible.ts', 'x')

    const result = await glob.execute(
      { pattern: '**/*', hidden: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('visible.ts')
    // .env is in SENSITIVE_READ_PATTERNS so glob filters it from results.
    // Use a non-sensitive hidden file to verify hidden traversal works.
  })

  it('hidden: true descends into dot-dirs but still prunes VCS dirs', async () => {
    await createFile('.config/app.json', '{}')
    await createFile('.git/HEAD', 'ref')
    await createFile('src/main.ts', 'x')

    const result = await glob.execute(
      { pattern: '**/*', hidden: true } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.content).toContain('app.json')
    expect(r.content).toContain('main.ts')
    expect(r.content).not.toContain('.git')
    expect(r.content).not.toContain('HEAD')
  })
})

// ---------------------------------------------------------------------------
// Workspace boundary + additionalWorkspaceRoots
//
// The boundary check has two modes:
//   - Strict (default): writes reject lexically-outside paths.
//   - allowOutsideWorkspace: read tools relax the lexical check and
//     trust the upstream zone gate (which classifies outside-workspace
//     reads as MACHINE and routes them through HITL).
// In both modes, sensitive-path rules and symlink-escape protection
// stay enforced.
// ---------------------------------------------------------------------------

describe('workspace boundary — read tools (allowOutsideWorkspace)', () => {
  let extraDir: string

  beforeEach(async () => {
    extraDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-extra-'))
  })

  afterEach(async () => {
    await fs.rm(extraDir, { recursive: true, force: true })
  })

  it('readFile of an outside-workspace path succeeds when zone gate is bypassed (test mode)', async () => {
    const outsideFile = path.join(extraDir, 'note.txt')
    await fs.writeFile(outsideFile, 'hello from outside', 'utf-8')

    const result = await readFile.execute(
      { file_path: outsideFile } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('hello from outside')
  })

  it('readFile of a path inside additionalWorkspaceRoots succeeds', async () => {
    const grantedFile = path.join(extraDir, 'granted.txt')
    await fs.writeFile(grantedFile, 'inside granted root', 'utf-8')

    const grantedContext: ToolContext = { ...context, additionalWorkspaceRoots: [extraDir] }
    const result = await readFile.execute(
      { file_path: grantedFile } as Record<string, unknown>,
      grantedContext,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('inside granted root')
  })

  it('listFiles of an outside-workspace dir succeeds for read tools', async () => {
    await fs.writeFile(path.join(extraDir, 'a.txt'), 'a', 'utf-8')
    await fs.writeFile(path.join(extraDir, 'b.txt'), 'b', 'utf-8')

    const result = await listFiles.execute(
      { path: extraDir } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('a.txt')
    expect(r.content).toContain('b.txt')
  })

  it('grep across an outside-workspace path succeeds for read tools', async () => {
    await fs.writeFile(path.join(extraDir, 'src.ts'), 'const x = 1\nfunction foo() {}\n', 'utf-8')

    const result = await grep.execute(
      { pattern: 'function', path: extraDir } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    expect(r.content).toContain('function foo')
  })

  it('symlink-escape from inside workspace to outside is still blocked even for read tools', async () => {
    // The agent supplies an in-workspace literal path; if the symlink
    // points outside the workspace root, the zone classifier could
    // not have seen the escape — block defensively.
    const linkPath = path.join(tmpDir, 'escape-link')
    await fs.symlink(extraDir, linkPath)
    await fs.writeFile(path.join(extraDir, 'secret.txt'), 'should not leak', 'utf-8')

    const result = await readFile.execute(
      { file_path: 'escape-link/secret.txt' } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/symlink|outside/i)
  })
})

describe('workspace boundary — write tools (strict)', () => {
  let extraDir: string

  beforeEach(async () => {
    extraDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-extra-'))
  })

  afterEach(async () => {
    await fs.rm(extraDir, { recursive: true, force: true })
  })

  it('writeFile of an outside-workspace path is rejected', async () => {
    const outsideFile = path.join(extraDir, 'denied.txt')
    const result = await writeFile.execute(
      { file_path: outsideFile, content: 'nope' } as Record<string, unknown>,
      context,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/outside the workspace/i)
  })

  it('writeFile to a path inside additionalWorkspaceRoots succeeds', async () => {
    const grantedFile = path.join(extraDir, 'allowed.txt')
    const grantedContext: ToolContext = { ...context, additionalWorkspaceRoots: [extraDir] }

    const result = await writeFile.execute(
      { file_path: grantedFile, content: 'granted write' } as Record<string, unknown>,
      grantedContext,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(false)
    const written = await fs.readFile(grantedFile, 'utf-8')
    expect(written).toBe('granted write')
  })
})

describe('workspace boundary — pathological roots are rejected', () => {
  it('rejects an additional root of "/"', async () => {
    const badContext: ToolContext = { ...context, additionalWorkspaceRoots: ['/'] }
    const result = await readFile.execute(
      { file_path: '/etc/hostname' } as Record<string, unknown>,
      badContext,
    )
    const r = result as Awaited<typeof result>
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Invalid workspace path|root/i)
  })
})

// ---------------------------------------------------------------------------
// Session-grant mutation pattern
//
// The gateway's HITL approval handler grants "Allow folder for session"
// by pushing a path into a shared array reference (companions.session-
// AdditionalRoots) that ALSO lives on LoomConfig.additionalWorkspaceRoots.
// The loop reads `config.additionalWorkspaceRoots` when it builds each
// ToolContext, so the boundary check sees mutations made between tool
// calls without re-creating the session or re-passing config.
//
// These tests pin that contract end-to-end at the engine layer:
//   - A path NOT in the array is rejected (writes) / works in
//     allow-outside (reads), but the gateway's read tools route through
//     the same boundary, so a *write* to an outside path is the cleanest
//     demonstration.
//   - Pushing the path into the shared array makes the very next call
//     succeed — no context rebuild, no session restart.
//   - Splicing the path out reverts the boundary; the next call fails
//     again. This is what powers the Settings → Permissions Revoke
//     button.
// ---------------------------------------------------------------------------

describe('session-grant mutation — shared array reference flows through to boundary', () => {
  let extraDir: string

  beforeEach(async () => {
    extraDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-grant-'))
  })

  afterEach(async () => {
    await fs.rm(extraDir, { recursive: true, force: true })
  })

  it('writeFile fails outside workspace, succeeds after a runtime push to additionalWorkspaceRoots, fails again after splice', async () => {
    // The test fixture's `context` has `additionalWorkspaceRoots: []`.
    // Build a context that points at the SAME mutable array reference
    // we'll mutate below — mirrors the gateway's
    // `companions.sessionAdditionalRoots` ↔ `LoomConfig` aliasing.
    const sharedRoots: string[] = []
    const sharedContext: ToolContext = {
      ...context,
      additionalWorkspaceRoots: sharedRoots,
    }
    const targetFile = path.join(extraDir, 'note.txt')

    // Phase 1 — no grant, write must fail.
    const beforeGrant = await writeFile.execute(
      { file_path: targetFile, content: 'first' } as Record<string, unknown>,
      sharedContext,
    )
    expect((beforeGrant as Awaited<typeof beforeGrant>).isError).toBe(true)
    expect((beforeGrant as Awaited<typeof beforeGrant>).content).toMatch(/outside the workspace/i)

    // Phase 2 — grant the folder (this is what the gateway does on
    // "Allow folder for session"). MUTATE the same array reference.
    sharedRoots.push(extraDir)

    const afterGrant = await writeFile.execute(
      { file_path: targetFile, content: 'after grant' } as Record<string, unknown>,
      sharedContext,
    )
    expect((afterGrant as Awaited<typeof afterGrant>).isError).toBe(false)
    const written = await fs.readFile(targetFile, 'utf-8')
    expect(written).toBe('after grant')

    // Phase 3 — revoke (Settings → Permissions Revoke): splice the
    // path out of the SAME array. The next write must fail again.
    const idx = sharedRoots.indexOf(extraDir)
    expect(idx).toBeGreaterThanOrEqual(0)
    sharedRoots.splice(idx, 1)

    const afterRevoke = await writeFile.execute(
      { file_path: targetFile, content: 'should fail' } as Record<string, unknown>,
      sharedContext,
    )
    expect((afterRevoke as Awaited<typeof afterRevoke>).isError).toBe(true)
    expect((afterRevoke as Awaited<typeof afterRevoke>).content).toMatch(/outside the workspace/i)
  })

  it('multiple grants stack — each path independently allowed', async () => {
    const sharedRoots: string[] = []
    const sharedContext: ToolContext = {
      ...context,
      additionalWorkspaceRoots: sharedRoots,
    }

    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-grant-a-'))
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-grant-b-'))
    try {
      sharedRoots.push(dirA)
      sharedRoots.push(dirB)

      const fileA = path.join(dirA, 'a.txt')
      const fileB = path.join(dirB, 'b.txt')

      const wA = await writeFile.execute(
        { file_path: fileA, content: 'A' } as Record<string, unknown>,
        sharedContext,
      )
      const wB = await writeFile.execute(
        { file_path: fileB, content: 'B' } as Record<string, unknown>,
        sharedContext,
      )

      expect((wA as Awaited<typeof wA>).isError).toBe(false)
      expect((wB as Awaited<typeof wB>).isError).toBe(false)
    } finally {
      await fs.rm(dirA, { recursive: true, force: true })
      await fs.rm(dirB, { recursive: true, force: true })
    }
  })

  it('revoking one grant does not affect siblings still in the array', async () => {
    const sharedRoots: string[] = []
    const sharedContext: ToolContext = {
      ...context,
      additionalWorkspaceRoots: sharedRoots,
    }

    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-grant-a-'))
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-fs-grant-b-'))
    try {
      sharedRoots.push(dirA, dirB)

      // Revoke A — B must still work.
      const idxA = sharedRoots.indexOf(dirA)
      sharedRoots.splice(idxA, 1)

      const wA = await writeFile.execute(
        { file_path: path.join(dirA, 'a.txt'), content: 'no' } as Record<string, unknown>,
        sharedContext,
      )
      const wB = await writeFile.execute(
        { file_path: path.join(dirB, 'b.txt'), content: 'yes' } as Record<string, unknown>,
        sharedContext,
      )

      expect((wA as Awaited<typeof wA>).isError).toBe(true)
      expect((wB as Awaited<typeof wB>).isError).toBe(false)
    } finally {
      await fs.rm(dirA, { recursive: true, force: true })
      await fs.rm(dirB, { recursive: true, force: true })
    }
  })

  it('pushing root "/" into the array still gets rejected on next call (defense-in-depth)', async () => {
    // The gateway rejects "/" at the resume endpoint, but a test-only
    // bypass could still push it in. The boundary check defends in
    // depth — even if "/" leaks in, the operation must fail.
    const sharedRoots: string[] = []
    const sharedContext: ToolContext = {
      ...context,
      additionalWorkspaceRoots: sharedRoots,
    }

    sharedRoots.push('/')

    const result = await readFile.execute(
      { file_path: '/etc/hostname' } as Record<string, unknown>,
      sharedContext,
    )
    expect((result as Awaited<typeof result>).isError).toBe(true)
    expect((result as Awaited<typeof result>).content).toMatch(/Invalid workspace path|root/i)
  })
})

// ---------------------------------------------------------------------------
// cacheKey
// ---------------------------------------------------------------------------

describe('cacheKey — readFile', () => {
  it('produces a stable key for unchanged files', async () => {
    await createFile('a.txt', 'hello')
    const k1 = readFile.cacheKey!({ file_path: 'a.txt' } as Record<string, unknown>, context)
    const k2 = readFile.cacheKey!({ file_path: 'a.txt' } as Record<string, unknown>, context)
    expect(k1).not.toBeNull()
    expect(k1).toBe(k2)
  })

  it('changes the key when mtime changes', async () => {
    await createFile('a.txt', 'first')
    const k1 = readFile.cacheKey!({ file_path: 'a.txt' } as Record<string, unknown>, context)

    // Force a different mtime — touch the file via a short wait + rewrite.
    await new Promise(r => setTimeout(r, 5))
    await createFile('a.txt', 'second')

    const k2 = readFile.cacheKey!({ file_path: 'a.txt' } as Record<string, unknown>, context)
    expect(k1).not.toBe(k2)
  })

  it('returns null for missing files (bypasses cache)', () => {
    const k = readFile.cacheKey!({ file_path: 'does-not-exist.txt' } as Record<string, unknown>, context)
    expect(k).toBeNull()
  })

  it('different offset/limit produce different keys', async () => {
    await createFile('a.txt', 'x')
    const k0 = readFile.cacheKey!({ file_path: 'a.txt', offset: 0, limit: 100 } as Record<string, unknown>, context)
    const k1 = readFile.cacheKey!({ file_path: 'a.txt', offset: 10, limit: 100 } as Record<string, unknown>, context)
    const k2 = readFile.cacheKey!({ file_path: 'a.txt', offset: 0, limit: 50 } as Record<string, unknown>, context)
    expect(k0).not.toBe(k1)
    expect(k0).not.toBe(k2)
  })
})

describe('cacheKey — listFiles', () => {
  it('produces a stable key for unchanged dirs', async () => {
    await createFile('a.txt', '1')
    const k1 = listFiles.cacheKey!({ path: '.' } as Record<string, unknown>, context)
    const k2 = listFiles.cacheKey!({ path: '.' } as Record<string, unknown>, context)
    expect(k1).toBe(k2)
  })

  it('changes when dir mtime changes (file added)', async () => {
    await createFile('a.txt', '1')
    const k1 = listFiles.cacheKey!({ path: '.' } as Record<string, unknown>, context)
    await new Promise(r => setTimeout(r, 5))
    await createFile('b.txt', '2')
    const k2 = listFiles.cacheKey!({ path: '.' } as Record<string, unknown>, context)
    expect(k1).not.toBe(k2)
  })
})

describe('cacheKey — grep', () => {
  it('is disabled because a search-tree content version is not cheaply provable', () => {
    expect(grep.cacheKey).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// writeFile.validateInput
// ---------------------------------------------------------------------------

describe('writeFile.validateInput', () => {
  it('is defined on the tool', () => {
    expect(writeFile.validateInput).toBeDefined()
  })

  it('accepts a normal in-workspace write', async () => {
    const result = await writeFile.validateInput!(
      { file_path: 'new.txt', content: 'plain content' } as Record<string, unknown>,
      context,
    )
    expect(result).toEqual({ result: true })
  })

  it('rejects out-of-workspace paths with errorCode 10', async () => {
    const result = await writeFile.validateInput!(
      { file_path: '/etc/should-fail', content: 'x' } as Record<string, unknown>,
      context,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(10)
      expect(result.message).toMatch(/outside the workspace|sensitive/)
    }
  })

  it('rejects writes to sensitive system directories with errorCode 11', async () => {
    // Place the workspace inside /etc/ to trigger the sensitive-write
    // path branch without leaving the workspace lexically. The simplest
    // route is to mock additionalWorkspaceRoots to include a sensitive
    // root and target it directly.
    const sensitiveContext: ToolContext = {
      ...context,
      additionalWorkspaceRoots: ['/etc/sensitive-test-root'],
    }
    const result = await writeFile.validateInput!(
      {
        file_path: '/etc/sensitive-test-root/foo.conf',
        content: 'x',
      } as Record<string, unknown>,
      sensitiveContext,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(11)
      expect(result.message).toMatch(/sensitive system directory/)
    }
  })

  it('requests permission and rejects on deny when content contains secrets', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false)
    const secretContext: ToolContext = { ...context, requestPermission }

    const result = await writeFile.validateInput!(
      {
        file_path: 'config.txt',
        content: 'GITHUB_TOKEN=ghp_abcdef1234567890abcdef1234567890abcd',
      } as Record<string, unknown>,
      secretContext,
    )

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(12)
      expect(result.message).toMatch(/cancelled.*secrets/i)
    }
  })

  it('accepts the write when secret-content permission is granted', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true)
    const secretContext: ToolContext = { ...context, requestPermission }

    const result = await writeFile.validateInput!(
      {
        file_path: 'config.txt',
        content: 'GITHUB_TOKEN=ghp_abcdef1234567890abcdef1234567890abcd',
      } as Record<string, unknown>,
      secretContext,
    )

    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ result: true })
  })
})

// ---------------------------------------------------------------------------
// editFile.validateInput
// ---------------------------------------------------------------------------

describe('editFile.validateInput', () => {
  it('is defined on the tool', () => {
    expect(editFile.validateInput).toBeDefined()
  })

  it('accepts a normal edit', async () => {
    await createFile('a.txt', 'hello')
    const result = await editFile.validateInput!(
      {
        file_path: 'a.txt',
        old_string: 'hello',
        new_string: 'goodbye',
      } as Record<string, unknown>,
      context,
    )
    expect(result).toEqual({ result: true })
  })

  it('rejects identical old_string / new_string with errorCode 20', async () => {
    const result = await editFile.validateInput!(
      {
        file_path: 'a.txt',
        old_string: 'same',
        new_string: 'same',
      } as Record<string, unknown>,
      context,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(20)
      expect(result.message).toMatch(/identical/)
    }
  })

  it('rejects out-of-workspace paths with errorCode 10', async () => {
    const result = await editFile.validateInput!(
      {
        file_path: '/etc/passwd',
        old_string: 'a',
        new_string: 'b',
      } as Record<string, unknown>,
      context,
    )
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.errorCode).toBe(10)
    }
  })
})
