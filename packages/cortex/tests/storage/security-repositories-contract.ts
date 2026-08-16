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
        policyRevision: 'b'.repeat(64),
        agentId: null,
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

      const consumable = await repositories.runs.recordPermissionRequest({
        runId: run.runId,
        requestId: 'contract_permission_consumable',
        toolName: 'send_email',
        toolInput: { recipient: 'exact@example.test', subject: 'Bound once' },
        policyRevision: 'c'.repeat(64),
        agentId: 'helper-contract',
      }, 1_032)
      await expect(repositories.runs.decidePermission(
        run.runId,
        consumable.requestId,
        consumable.operationHash,
        'approve',
        1_033,
      )).resolves.toBe('decided')
      const exactIntent = {
        runId: run.runId,
        requestId: consumable.requestId,
        toolName: 'send_email',
        toolInput: { recipient: 'exact@example.test', subject: 'Bound once' },
        policyRevision: 'c'.repeat(64),
        agentId: 'helper-contract',
      } as const
      const consumptions = await Promise.all(Array.from(
        { length: 12 },
        (_, index) => repositories.runs.consumePermissionApproval(
          exactIntent,
          1_034 + index,
        ),
      ))
      expect(consumptions.filter((result) => result === 'consumed')).toHaveLength(1)
      expect(consumptions.filter((result) => result === 'already_consumed')).toHaveLength(11)
      await expect(repositories.runs.consumePermissionApproval({
        ...exactIntent,
        toolInput: { recipient: 'changed@example.test', subject: 'Bound once' },
      }, 1_047)).resolves.toBe('intent_mismatch')

      await repositories.runs.markRunningAfterDecision(run.runId, 1_048)
      await repositories.runs.markTerminal(run.runId, 'succeeded', {
        endSeq: 7,
        consequence: 'none_observed',
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

    it('keeps effect evidence append-only, idempotent and honest across recovery', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-effect-profile')
      const run = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-effect-profile',
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 2_000)
      await repositories.runs.markRunning(run.runId, 2_010)
      const intentInput = {
        runId: run.runId,
        toolCallId: 'contract_call_1',
        toolName: 'contract_effect_tool',
        observationKey: 'runtime:1',
        kind: 'intent_observed' as const,
        outcome: 'pending' as const,
        consequence: 'none_observed' as const,
        authorityKind: 'runtime' as const,
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }
      const intent = await repositories.effectReceipts.observe(intentInput, 2_020)
      expect(await repositories.effectReceipts.observe(intentInput, 9_999)).toEqual(intent)
      await expect(repositories.effectReceipts.observe({
        ...intentInput,
        kind: 'outcome_observed',
        outcome: 'succeeded',
        consequence: 'effect_possible',
      }, 2_030)).rejects.toMatchObject({ code: 'observation_conflict' })

      const confirmed = await repositories.effectReceipts.observe({
        runId: run.runId,
        toolCallId: 'contract_call_1',
        toolName: 'contract_effect_tool',
        observationKey: 'runtime:2',
        kind: 'authority_confirmed',
        outcome: 'succeeded',
        consequence: 'effect_confirmed',
        authorityKind: 'effect_observer',
        authorityRef: 'contract.authority.lookup',
        runtimeSequence: 2,
      }, 2_040)
      expect(confirmed.effectId).toBe(intent.effectId)
      expect(await repositories.runs.get(run.runId)).toMatchObject({
        consequence: 'effect_confirmed',
        updatedAt: 2_040,
      })
      const first = await repositories.effectReceipts.listForRun(
        run.runId,
        { limit: 1, cursor: null },
      )
      expect(first.items).toEqual([intent])
      expect(first.nextCursor).toBe(intent.receiptId)
      expect((await repositories.effectReceipts.listForRun(
        run.runId,
        { limit: 1, cursor: first.nextCursor },
      )).items).toEqual([confirmed])
      await repositories.runs.markTerminal(run.runId, 'succeeded', {
        endSeq: 2,
        consequence: 'effect_confirmed',
        now: 2_045,
      })

      const interrupted = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-effect-profile',
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 2,
      }, 2_050)
      await repositories.runs.markRunning(interrupted.runId, 2_060)
      await repositories.effectReceipts.observe({
        runId: interrupted.runId,
        toolCallId: 'contract_call_pending',
        toolName: 'contract_unknown_tool',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 2_070)
      await repositories.runs.recoverInterrupted(2_080)
      expect(await repositories.effectReceipts.reconcileInterrupted(
        'gateway.restart.pending_effect',
        2_090,
      )).toBe(1)
      expect(await repositories.effectReceipts.reconcileInterrupted(
        'gateway.restart.pending_effect',
        2_100,
      )).toBe(0)

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.effectReceipts.listForRun(
        interrupted.runId,
        { limit: 10, cursor: null },
      )).items.at(-1)).toMatchObject({
        kind: 'reconciliation',
        outcome: 'unknown',
        consequence: 'effect_possible',
        authorityKind: 'reconciler',
      })
      expect(await repositories.runs.get(interrupted.runId)).toMatchObject({
        status: 'indeterminate',
        consequence: 'effect_possible',
      })
    })

    it('keeps egress evidence append-only, mode-bound and honest across recovery', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-egress-profile')
      const run = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-egress-profile',
        model: 'contract:model',
        egressMode: 'unrestricted',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 3_000)
      await repositories.runs.markRunning(run.runId, 3_010)
      const dispatchId = '30000000-0000-4000-8000-000000000003'
      const startedInput = {
        dispatchId,
        runId: run.runId,
        mode: 'unrestricted' as const,
        sourceKind: 'provider' as const,
        sourceRef: 'contract_provider',
        transport: 'https' as const,
        mediation: 'platform_fetch' as const,
        observationKey: 'dispatch:started',
        destinationOrigin: 'https://models.example.test',
        phase: 'dispatch_started' as const,
        reasonCode: null,
      }
      const started = await repositories.egressReceipts.observe(startedInput, 3_020)
      expect(await repositories.egressReceipts.observe(startedInput, 9_999)).toEqual(started)
      await expect(repositories.egressReceipts.observe({
        ...startedInput,
        mode: 'local-only',
        observationKey: 'dispatch:mode-conflict',
      }, 3_021)).rejects.toMatchObject({ code: 'identity_conflict' })
      await expect(repositories.egressReceipts.observe({
        ...startedInput,
        observationKey: 'dispatch:started',
        phase: 'dispatch_failed',
      }, 3_022)).rejects.toMatchObject({ code: 'observation_conflict' })
      const observed = await repositories.egressReceipts.observe({
        ...startedInput,
        observationKey: 'dispatch:response',
        phase: 'response_observed',
      }, 3_030)
      const first = await repositories.egressReceipts.listForRun(
        run.runId,
        { limit: 1, cursor: null },
      )
      expect(first.items).toEqual([started])
      expect(first.nextCursor).toBe(started.receiptId)
      expect((await repositories.egressReceipts.listForRun(
        run.runId,
        { limit: 1, cursor: first.nextCursor },
      )).items).toEqual([observed])
      await repositories.runs.markTerminal(run.runId, 'succeeded', {
        endSeq: 1,
        consequence: 'output_observed',
        now: 3_040,
      })

      const interrupted = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-egress-profile',
        model: 'contract:model',
        egressMode: 'unrestricted',
        timeoutMs: 60_000,
        startSeq: 1,
      }, 3_050)
      await repositories.runs.markRunning(interrupted.runId, 3_060)
      await repositories.egressReceipts.observe({
        ...startedInput,
        dispatchId: '30000000-0000-4000-8000-000000000004',
        runId: interrupted.runId,
      }, 3_070)
      await repositories.runs.recoverInterrupted(3_080)
      expect(await repositories.egressReceipts.reconcileInterrupted(
        'gateway_restarted_after_dispatch',
        3_090,
      )).toBe(1)
      expect(await repositories.egressReceipts.reconcileInterrupted(
        'gateway_restarted_after_dispatch',
        3_100,
      )).toBe(0)

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.egressReceipts.listForRun(
        interrupted.runId,
        { limit: 10, cursor: null },
      )).items.at(-1)).toMatchObject({
        dispatchId: '30000000-0000-4000-8000-000000000004',
        phase: 'outcome_unknown',
        reasonCode: 'gateway_restarted_after_dispatch',
      })
    })

    it('keeps exact skill activations immutable, idempotent and gap-free after reopen', async () => {
      let repositories = harness.repositories
      const thread = await harness.core.threads.create('contract-skill-profile')
      const run = await repositories.runs.create({
        threadId: thread.id,
        profileId: 'contract-skill-profile',
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 4_000)
      const profileDigest = `hmac-sha256:${'a'.repeat(64)}`
      const firstInput = {
        activationId: '40000000-0000-4000-8000-000000000001',
        runId: run.runId,
        profileId: 'contract-skill-profile',
        profileDigest,
        skillName: 'unfamiliar.skill:α',
        skillDigest: `hmac-sha256:${'b'.repeat(64)}`,
        agentId: null,
        toolCallId: 'contract_skill_call_1',
        turnIndex: 2,
      }
      const first = await repositories.skillActivationReceipts.observe(firstInput, 4_010)
      expect(await repositories.skillActivationReceipts.observe(firstInput, 9_999))
        .toEqual(first)
      await expect(repositories.skillActivationReceipts.observe({
        ...firstInput,
        skillDigest: `hmac-sha256:${'c'.repeat(64)}`,
      }, 4_020)).rejects.toMatchObject({ code: 'identity_conflict' })

      const [second, third] = await Promise.all([
        repositories.skillActivationReceipts.observe({
          ...firstInput,
          activationId: '40000000-0000-4000-8000-000000000002',
          skillName: 'helper-grant-a',
          skillDigest: `hmac-sha256:${'d'.repeat(64)}`,
          agentId: 'helper-contract',
          toolCallId: null,
          turnIndex: 0,
        }, 4_030),
        repositories.skillActivationReceipts.observe({
          ...firstInput,
          activationId: '40000000-0000-4000-8000-000000000003',
          skillName: 'helper-grant-b',
          skillDigest: `hmac-sha256:${'e'.repeat(64)}`,
          agentId: 'helper-contract',
          toolCallId: null,
          turnIndex: 0,
        }, 4_031),
      ])
      expect(new Set([second.sequence, third.sequence])).toEqual(new Set([2, 3]))

      const page = await repositories.skillActivationReceipts.listForRun(
        run.runId,
        { limit: 2, cursor: null },
      )
      expect(page.items.map(receipt => receipt.sequence)).toEqual([1, 2])
      expect(page.nextCursor).toBe(page.items[1]!.receiptId)
      expect((await repositories.skillActivationReceipts.listForRun(
        run.runId,
        { limit: 2, cursor: page.nextCursor },
      )).items.map(receipt => receipt.sequence)).toEqual([3])
      expect(JSON.stringify([first, second, third])).not.toContain('PRIVATE_SKILL_BODY')

      await harness.reopen()
      repositories = harness.repositories
      expect((await repositories.skillActivationReceipts.listForRun(
        run.runId,
        { limit: 10, cursor: null },
      )).items.map(receipt => receipt.sequence)).toEqual([1, 2, 3])
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
