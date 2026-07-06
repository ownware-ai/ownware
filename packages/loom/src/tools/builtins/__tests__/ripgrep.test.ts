import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { isRipgrepAvailable, runRipgrep, ripgrepBinaryPath } from '../ripgrep.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loom-rg-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(tmpDir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
}

function baseOpts(pattern: string): Parameters<typeof runRipgrep>[0] {
  return {
    pattern,
    cwd: tmpDir,
    fixedStrings: true,
    multiline: false,
    caseSensitive: true,
    includeHidden: false,
    respectIgnore: true,
    maxBytes: 10 * 1024 * 1024,
    maxResults: 250,
    signal: new AbortController().signal,
  }
}

describe('ripgrep bundled binary', () => {
  it('is installed and executable', async () => {
    expect(await isRipgrepAvailable()).toBe(true)
    const p = ripgrepBinaryPath()
    expect(p).toContain('ripgrep')
    expect(p.endsWith('rg') || p.endsWith('rg.exe')).toBe(true)
  })

  it('finds literal matches with file and line number', async () => {
    await writeFile('src/app.ts', 'import foo\nconst bar = 1\nimport baz')
    const r = await runRipgrep(baseOpts('import'))
    expect(r.lines.length).toBeGreaterThanOrEqual(2)
    const files = r.lines.map(l => l.file)
    expect(files.every(f => f.endsWith('app.ts'))).toBe(true)
    const lineNos = r.lines.map(l => l.lineNo).sort()
    expect(lineNos).toEqual([1, 3])
  })

  it('respects .gitignore by default', async () => {
    await writeFile('.gitignore', 'ignored/\n')
    await writeFile('ignored/secret.ts', 'target value')
    await writeFile('src/open.ts', 'target value')

    const r = await runRipgrep(baseOpts('target'))
    const files = r.lines.map(l => l.file)
    expect(files.some(f => f.includes('open.ts'))).toBe(true)
    expect(files.some(f => f.includes('ignored'))).toBe(false)
  })

  it('searches ignored files when respectIgnore: false', async () => {
    await writeFile('.gitignore', 'ignored/\n')
    await writeFile('ignored/secret.ts', 'target value')

    const r = await runRipgrep({ ...baseOpts('target'), respectIgnore: false })
    const files = r.lines.map(l => l.file)
    expect(files.some(f => f.includes('ignored'))).toBe(true)
  })

  it('skips VCS dirs even with includeHidden + no_ignore', async () => {
    await writeFile('.git/config', 'target value')
    await writeFile('.hg/store', 'target value')
    await writeFile('src/main.ts', 'target value')

    const r = await runRipgrep({
      ...baseOpts('target'),
      includeHidden: true,
      respectIgnore: false,
    })
    const files = r.lines.map(l => l.file)
    expect(files.some(f => f.includes('main.ts'))).toBe(true)
    expect(files.some(f => f.startsWith('.git'))).toBe(false)
    expect(files.some(f => f.startsWith('.hg'))).toBe(false)
  })

  it('supports regex (non-fixed-strings) mode', async () => {
    await writeFile('a.ts', 'foo123\nbar\nbaz456')
    const r = await runRipgrep({
      ...baseOpts('^[a-z]+\\d+$'),
      fixedStrings: false,
    })
    const texts = r.lines.map(l => l.text)
    expect(texts).toContain('foo123')
    expect(texts).toContain('baz456')
    expect(texts.includes('bar')).toBe(false)
  })

  it('supports multiline matching', async () => {
    await writeFile(
      'iface.ts',
      'export interface Foo {\n  bar: string\n  baz: number\n}\n',
    )
    const r = await runRipgrep({
      ...baseOpts('interface\\s+\\w+\\s*\\{[\\s\\S]*?\\}'),
      fixedStrings: false,
      multiline: true,
    })
    expect(r.lines.length).toBeGreaterThan(0)
    const texts = r.lines.map(l => l.text).join('\n')
    expect(texts).toContain('interface Foo')
  })

  it('honors case_insensitive', async () => {
    await writeFile('f.txt', 'Hello\nhello\nHELLO')
    const r = await runRipgrep({ ...baseOpts('hello'), caseSensitive: false })
    expect(r.lines.length).toBe(3)
  })

  it('caps output at maxResults and reports truncation', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `match ${i}`)
    await writeFile('many.txt', lines.join('\n'))
    const r = await runRipgrep({ ...baseOpts('match'), maxResults: 10 })
    expect(r.lines.length).toBe(10)
    expect(r.truncatedByResults).toBe(true)
  })

  it('caps output at maxBytes and reports truncation', async () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `match ${i} ${'y'.repeat(100)}`)
    await writeFile('huge.txt', lines.join('\n'))
    const r = await runRipgrep({
      ...baseOpts('match'),
      maxResults: 100000,
      maxBytes: 4096,
    })
    expect(r.truncatedByBytes).toBe(true)
    expect(r.lines.length).toBeGreaterThan(0)
  })

  it('filters by glob', async () => {
    await writeFile('a.ts', 'target')
    await writeFile('b.js', 'target')
    const r = await runRipgrep({ ...baseOpts('target'), glob: '*.ts' })
    const files = r.lines.map(l => l.file)
    expect(files.some(f => f.endsWith('a.ts'))).toBe(true)
    expect(files.some(f => f.endsWith('b.js'))).toBe(false)
  })

  it('returns empty array on no matches (does not throw)', async () => {
    await writeFile('a.txt', 'hello')
    const r = await runRipgrep(baseOpts('nonexistent-pattern-xyz'))
    expect(r.lines).toEqual([])
  })

  it('honors AbortSignal', async () => {
    await writeFile('a.txt', 'hello')
    const ac = new AbortController()
    ac.abort()
    await expect(
      runRipgrep({ ...baseOpts('hello'), signal: ac.signal }),
    ).rejects.toThrow(/aborted/i)
  })

  it('rejects invalid regex with a clear error', async () => {
    await writeFile('a.txt', 'x')
    await expect(
      runRipgrep({ ...baseOpts('([unclosed'), fixedStrings: false }),
    ).rejects.toThrow(/exited/i)
  })
})
