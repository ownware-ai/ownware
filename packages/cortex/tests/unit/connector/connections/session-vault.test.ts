import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../../src/connector/credentials/vault.js'
import {
  CONNECTION_SESSION_HANDLE_PATTERN,
  CONNECTION_SESSION_MAX_TTL_MS,
  ConnectionSessionVault,
  ConnectionSessionVaultError,
  type ConnectionSessionScope,
} from '../../../../src/connector/connections/session-vault.js'

const NOW = 1_800_000_000_000
const SCOPE: ConnectionSessionScope = {
  connectionId: 'connection.synthetic-1',
  connectorId: 'github',
  source: 'composio',
  entityId: 'person.synthetic-1',
}
const LINK_TOKEN = 'pcc05-link-token-secret-canary'
const AUTHORIZATION_URL =
  'https://auth.example/continue?pcc05-authorization-secret-canary=1'

let tempDir: string
let sessionDir: string
let previousDataDir: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ownware-connection-session-'))
  sessionDir = join(tempDir, 'connection-sessions')
  previousDataDir = process.env['OWNWARE_DATA_DIR']
  process.env['OWNWARE_DATA_DIR'] = tempDir
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousDataDir === undefined) delete process.env['OWNWARE_DATA_DIR']
  else process.env['OWNWARE_DATA_DIR'] = previousDataDir
  __resetMasterKeyCacheForTests()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('ConnectionSessionVault', () => {
  it('keeps material encrypted behind an opaque handle and releases it only to the exact scope', async () => {
    const vault = new ConnectionSessionVault({ directory: sessionDir, clock: () => NOW })
    const handle = await vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 60_000,
    })

    expect(handle).toMatch(CONNECTION_SESSION_HANDLE_PATTERN)
    await expect(vault.read(handle, SCOPE)).resolves.toEqual({
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 60_000,
    })

    for (const expectedScope of [
      { ...SCOPE, connectionId: 'connection.synthetic-other' },
      { ...SCOPE, connectorId: 'slack' },
      { ...SCOPE, source: 'other-provider' },
      { ...SCOPE, entityId: 'person.synthetic-other' },
    ]) {
      await expect(vault.read(handle, expectedScope)).resolves.toBeNull()
    }

    const files = readdirSync(sessionDir)
    expect(files).toEqual([`${handle}.json`])
    const raw = readFileSync(join(sessionDir, files[0]!), 'utf8')
    expect(raw).toMatch(/^v2:/)
    for (const canary of [
      LINK_TOKEN,
      AUTHORIZATION_URL,
      'pcc05-authorization-secret-canary',
      ...Object.values(SCOPE),
    ]) {
      expect(raw).not.toContain(canary)
    }
  })

  it('rejects an already-expired or overlong session and deletes one at its exact expiry', async () => {
    let now = NOW
    const vault = new ConnectionSessionVault({ directory: sessionDir, clock: () => now })
    await expect(vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW,
    })).rejects.toMatchObject({ code: 'invalid_session' })
    await expect(vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + CONNECTION_SESSION_MAX_TTL_MS + 1,
    })).rejects.toMatchObject({ code: 'invalid_session' })

    const handle = await vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 1_000,
    })
    now = NOW + 1_000

    await expect(vault.read(handle, SCOPE)).resolves.toBeNull()
    expect(existsSync(join(sessionDir, `${handle}.json`))).toBe(false)
  })

  it('deletes idempotently and refuses to claim cleanup when the encrypted file remains', async () => {
    const vault = new ConnectionSessionVault({ directory: sessionDir, clock: () => NOW })
    const handle = await vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 60_000,
    })

    await vault.remove(handle)
    await vault.remove(handle)
    expect(existsSync(join(sessionDir, `${handle}.json`))).toBe(false)

    const retained = await vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 60_000,
    })
    vi.spyOn(CredentialVault.prototype, 'delete').mockResolvedValue(undefined)

    await expect(vault.remove(retained)).rejects.toEqual(
      new ConnectionSessionVaultError('cleanup_unverified'),
    )
    expect(existsSync(join(sessionDir, `${retained}.json`))).toBe(true)
  })

  it('treats malformed handles and corrupted encrypted envelopes as unavailable', async () => {
    const vault = new ConnectionSessionVault({ directory: sessionDir, clock: () => NOW })
    await expect(vault.read('connection-session.not-a-handle', SCOPE)).resolves.toBeNull()

    const handle = await vault.create({
      ...SCOPE,
      authorizationUrl: AUTHORIZATION_URL,
      linkToken: LINK_TOKEN,
      expiresAt: NOW + 60_000,
    })
    const backend = new CredentialVault(sessionDir)
    await backend.save(handle, { BROKEN: 'envelope' })

    await expect(vault.read(handle, SCOPE)).resolves.toBeNull()
  })
})
