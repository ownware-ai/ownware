import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreStorageRepositories } from '../../src/storage/core-repositories.js'
import type {
  SecurityRepositories,
} from '../../src/storage/security-repositories.js'
import { AccessGrantStoreError } from '../../src/gateway/access-grant-store.js'
import {
  beginCodexThreadTurn,
  createCodexThreadReference,
} from '../../src/runtime/codex/official-thread.js'
import { CodexThreadReferenceStoreError } from '../../src/runtime/codex/thread-reference-store.js'

export interface SecurityRepositoryPeer {
  readonly repositories: SecurityRepositories
  close(): Promise<void>
}

export interface SecurityRepositoryHarness {
  readonly repositories: SecurityRepositories
  readonly core: CoreStorageRepositories
  createDelegatedThread(
    profileId: string,
    workspaceId: string | undefined,
    principalKey: string,
  ): Promise<{ readonly id: string }>
  openPeer(options: {
    readonly idempotencyLeaseOwner: string
    readonly oauthRefreshOwner: string
  }): Promise<SecurityRepositoryPeer>
  reopen(): Promise<void>
  close(): Promise<void>
}

export type SecurityRepositoryHarnessFactory = () => Promise<SecurityRepositoryHarness>

const PRIMARY_KEY = 'SECURITY_REPOSITORY_PRIMARY_PLAINTEXT'
const ROTATED_KEY = 'SECURITY_REPOSITORY_ROTATED_PLAINTEXT'
const COMPETING_KEY = 'SECURITY_REPOSITORY_COMPETING_PLAINTEXT'

/**
 * Backend-neutral contract for security state and run authority moved in STO-05.
 * Every future adapter runs this exact suite; backend-only SQL examples do not
 * establish parity.
 */
