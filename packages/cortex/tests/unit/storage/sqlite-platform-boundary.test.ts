import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayState } from '../../../src/gateway/state.js'
import { StorageRepositoryError } from '../../../src/storage/contracts.js'

const DRIVER_SECRET = 'PLATFORM_DRIVER_ERROR_SECRET_CANARY_5d67bd'
const CUSTOMER_SECRET = 'PLATFORM_CUSTOMER_SECRET_CANARY_f78d2a'

describe('SQLite platform repository boundary', () => {
  let directory: string
  let state: GatewayState | undefined

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cortex-platform-boundary-'))
    state = new GatewayState(join(directory, 'ownware.db'), {
      permissionHashSecret: 'platform-boundary-permission-secret',
    })
  })

  afterEach(async () => {
    await state?.closeStorage().catch(() => {})
    state = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  it('discards driver and customer text and commits no schedule on failure', async () => {
    const active = state!
    active.rawDbHandle.exec(`
      CREATE TRIGGER platform_schedule_failure
      BEFORE INSERT ON schedules
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
      const failure = await active.platformRepositories.schedules.create({
        profileId: 'platform-boundary',
        name: 'Failure boundary',
        prompt: CUSTOMER_SECRET,
        cadenceKind: 'daily',
        cadenceExpr: '{"time":"09:00"}',
        cadenceDisplay: 'Every day at 9:00 AM',
        timezone: 'UTC',
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(StorageRepositoryError)
      expect(failure).toMatchObject({
        code: 'write_failed',
        kind: 'sqlite',
        domain: 'schedules',
        operation: 'create',
        retryable: false,
      })
      const rendered = JSON.stringify(
        failure,
        Object.getOwnPropertyNames(failure as object),
      ) + String(failure)
      expect(rendered).not.toContain(DRIVER_SECRET)
      expect(rendered).not.toContain(CUSTOMER_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' '))
        .not.toContain(DRIVER_SECRET)
      expect(consoleSpies.flatMap(spy => spy.mock.calls).join(' '))
        .not.toContain(CUSTOMER_SECRET)
      expect(active.rawDbHandle.prepare(
        'SELECT COUNT(*) AS count FROM schedules',
      ).get()).toEqual({ count: 0 })
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }
  })

  it('expires every retained platform repository when storage closes', async () => {
    const repositories = state!.platformRepositories
    await state!.closeStorage()

    const operations = [
      () => repositories.connectorConnections.findPending(),
      () => repositories.channelJobs.listForProfile('profile'),
      () => repositories.schedules.list(),
      () => repositories.approvals.listPending(),
      () => repositories.tasks.listForThread('thread'),
      () => repositories.memories.listForProfile('profile'),
      () => repositories.memoryProposals.listForProfile('profile'),
      () => repositories.userIdentity.get(),
      () => repositories.candidates.list('profile'),
      () => repositories.teams.listTeams(),
    ]
    for (const operation of operations) {
      await expect(async () => operation()).rejects.toMatchObject({
        name: 'StorageLifecycleError',
        code: 'repository_unavailable',
        kind: 'sqlite',
        state: 'closed',
      })
    }
  })
})
