import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { GatewayState } from '../../../src/gateway/state.js'
import { StorageRepositoryError } from '../../../src/storage/contracts.js'

const DRIVER_SECRET = 'DRIVER_ERROR_SECRET_CANARY_8d599b'
const CREDENTIAL_SECRET = 'CREDENTIAL_PLAINTEXT_SECRET_CANARY_f18f1a'

describe('SQLite security repository boundary', () => {
  let directory: string
  let state: GatewayState | undefined
  let previousMasterKey: string | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cortex-security-boundary-'))
    previousMasterKey = process.env['OWNWARE_MASTER_KEY']
    process.env['OWNWARE_MASTER_KEY'] = 'cd'.repeat(32)
    __resetMasterKeyCacheForTests()
    state = new GatewayState(join(directory, 'ownware.db'), {
      permissionHashSecret: 'security-boundary-permission-secret',
    })
  })

  afterEach(async () => {
    await state?.closeStorage().catch(() => {})
    state = undefined
    if (previousMasterKey === undefined) delete process.env['OWNWARE_MASTER_KEY']
    else process.env['OWNWARE_MASTER_KEY'] = previousMasterKey
    __resetMasterKeyCacheForTests()
    rmSync(directory, { recursive: true, force: true })
  })

  it('discards driver error text, logs no canary and commits no plaintext row', async () => {
    const active = state!
    active.rawDbHandle.exec(`
      CREATE TRIGGER security_credential_failure
      BEFORE INSERT ON credentials
      BEGIN
        SELECT RAISE(ABORT, '${DRIVER_SECRET}');
      END;
    `)
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
    ]
    try {
      const failure = await active.securityRepositories.credentials.save({
        name: 'secret canary',
        value: CREDENTIAL_SECRET,
        category: 'llm',
        authType: 'api-key',
        variableName: 'SECRET_CANARY_KEY',
        source: 'manual',
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(StorageRepositoryError)
      expect(failure).toMatchObject({
        code: 'write_failed',
        kind: 'sqlite',
        domain: 'credentials',
        operation: 'save',
        retryable: false,
      })
      const rendered = JSON.stringify(failure, Object.getOwnPropertyNames(failure as object)) +
        String(failure)
      expect(rendered).not.toContain(DRIVER_SECRET)
      expect(rendered).not.toContain(CREDENTIAL_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' ')).not.toContain(DRIVER_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' ')).not.toContain(CREDENTIAL_SECRET)
      expect(active.rawDbHandle.prepare(
        'SELECT COUNT(*) AS count FROM credentials',
      ).get()).toEqual({ count: 0 })
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }

    active.rawDbHandle.exec('DROP TRIGGER security_credential_failure')
    const stored = await active.securityRepositories.credentials.save({
      name: 'encrypted canary',
      value: CREDENTIAL_SECRET,
      category: 'llm',
      authType: 'api-key',
      variableName: 'SECRET_CANARY_KEY',
      source: 'manual',
    })
    const durableRow = active.rawDbHandle.prepare(`
      SELECT id, name, variable_name, encrypted_value, hint, status
      FROM credentials WHERE id = ?
    `).get(stored.id)
    expect(JSON.stringify(durableRow)).not.toContain(CREDENTIAL_SECRET)
    expect(JSON.stringify(await active.securityRepositories.credentials.get(stored.id)))
      .not.toContain(CREDENTIAL_SECRET)
  })

  it('rolls back thread, workspace counter and binding when authority persistence fails', async () => {
    const active = state!
    const workspace = await active.createWorkspace(directory, 'security rollback workspace')
    const before = active.rawDbHandle.prepare(`
      SELECT thread_count FROM workspace_profiles
      WHERE workspace_id = ? AND profile_id = ?
    `).get(workspace.id, 'rollback-profile')
    expect(before).toBeUndefined()
    active.rawDbHandle.exec(`
      CREATE TRIGGER security_binding_failure
      BEFORE INSERT ON thread_principal_bindings
      BEGIN
        SELECT RAISE(ABORT, '${DRIVER_SECRET}');
      END;
    `)

    const failure = await active.createDelegatedThread(
      'rollback-profile',
      workspace.id,
      'rollback-principal-key',
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(StorageRepositoryError)
    expect(String(failure)).not.toContain(DRIVER_SECRET)
    expect((await active.listThreads('rollback-profile')).items).toEqual([])
    expect(active.rawDbHandle.prepare(`
      SELECT thread_count FROM workspace_profiles
      WHERE workspace_id = ? AND profile_id = ?
    `).get(workspace.id, 'rollback-profile')).toBeUndefined()
    expect(active.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM thread_principal_bindings
    `).get()).toEqual({ count: 0 })

    active.rawDbHandle.exec('DROP TRIGGER security_binding_failure')
    const thread = await active.createDelegatedThread(
      'rollback-profile',
      workspace.id,
      'rollback-principal-key',
    )
    expect(await active.securityRepositories.threadBindings.allows(
      thread.id,
      'rollback-principal-key',
    )).toBe(true)
  })

  it('expires retained security repositories when storage closes', async () => {
    const repositories = state!.securityRepositories
    await state!.closeStorage()
    await expect(async () => repositories.credentials.list()).rejects.toMatchObject({
      name: 'StorageLifecycleError',
      code: 'repository_unavailable',
      kind: 'sqlite',
      state: 'closed',
    })
  })
})