export function runSecurityRepositoryContract(
  name: string,
  createHarness: SecurityRepositoryHarnessFactory,
): void {
  describe(`security storage repository contract — ${name}`, () => {
    let harness: SecurityRepositoryHarness

    beforeEach(async () => {
      harness = await createHarness()
    })

    afterEach(async () => {
      await harness.close()
    })

    it('encrypts credentials, fences stale rotations and keeps audit/spend durable', async () => {
      let repositories = harness.repositories
      const credential = await repositories.credentials.save({
        name: 'contract provider',
        value: PRIMARY_KEY,
        category: 'llm',
        authType: 'api-key',
        variableName: 'CONTRACT_PROVIDER_KEY',
        source: 'manual',
        spendCap: { amountUsd: 5, period: 'day' },
      })
      expect(JSON.stringify(credential)).not.toContain(PRIMARY_KEY)
      expect((await repositories.credentials.get(credential.id))?.id).toBe(credential.id)

      const baseline = await repositories.credentials.decrypt(credential.id)
      expect(baseline?.value).toBe(PRIMARY_KEY)
      if (baseline === null) throw new Error('credential did not decrypt')

      const peer = await harness.openPeer({
        idempotencyLeaseOwner: 'contract-idempotency-peer-cas',
        oauthRefreshOwner: 'contract-oauth-peer-cas',
      })
      try {
        const [primaryResult, peerResult] = await Promise.all([
          repositories.credentials.updateIfUnchanged(
            credential.id,
            { valueRevision: baseline.valueRevision, status: baseline.metadata.status },
            { value: ROTATED_KEY },
          ),
          peer.repositories.credentials.updateIfUnchanged(
            credential.id,
            { valueRevision: baseline.valueRevision, status: baseline.metadata.status },
            { value: COMPETING_KEY },
          ),
        ])
        expect([primaryResult.kind, peerResult.kind].sort()).toEqual(['conflict', 'updated'])
        const durableWinner = primaryResult.kind === 'updated' ? ROTATED_KEY : COMPETING_KEY
        expect((await repositories.credentials.decrypt(credential.id))?.value).toBe(durableWinner)
      } finally {
        await peer.close()
      }

      await repositories.credentialAudit.recordEvent({
        credentialId: credential.id,
        eventType: 'resolve',
        outcome: 'ok',
        toolName: 'contract_tool',
        estimatedCostUsd: 0.25,
        actualCostUsd: 0.2,
      })
      await repositories.credentialAudit.recordEvent({
        credentialId: credential.id,
        eventType: 'resolve',
        outcome: 'ok',
        toolName: 'contract_tool',
        actualCostUsd: 0.3,
      })
      expect(await repositories.credentialSpend.check(
        credential.id,
        { amountUsd: 5, period: 'day' },
        4.6,
      )).toMatchObject({ status: 'denied', reason: 'SPEND_CAP_EXCEEDED' })
      expect(await repositories.credentialAudit.aggregateUsage(credential.id))
        .toMatchObject({ totalCalls: 2 })
      expect(await repositories.credentialAudit.aggregateCost(credential.id))
        .toMatchObject({ totalEstimatedUsd: 0.25, totalActualUsd: 0.5 })

      await harness.reopen()
      repositories = harness.repositories
      expect([ROTATED_KEY, COMPETING_KEY]).toContain(
        (await repositories.credentials.decrypt(credential.id))?.value,
      )
      expect((await repositories.credentialAudit.listEventsForCredential(credential.id)).total)
        .toBe(2)
    })

    it('commits delegated principal/thread authority together and preserves isolation', async () => {
      let repositories = harness.repositories
      const principal = {
        kind: 'delegated' as const,
        tokenId: '10000000-0000-4000-8000-000000000001',
        delegateId: 'contract-delegate',
        workspaceId: 'contract-workspace',
        profileId: 'contract-profile',
        subjectId: 'contract-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        operations: ['runs.snapshot'],
        issuedAt: 1_000,
        expiresAt: 2_000,
      }
      await repositories.principals.insert(principal)
      const thread = await harness.createDelegatedThread(
        principal.profileId,
        undefined,
        'contract-principal-key-a',
      )
      expect(await repositories.threadBindings.allows(
        thread.id,
        'contract-principal-key-a',
      )).toBe(true)
      expect(await repositories.threadBindings.allows(
        thread.id,
        'contract-principal-key-b',
      )).toBe(false)
      expect(await repositories.threadBindings.bind(
        thread.id,
        'contract-principal-key-b',
      )).toBe(false)
      expect(await repositories.principals.revoke(
        principal.tokenId,
        'owner_revoked',
        1_500,
      )).toBe(true)

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.principals.find(principal.tokenId))?.revokedAt).toBe(1_500)
      expect(await repositories.threadBindings.allows(
        thread.id,
        'contract-principal-key-a',
      )).toBe(true)
      expect(await repositories.threadBindings.allows(
        thread.id,
        'contract-principal-key-b',
      )).toBe(false)
    })

    it('has one exact permission winner and durable run state after reopen', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-run-profile')
      const run = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-run-profile',
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 1_000)
      await repositories.runs.markRunning(run.runId, 1_010)
      const permission = await repositories.runs.recordPermissionRequest({
        runId: run.runId,
        requestId: 'contract_permission',
        toolName: 'send_email',
        toolInput: { recipient: 'contract@example.test' },
      }, 1_020)
      await repositories.runs.markWaiting(run.runId, 1_020)

      const decisions = await Promise.all([
        repositories.runs.decidePermission(
          run.runId,
          permission.requestId,
          permission.operationHash,
          'approve',
          1_030,
        ),
        repositories.runs.decidePermission(
          run.runId,
          permission.requestId,
          permission.operationHash,
          'deny',
          1_031,
        ),
      ])
      expect(decisions.sort()).toEqual(['already_decided', 'decided'])
      expect((await repositories.runs.getPermissionRequest(
        run.runId,
        permission.requestId,
      ))?.status).toMatch(/^(approved|denied)$/)
      await repositories.runs.markRunningAfterDecision(run.runId, 1_040)
      await repositories.runs.markTerminal(run.runId, 'succeeded', {
        endSeq: 7,
        now: 1_050,
      })

      await harness.reopen()
      repositories = harness.repositories
      expect(await repositories.runs.get(run.runId)).toMatchObject({
        status: 'succeeded',
        terminal: true,
        outcomeKnown: true,
        endSeq: 7,
      })
    })

    it('fences foreign idempotency owners and replays only the completed input', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-idempotency-profile')
      const run = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-idempotency-profile',
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 0,
      })
      const input = {
        principalKey: 'delegated\0contract-client\0workspace\0profile\0purpose\0web',
        operation: 'runs.start',
        key: '20000000-0000-4000-8000-000000000002',
        input: { profileId: 'contract-idempotency-profile', prompt: 'bounded' },
      }
      const claim = await repositories.idempotency.claim(input, 1_000)
      expect(claim.kind).toBe('claimed')
      if (claim.kind !== 'claimed') throw new Error('idempotency claim was not acquired')

      const peer = await harness.openPeer({
        idempotencyLeaseOwner: 'contract-idempotency-peer-fence',
        oauthRefreshOwner: 'contract-oauth-peer-fence',
      })
      try {
        await expect(peer.repositories.idempotency.linkRun(claim.recordId, run.runId))
          .rejects.toMatchObject({
            name: 'StorageRepositoryError',
            domain: 'idempotency',
            operation: 'link_run',
          })
      } finally {
        await peer.close()
      }

      await repositories.idempotency.linkRun(claim.recordId, run.runId)
      await repositories.idempotency.complete({
        principalKey: input.principalKey,
        operation: input.operation,
        key: input.key,
        statusCode: 200,
        result: {
          runId: run.runId,
          threadId: thread.id,
          agentId: 'root',
          profileId: 'contract-idempotency-profile',
          candidateId: null,
          model: 'contract:model',
          status: 'running',
          timeoutMs: 60_000,
        },
      }, 1_100)
      expect(await repositories.idempotency.claim(input, 1_101))
        .toMatchObject({ kind: 'replay', statusCode: 200 })
      expect(await repositories.idempotency.claim({
        ...input,
        input: { profileId: 'other', prompt: 'changed' },
      }, 1_102)).toEqual({ kind: 'conflict' })

      await harness.reopen()
      repositories = harness.repositories
      expect(await repositories.idempotency.claim(input, 1_103))
        .toMatchObject({ kind: 'replay', statusCode: 200 })
    })

    it('fences OAuth refresh lease generations across independent owners', async () => {
      const repositories = harness.repositories
      const credential = await repositories.credentials.save({
        name: 'contract oauth',
        value: '{"accessToken":"old","refreshToken":"rotate"}',
        hint: '...oauth',
        category: 'oauth',
        authType: 'oauth2',
        source: 'oauth-flow',
      })
      const peer = await harness.openPeer({
        idempotencyLeaseOwner: 'contract-idempotency-peer-oauth',
        oauthRefreshOwner: 'contract-oauth-peer-generation',
      })
      try {
        const first = await repositories.oauthRefresh.tryAcquire(credential.id, 1_000, 100)
        expect(first.kind).toBe('acquired')
        if (first.kind !== 'acquired') throw new Error('OAuth lease was not acquired')
        await expect(peer.repositories.oauthRefresh.tryAcquire(credential.id, 1_050, 100))
          .resolves.toEqual({ kind: 'held', retryAt: 1_100 })
        const takeover = await peer.repositories.oauthRefresh.tryAcquire(
          credential.id,
          1_100,
          100,
        )
        expect(takeover.kind).toBe('acquired')
        if (takeover.kind !== 'acquired') throw new Error('OAuth lease was not taken over')
        expect(takeover.lease.generation).toBe(first.lease.generation + 1)
        expect(await repositories.oauthRefresh.renew(first.lease, 1_101, 100)).toBeNull()
        expect(await repositories.oauthRefresh.release(first.lease)).toBe(false)
        expect(await peer.repositories.oauthRefresh.release(takeover.lease)).toBe(true)
      } finally {
        await peer.close()
      }
    })

    it('keeps grant revisions append-only and rejects a stale revoke fence', async () => {
      const repositories = harness.repositories
      const grant = await repositories.accessGrants.create({
        workspaceId: 'contract-workspace',
        profileId: 'contract-profile',
        subjectId: 'contract-subject',
        purpose: 'customer_support',
        channel: 'web.primary',
        resourceKind: 'source_resource',
        resourceId: '30000000-0000-4000-8000-000000000003',
        operation: 'source_content.read',
        fieldScope: { mode: 'all' },
        rowScope: { mode: 'all' },
        consent: { state: 'recorded', evidenceId: 'contract-consent' },
        autonomyCeiling: 'draft',
        effectiveAt: 1_000,
        expiresAt: 5_000,
        issuedBy: 'contract-owner',
      }, 1_000)
      const revoked = await repositories.accessGrants.revoke({
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        profileId: grant.profileId,
        expectedRevision: grant.revision,
      }, 2_000)
      expect(revoked).toMatchObject({ revision: 2, state: 'revoked', revokedAt: 2_000 })
      await expect(repositories.accessGrants.revoke({
        grantId: grant.grantId,
        workspaceId: grant.workspaceId,
        profileId: grant.profileId,
        expectedRevision: grant.revision,
      }, 3_000)).rejects.toBeInstanceOf(AccessGrantStoreError)
      expect(await repositories.accessGrants.getCurrentForOwner(grant.grantId))
        .toMatchObject({ revision: 2, state: 'revoked' })
    })

    it('uses Codex revision CAS and preserves the winning recovery reference', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-codex-profile')
      const initial = createCodexThreadReference({
        localThreadId: thread.id,
        remoteThreadId: 'contract-remote-thread',
        accountBinding: `hmac-sha256:${'a'.repeat(64)}`,
        model: 'gpt-contract',
        modelProvider: 'openai',
        profileReportId: 'contract-profile-report',
        sandboxReportId: 'contract-sandbox-report',
        boundAt: '2026-08-02T00:00:00.000Z',
      })
      await repositories.codexThreadReferences.save(initial)
      const winner = beginCodexThreadTurn(initial, {
        id: 'contract-turn-winner',
        startedAt: '2026-08-02T00:01:00.000Z',
      })
      const stale = beginCodexThreadTurn(initial, {
        id: 'contract-turn-stale',
        startedAt: '2026-08-02T00:01:01.000Z',
      })
      await repositories.codexThreadReferences.save(winner)
      await expect(repositories.codexThreadReferences.save(stale))
        .rejects.toBeInstanceOf(CodexThreadReferenceStoreError)

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.codexThreadReferences.load(thread.id))?.activeTurn?.id)
        .toBe('contract-turn-winner')
    })
  })
}
