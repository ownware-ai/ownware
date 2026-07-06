/**
 * CredentialVault unit tests.
 *
 * Covers: v2 round-trip, v1 read → v2 auto-migrate, plaintext-JSON →
 * v2 auto-migrate, wrong-key rejection, isolation by connectorId,
 * cross-compatibility with the pre-vault `MCPCredentialStore` file layout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CredentialVault,
  encryptV1,
  encryptV2,
  decrypt,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'
import { MCPCredentialStore } from '../../../src/connector/mcp/credentials.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-vault-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  delete process.env['OWNWARE_MASTER_KEY']
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('CredentialVault', () => {
  it('round-trips save → load', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('my-connector', { FOO: 'bar', BAZ: 'qux' })
    const loaded = await vault.load('my-connector')
    expect(loaded).not.toBeNull()
    expect(loaded!.connectorId).toBe('my-connector')
    expect(loaded!.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(typeof loaded!.updatedAt).toBe('string')
  })

  it('load returns null for missing file', async () => {
    const vault = new CredentialVault(join(tmpHome, 'empty'))
    expect(await vault.load('nope')).toBeNull()
  })

  it('writes encrypted v2 format on disk', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('srv', { K: 'v' })
    const raw = readFileSync(join(dir, 'srv.json'), 'utf-8')
    expect(raw.startsWith('v2:')).toBe(true)
    // 4 colon-delimited segments
    expect(raw.split(':').length).toBe(4)
  })

  it('isolates connectors by id', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('a', { X: '1' })
    await vault.save('b', { X: '2' })
    expect((await vault.load('a'))!.env['X']).toBe('1')
    expect((await vault.load('b'))!.env['X']).toBe('2')
  })

  it('delete removes the file', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('gone', { A: 'a' })
    await vault.delete('gone')
    expect(await vault.load('gone')).toBeNull()
  })

  it('list returns connector ids', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('one', {})
    await vault.save('two', {})
    const ids = (await vault.list()).sort()
    expect(ids).toEqual(['one', 'two'])
  })

  it('sanitizes unsafe chars in filename', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    // Slashes must not produce subdirectories.
    await vault.save('io.github.user/weather', { K: 'v' })
    expect(existsSync(join(dir, 'io.github.user_weather.json'))).toBe(true)
    const loaded = await vault.load('io.github.user/weather')
    expect(loaded!.env['K']).toBe('v')
  })

  it('checkEnvVars reports stored + process.env', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('x', { STORED: 'yes' })
    process.env['ENVVAR_CHECK_TEST'] = '1'
    const res = await vault.checkEnvVars('x', ['STORED', 'ENVVAR_CHECK_TEST', 'ABSENT'])
    expect(res).toEqual({ STORED: true, ENVVAR_CHECK_TEST: true, ABSENT: false })
    delete process.env['ENVVAR_CHECK_TEST']
  })

  it('resolveEnv prefers stored over process.env', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const vault = new CredentialVault(dir)
    await vault.save('x', { TOK: 'stored' })
    process.env['TOK'] = 'env'
    const res = await vault.resolveEnv('x', ['TOK'])
    expect(res['TOK']).toBe('stored')
    delete process.env['TOK']
  })
})

describe('CredentialVault — encryption primitives', () => {
  it('encryptV2 produces decryptable ciphertext', () => {
    const out = encryptV2('hello')
    expect(out.startsWith('v2:')).toBe(true)
    expect(decrypt(out)).toBe('hello')
  })

  it('decrypt returns null on garbage', () => {
    expect(decrypt('garbage')).toBeNull()
    expect(decrypt('')).toBeNull()
    expect(decrypt('too:many:colons:here:wrong')).toBeNull()
  })

  it('encryptV1 produces v1-format blob that decrypts', () => {
    const out = encryptV1('secret')
    expect(out.split(':').length).toBe(3)
    expect(decrypt(out)).toBe('secret')
  })
})

describe('CredentialVault — backwards-compat reads', () => {
  it('reads a v2 file written by the pre-vault MCPCredentialStore layout', async () => {
    // Write directly using the same encryption scheme and the same on-disk
    // JSON field names the old code used. This simulates an existing user
    // upgrading to the new vault.
    const dir = join(tmpHome, '.ownware', 'credentials')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const payload = {
      serverId: 'io.github.user/weather',
      env: { WEATHER_API_KEY: 'sekret' },
      updatedAt: new Date().toISOString(),
    }
    const blob = encryptV2(JSON.stringify(payload))
    writeFileSync(join(dir, 'io.github.user_weather.json'), blob, { mode: 0o600 })

    const vault = new CredentialVault(dir)
    const loaded = await vault.load('io.github.user/weather')
    expect(loaded).not.toBeNull()
    expect(loaded!.connectorId).toBe('io.github.user/weather')
    expect(loaded!.env['WEATHER_API_KEY']).toBe('sekret')
  })

  it('migrates v1 blob to v2 on read', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const payload = {
      serverId: 'legacy',
      env: { LEGACY: 'yes' },
      updatedAt: new Date().toISOString(),
    }
    const v1 = encryptV1(JSON.stringify(payload))
    const filePath = join(dir, 'legacy.json')
    writeFileSync(filePath, v1, { mode: 0o600 })

    const vault = new CredentialVault(dir)
    const loaded = await vault.load('legacy')
    expect(loaded!.env['LEGACY']).toBe('yes')
    // Auto-migrate: next read of the file should now be v2.
    const raw = readFileSync(filePath, 'utf-8')
    expect(raw.startsWith('v2:')).toBe(true)
  })

  it('migrates plaintext JSON to v2 on read', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'plain.json')
    writeFileSync(filePath, JSON.stringify({
      serverId: 'plain',
      env: { P: 'v' },
      updatedAt: new Date().toISOString(),
    }))

    const vault = new CredentialVault(dir)
    const loaded = await vault.load('plain')
    expect(loaded!.env['P']).toBe('v')
    const raw = readFileSync(filePath, 'utf-8')
    expect(raw.startsWith('v2:')).toBe(true)
  })
})

describe('MCPCredentialStore — delegates to vault unchanged', () => {
  it('round-trips via the legacy facade using the same on-disk layout', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const store = new MCPCredentialStore(dir)
    await store.save('io.github.x/y', { TOKEN: 'xyz' })

    // Read back through both surfaces — must agree.
    const viaStore = await store.load('io.github.x/y')
    expect(viaStore).not.toBeNull()
    expect(viaStore!.serverId).toBe('io.github.x/y')
    expect(viaStore!.env['TOKEN']).toBe('xyz')

    const viaVault = await new CredentialVault(dir).load('io.github.x/y')
    expect(viaVault!.connectorId).toBe('io.github.x/y')
    expect(viaVault!.env['TOKEN']).toBe('xyz')
  })

  it('list + delete still work through facade', async () => {
    const dir = join(tmpHome, '.ownware', 'credentials')
    const store = new MCPCredentialStore(dir)
    await store.save('a', { K: '1' })
    await store.save('b', { K: '2' })
    expect((await store.list()).sort()).toEqual(['a', 'b'])
    await store.delete('a')
    expect(await store.load('a')).toBeNull()
  })
})

describe('master key source', () => {
  it('prefers OWNWARE_MASTER_KEY env over the on-disk key file', () => {
    // Pre-seed a DIFFERENT on-disk key so we can prove which one was used.
    mkdirSync(join(tmpHome, '.ownware'), { recursive: true })
    writeFileSync(join(tmpHome, '.ownware', '.master-key'), randomBytes(32))

    process.env['OWNWARE_MASTER_KEY'] = randomBytes(32).toString('hex')
    __resetMasterKeyCacheForTests()
    const cipher = encryptV2('secret') // encrypted under the env key

    // With the env key present, decrypt round-trips.
    expect(decrypt(cipher)).toBe('secret')

    // Drop the env key → vault falls back to the (different) on-disk key →
    // the ciphertext no longer decrypts. Proves the env key was the one used.
    delete process.env['OWNWARE_MASTER_KEY']
    __resetMasterKeyCacheForTests()
    expect(decrypt(cipher)).toBeNull()
  })

  it('ignores a malformed OWNWARE_MASTER_KEY and uses the file key', () => {
    process.env['OWNWARE_MASTER_KEY'] = 'not-valid-hex'
    __resetMasterKeyCacheForTests()
    const cipher = encryptV2('hello') // falls back to a generated file key

    // Same malformed env on the next read → still falls back to the same
    // persisted file key, so the round-trip succeeds.
    __resetMasterKeyCacheForTests()
    expect(decrypt(cipher)).toBe('hello')
  })
})
