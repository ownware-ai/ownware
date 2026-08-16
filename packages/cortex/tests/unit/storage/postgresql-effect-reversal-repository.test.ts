import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryEventBus } from '../../../src/memory/event-bus.js'
import type { CoreStorageRepositories } from '../../../src/storage/core-repositories.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { createPostgreSqlCoreRepositories } from '../../../src/storage/postgresql-core-repositories.js'
import { createPostgreSqlMemoryProposalRepository } from '../../../src/storage/postgresql-memory-repositories.js'
import {
  createPostgreSqlSecurityRepositories,
  createPostgreSqlSecurityTransactionRepositories,
} from '../../../src/storage/postgresql-security-repositories.js'
import type { MemoryProposalRepository } from '../../../src/storage/platform-repositories.js'
import type {
  SecurityRepositories,
  SecurityTransactionRepositories,
} from '../../../src/storage/security-repositories.js'
import {
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
} from '../../../src/gateway/effect-reversal-store.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

interface Repositories {
  readonly core: CoreStorageRepositories
  readonly security: SecurityRepositories
  readonly proposals: MemoryProposalRepository
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

const factories: PostgreSqlRepositoryFactories<Repositories, SecurityTransactionRepositories> = {
  createRoot(context) {
    return {
      core: createPostgreSqlCoreRepositories(context),
      security: createPostgreSqlSecurityRepositories(context, {
        permissionHashSecret: 'effect-reversal-contract-secret',
      }),
      proposals: createPostgreSqlMemoryProposalRepository(context, new MemoryEventBus()),
    }
  },
  createTransaction: createPostgreSqlSecurityTransactionRepositories,
}

async function open(url: string) {
  const adapter = new PostgreSqlStorageAdapter({ plan: plan(url), repositories: factories })
  await adapter.initialize()
  return adapter
}

describePostgreSql('PostgreSQL exact effect reversal repository', () => {
  it('persists an exact offer, executes once after reopen, and never projects the target', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    let primary: Awaited<ReturnType<typeof open>> | undefined
    let reopened: Awaited<ReturnType<typeof open>> | undefined
    try {
      primary = await open(database.url)
      const { core, security, proposals } = primary.repositories
      const profileId = 'postgresql-reversal-profile'
      const privateContent = 'PRIVATE_POSTGRESQL_REVERSAL_TARGET'
      const thread = await core.threads.create(profileId)
      const run = await security.runs.create({
        threadId: thread.id,
        profileId,
        model: 'contract:model',
        timeoutMs: 60_000,
        startSeq: 0,
      }, 10_000)
      await security.runs.markRunning(run.runId, 10_010)
      const toolCallId = 'postgresql_reversal_call'
      await security.effectReceipts.observe({
        runId: run.runId,
        toolCallId,
        toolName: 'remember',
        observationKey: 'runtime:1',
        kind: 'intent_observed',
        outcome: 'pending',
        consequence: 'none_observed',
        authorityKind: 'runtime',
        authorityRef: 'runtime.tool_call.start',
        runtimeSequence: 1,
      }, 10_020)
      const disposition = await proposals.proposeWithDisposition({
        profileId,
        threadId: thread.id,
        content: privateContent,
        kind: 'preference',
      })
      expect(disposition.created).toBe(true)
      const offer = await security.effectReversals.observeMemoryProposal({
        runId: run.runId,
        toolCallId,
        toolName: 'remember',
        profileId,
        threadId: thread.id,
        proposalId: disposition.proposal.id,
        targetRevision: disposition.proposal.createdAt,
        adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
        adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
      }, 10_030)
      expect(offer).toMatchObject({
        sequence: 1,
        runId: run.runId,
        toolCallId,
        status: 'available',
        operationKind: 'inverse',
      })
      const publicProjection = JSON.stringify(offer)
      expect(publicProjection).not.toContain(privateContent)
      expect(publicProjection).not.toContain(disposition.proposal.id)
      expect(publicProjection).not.toContain(profileId)
      expect(publicProjection).not.toContain(thread.id)

      await primary.close()
      primary = undefined
      reopened = await open(database.url)
      const afterRestart = await reopened.repositories.security.effectReversals.getOffer(
        run.runId,
        offer.offerId,
      )
      expect(afterRestart).toEqual(offer)

      const key = randomUUID()
      const result = await reopened.repositories.security.effectReversals.executeMemoryProposal({
        runId: run.runId,
        offerId: offer.offerId,
        idempotencyKey: key,
        actorKind: 'owner',
        adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
        adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
      }, 10_040)
      expect(result).toMatchObject({
        disposition: 'executed',
        offer: { status: 'confirmed' },
        receipt: { sequence: 1, outcome: 'confirmed', actorKind: 'owner' },
      })
      expect(await reopened.repositories.proposals.getById(disposition.proposal.id))
        .toMatchObject({ status: 'rejected', proposedContent: privateContent })

      const replay = await reopened.repositories.security.effectReversals.executeMemoryProposal({
        runId: run.runId,
        offerId: offer.offerId,
        idempotencyKey: key,
        actorKind: 'owner',
        adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
        adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
      }, 99_999)
      expect(replay).toMatchObject({
        disposition: 'replayed',
        receipt: { receiptId: result.disposition === 'executed' ? result.receipt.receiptId : '' },
      })
      const receipts = await reopened.repositories.security.effectReversals.listReceiptsForRun(
        run.runId,
        { limit: 10, cursor: null },
      )
      expect(receipts.items).toHaveLength(1)
      expect(JSON.stringify(receipts)).not.toContain(privateContent)
      expect(JSON.stringify(receipts)).not.toContain(disposition.proposal.id)
    } finally {
      await primary?.close().catch(() => {})
      await reopened?.close().catch(() => {})
      await database.close().catch(() => {})
    }
  }, 20_000)
})
