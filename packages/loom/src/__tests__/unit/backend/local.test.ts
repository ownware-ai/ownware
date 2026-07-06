/**
 * Unit Tests — LocalBackend
 *
 * Tests filesystem operations against a temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../../backend/local.js'
import { BackendError } from '../../../backend/types.js'

describe('LocalBackend', () => {
  let tmp: string
  let backend: LocalBackend

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-test-'))
    backend = new LocalBackend(tmp)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // readFile
  // -----------------------------------------------------------------------

  describe('readFile()', () => {
    it('reads file content', async () => {
      await writeFile(join(tmp, 'test.txt'), 'hello world')
      const content = await backend.readFile('test.txt')
      expect(content).toBe('hello world')
    })

    it('reads with offset and limit', async () => {
      await writeFile(join(tmp, 'lines.txt'), 'line1\nline2\nline3\nline4\nline5')
      const content = await backend.readFile('lines.txt', { offset: 1, limit: 2 })
      expect(content).toContain('2\tline2')
      expect(content).toContain('3\tline3')
      expect(content).not.toContain('line1')
      expect(content).not.toContain('line4')
    })

    it('throws NOT_FOUND for missing file', async () => {
      await expect(backend.readFile('nonexistent.txt')).rejects.toThrow(BackendError)
      await expect(backend.readFile('nonexistent.txt')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  // -----------------------------------------------------------------------
  // writeFile
  // -----------------------------------------------------------------------

  describe('writeFile()', () => {
    it('writes content to file', async () => {
      await backend.writeFile('output.txt', 'written content')
      const read = await backend.readFile('output.txt')
      expect(read).toBe('written content')
    })

    it('creates parent directories', async () => {
      await backend.writeFile('deep/nested/dir/file.txt', 'deep content')
      const read = await backend.readFile('deep/nested/dir/file.txt')
      expect(read).toBe('deep content')
    })

    it('overwrites existing file', async () => {
      await backend.writeFile('file.txt', 'original')
      await backend.writeFile('file.txt', 'updated')
      expect(await backend.readFile('file.txt')).toBe('updated')
    })
  })

  // -----------------------------------------------------------------------
  // editFile
  // -----------------------------------------------------------------------

  describe('editFile()', () => {
    it('replaces exact string', async () => {
      await writeFile(join(tmp, 'edit.txt'), 'hello world')
      await backend.editFile('edit.txt', 'world', 'universe')
      expect(await backend.readFile('edit.txt')).toBe('hello universe')
    })

    it('throws EDIT_MISMATCH when string not found', async () => {
      await writeFile(join(tmp, 'edit.txt'), 'hello world')
      await expect(
        backend.editFile('edit.txt', 'notfound', 'replacement'),
      ).rejects.toMatchObject({ code: 'EDIT_MISMATCH' })
    })

    it('throws NOT_FOUND for missing file', async () => {
      await expect(
        backend.editFile('missing.txt', 'a', 'b'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  // -----------------------------------------------------------------------
  // listFiles
  // -----------------------------------------------------------------------

  describe('listFiles()', () => {
    it('lists directory entries', async () => {
      await writeFile(join(tmp, 'a.txt'), 'a')
      await writeFile(join(tmp, 'b.txt'), 'b')
      await mkdir(join(tmp, 'subdir'))

      const entries = await backend.listFiles('.')
      const names = entries.map(e => e.name)
      expect(names).toContain('a.txt')
      expect(names).toContain('b.txt')
      expect(names).toContain('subdir')
    })

    it('includes metadata', async () => {
      await writeFile(join(tmp, 'meta.txt'), 'some content')
      const entries = await backend.listFiles('.')
      const file = entries.find(e => e.name === 'meta.txt')
      expect(file).toBeDefined()
      expect(file!.isDirectory).toBe(false)
      expect(file!.size).toBeGreaterThan(0)
      expect(file!.modifiedAt).toBeGreaterThan(0)
    })

    it('sorts entries alphabetically', async () => {
      await writeFile(join(tmp, 'c.txt'), '')
      await writeFile(join(tmp, 'a.txt'), '')
      await writeFile(join(tmp, 'b.txt'), '')
      const entries = await backend.listFiles('.')
      const names = entries.map(e => e.name)
      expect(names).toEqual([...names].sort())
    })

    it('throws NOT_FOUND for missing directory', async () => {
      await expect(backend.listFiles('nonexistent')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
  })

  // -----------------------------------------------------------------------
  // exists
  // -----------------------------------------------------------------------

  describe('exists()', () => {
    it('returns true for existing file', async () => {
      await writeFile(join(tmp, 'exists.txt'), '')
      expect(await backend.exists('exists.txt')).toBe(true)
    })

    it('returns false for missing file', async () => {
      expect(await backend.exists('missing.txt')).toBe(false)
    })

    it('returns true for existing directory', async () => {
      await mkdir(join(tmp, 'dir'))
      expect(await backend.exists('dir')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // grep
  // -----------------------------------------------------------------------

  describe('grep()', () => {
    it('finds matching lines', async () => {
      await writeFile(join(tmp, 'search.txt'), 'line one\nline two\nline three')
      const results = await backend.grep('two', tmp)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].content).toContain('two')
      expect(results[0].lineNumber).toBe(2)
    })

    it('is case-insensitive', async () => {
      await writeFile(join(tmp, 'case.txt'), 'Hello World')
      const results = await backend.grep('hello', tmp)
      expect(results).toHaveLength(1)
    })

    it('returns empty for no matches', async () => {
      await writeFile(join(tmp, 'empty.txt'), 'nothing here')
      const results = await backend.grep('zzzzz', tmp)
      expect(results).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // execute
  // -----------------------------------------------------------------------

  describe('execute()', () => {
    it('runs a command and returns output', async () => {
      const result = await backend.execute('echo hello')
      expect(result.stdout.trim()).toBe('hello')
      expect(result.exitCode).toBe(0)
    })

    it('captures stderr', async () => {
      const result = await backend.execute('echo error >&2')
      expect(result.stderr.trim()).toBe('error')
    })

    it('returns exit code', async () => {
      const result = await backend.execute('exit 42')
      expect(result.exitCode).toBe(42)
    })

    it('respects timeout', async () => {
      await expect(
        backend.execute('sleep 10', { timeout: 100 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
    })

    // Regression: a backgrounded child outlives the killed shell and keeps the
    // stdout/stderr pipe open, so 'close' won't fire until it exits (~10s). The
    // timeout must still reject promptly instead of hanging until then. (Old
    // code waited on 'close' and blew the test's own 5s wrapper under load.)
    it('times out promptly even when a child orphans the pipe', async () => {
      const start = Date.now()
      await expect(
        backend.execute('sleep 10 &', { timeout: 100 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
      // Rejected on the timer, not after the 10s orphan — well under 5s.
      expect(Date.now() - start).toBeLessThan(2_000)
    })
  })
})
