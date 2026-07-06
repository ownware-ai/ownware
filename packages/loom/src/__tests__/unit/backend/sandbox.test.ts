/**
 * Unit Tests — SandboxBackend
 *
 * Tests path traversal prevention, sensitive file blocking,
 * and delegation to inner backend.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalBackend } from '../../../backend/local.js'
import { SandboxBackend } from '../../../backend/sandbox.js'
import { BackendError } from '../../../backend/types.js'

describe('SandboxBackend', () => {
  let tmp: string
  let sandbox: SandboxBackend

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-sandbox-'))
    const local = new LocalBackend(tmp)
    sandbox = new SandboxBackend(local, tmp)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // Path traversal prevention
  // -----------------------------------------------------------------------

  describe('path traversal prevention', () => {
    it('blocks ../ escape', async () => {
      await expect(
        sandbox.readFile('../../../etc/passwd'),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })

    it('blocks encoded traversal', async () => {
      await expect(
        sandbox.readFile('foo/../../etc/passwd'),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })

    it('allows paths within root', async () => {
      await writeFile(join(tmp, 'safe.txt'), 'safe content')
      const content = await sandbox.readFile('safe.txt')
      expect(content).toBe('safe content')
    })

    it('allows nested paths within root', async () => {
      await mkdir(join(tmp, 'sub'))
      await writeFile(join(tmp, 'sub/file.txt'), 'nested')
      const content = await sandbox.readFile('sub/file.txt')
      expect(content).toBe('nested')
    })
  })

  // -----------------------------------------------------------------------
  // Sensitive file blocking
  // -----------------------------------------------------------------------

  describe('sensitive file blocking', () => {
    it('blocks .env files', async () => {
      await expect(sandbox.readFile('.env')).rejects.toMatchObject({ code: 'SENSITIVE_FILE' })
    })

    it('blocks .env.production', async () => {
      await expect(sandbox.readFile('.env.production')).rejects.toMatchObject({ code: 'SENSITIVE_FILE' })
    })

    it('blocks credentials.json', async () => {
      await expect(sandbox.readFile('credentials.json')).rejects.toMatchObject({ code: 'SENSITIVE_FILE' })
    })

    it('blocks .pem files', async () => {
      await expect(sandbox.readFile('server.pem')).rejects.toMatchObject({ code: 'SENSITIVE_FILE' })
    })

    it('blocks id_rsa', async () => {
      await expect(sandbox.readFile('id_rsa')).rejects.toMatchObject({ code: 'SENSITIVE_FILE' })
    })

    it('allows normal files', async () => {
      await writeFile(join(tmp, 'config.json'), '{}')
      await expect(sandbox.readFile('config.json')).resolves.toBe('{}')
    })
  })

  // -----------------------------------------------------------------------
  // Write operations
  // -----------------------------------------------------------------------

  describe('write operations', () => {
    it('delegates writeFile within sandbox', async () => {
      await sandbox.writeFile('new.txt', 'content')
      const read = await sandbox.readFile('new.txt')
      expect(read).toBe('content')
    })

    it('blocks writeFile with traversal', async () => {
      await expect(
        sandbox.writeFile('../../escape.txt', 'bad'),
      ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' })
    })

    it('delegates editFile within sandbox', async () => {
      await writeFile(join(tmp, 'edit.txt'), 'hello world')
      await sandbox.editFile('edit.txt', 'world', 'sandbox')
      expect(await sandbox.readFile('edit.txt')).toBe('hello sandbox')
    })
  })

  // -----------------------------------------------------------------------
  // Other delegated operations
  // -----------------------------------------------------------------------

  describe('delegated operations', () => {
    it('exists() works within sandbox', async () => {
      await writeFile(join(tmp, 'here.txt'), '')
      expect(await sandbox.exists('here.txt')).toBe(true)
      expect(await sandbox.exists('nope.txt')).toBe(false)
    })

    it('listFiles() works within sandbox', async () => {
      await writeFile(join(tmp, 'a.txt'), '')
      const entries = await sandbox.listFiles('.')
      expect(entries.length).toBeGreaterThan(0)
    })
  })
})
