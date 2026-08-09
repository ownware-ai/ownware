import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreStorageRepositories } from '../../src/storage/core-repositories.js'
import type { ThreadMessage } from '../../src/gateway/types.js'
import type {
  PricebookEntry,
  UsageLedgerEntry,
} from '../../src/provider-hub/schema.js'

const USAGE_EVIDENCE_NOW = '2026-08-09T04:00:00.000Z'

function usageEvidencePrice(): PricebookEntry {
  return {
    id: 'price:contract:sonnet',
    version: 'catalog-v1',
    currency: 'USD',
    scope: {
      providerRouteId: 'anthropic:api',
      modelRouteId: 'anthropic:claude-sonnet',
    },
    rates: [
      { dimension: 'input_text_tokens', unitSize: 1_000_000, amountUsd: 3 },
      { dimension: 'output_text_tokens', unitSize: 1_000_000, amountUsd: 15 },
    ],
    effectiveFrom: null,
    effectiveUntil: null,
    source: {
      kind: 'models_dev',
      sourceRef: 'https://models.dev/api.json',
      retrievedAt: USAGE_EVIDENCE_NOW,
    },
  }
}

function usageEvidenceEntry(
  overrides: Partial<UsageLedgerEntry> = {},
): UsageLedgerEntry {
  const price = usageEvidencePrice()
  return {
    id: 'usage:contract:1',
    occurredAt: USAGE_EVIDENCE_NOW,
    profileId: 'ownware-code',
    providerFamilyId: 'anthropic',
    providerRouteId: 'anthropic:api',
    modelRouteId: 'anthropic:claude-sonnet',
    wireModelId: 'claude-sonnet',
    billingKind: 'metered',
    tokens: {
      inputTextTokens: 1_000,
      outputTextTokens: 200,
      cacheReadTokens: 2_000,
      reasoningTokens: 50,
    },
    units: { requests: 1 },
    cost: {
      classification: 'estimated',
      amountUsd: 0.006,
      currency: 'USD',
      pricebookEntryId: price.id,
      pricebookVersion: price.version,
      observedAt: USAGE_EVIDENCE_NOW,
    },
    providerFacts: { finishReason: 'end_turn' },
    durationMs: 800,
    success: true,
    ...overrides,
  }
}

export interface CoreRepositoryHarness {
  readonly repositories: CoreStorageRepositories
  reopen(): Promise<CoreStorageRepositories>
  close(): Promise<void>
}

export type CoreRepositoryHarnessFactory = () => Promise<CoreRepositoryHarness>

function message(
  id: string,
  timestamp: string,
  overrides: Partial<ThreadMessage> = {},
): ThreadMessage {
  return {
    id,
    role: 'assistant',
    content: `content-${id}`,
    timestamp,
    ...overrides,
  }
}

/**
 * Backend-neutral contract for the customer-visible storage moved in STO-04.
 * PostgreSQL must run this exact suite rather than prove compatibility with a
 * separate collection of examples.
 */
export function runCoreRepositoryContract(
  name: string,
  createHarness: CoreRepositoryHarnessFactory,
): void {
  describe(`core storage repository contract — ${name}`, () => {
    let harness: CoreRepositoryHarness
    let repositories: CoreStorageRepositories

    beforeEach(async () => {
      harness = await createHarness()
      repositories = harness.repositories
    })

    afterEach(async () => {
      await harness.close()
    })

    it('round-trips thread nulls, updates, filtering and deterministic pagination', async () => {
      const first = await repositories.threads.create('alpha')
      const second = await repositories.threads.create('alpha', 'Second')
      const third = await repositories.threads.create('beta', 'Third')
      await repositories.threads.setModel(first.id, 'openai:gpt-test')
      await repositories.threads.update(second.id, {
        title: null,
        status: 'completed',
        messageCount: 2,
        totalTokens: 12,
        totalCost: 0.25,
      })

      expect(await repositories.threads.get(first.id)).toMatchObject({
        profileId: 'alpha',
        workspaceId: null,
        title: null,
        model: 'openai:gpt-test',
      })
      expect(await repositories.threads.get(second.id)).toMatchObject({
        title: null,
        status: 'completed',
        messageCount: 2,
        totalTokens: 12,
        totalCost: 0.25,
      })

      const all = (await repositories.threads.list(undefined, { limit: 20 })).items
      const expected = [...all].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      )
      expect(all.map(thread => thread.id)).toEqual(expected.map(thread => thread.id))
      const pageOne = await repositories.threads.list(undefined, { limit: 2, offset: 0 })
      const pageTwo = await repositories.threads.list(undefined, { limit: 2, offset: 2 })
      expect([...pageOne.items, ...pageTwo.items].map(thread => thread.id))
        .toEqual(all.map(thread => thread.id))
      expect((await repositories.threads.list('alpha')).items.map(thread => thread.profileId))
        .toEqual(['alpha', 'alpha'])
      expect((await repositories.threads.list('missing')).items).toEqual([])
      expect(await repositories.threads.delete(third.id)).toBe(true)
      expect(await repositories.threads.delete(third.id)).toBe(false)
    })

    it('round-trips ordered message snapshots and patches only the newest matching sub-agent', async () => {
      const thread = await repositories.threads.create('messages')
      const timestamp = '2026-08-02T04:00:00.123Z'
      const subAgent = {
        agentId: 'agent-child',
        profileName: 'helper',
        status: 'running' as const,
      }
      await repositories.messages.add(thread.id, message('message-b', timestamp, {
        content: 'rich',
        subAgents: [subAgent],
        thinking: '',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        },
        model: 'anthropic:test',
        parts: [{ kind: 'text', text: 'rich' }],
      }))
      await repositories.messages.add(thread.id, message('message-a', timestamp, {
        subAgents: [subAgent],
      }))

      const before = await repositories.messages.list(thread.id)
      expect(before.map(entry => entry.id)).toEqual(['message-b', 'message-a'])
      expect(before[0]).toMatchObject({
        thinking: '',
        model: 'anthropic:test',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        },
      })
      expect(await repositories.messages.patchSubAgent(thread.id, 'agent-child', {
        status: 'completed',
        result: 'done',
        durationMs: 7,
        toolCount: 1,
        turnCount: 2,
      })).toBe(true)
      const after = await repositories.messages.list(thread.id)
      expect(after[0]!.subAgents?.[0]?.status).toBe('running')
      expect(after[1]!.subAgents?.[0]).toMatchObject({
        status: 'completed',
        result: 'done',
        durationMs: 7,
      })
      expect(await repositories.messages.patchSubAgent(thread.id, 'missing', {
        status: 'error',
      })).toBe(false)

      expect((await repositories.threads.get(thread.id))?.messageCount).toBe(2)
      await repositories.threads.delete(thread.id)
      expect(await repositories.messages.list(thread.id)).toEqual([])
    })

    it('aggregates usage, propagates thread totals, preserves nulls and orders dashboards', async () => {
      const thread = await repositories.threads.create('usage-a')
      await repositories.usage.add({
        threadId: thread.id,
        profileId: 'usage-a',
        model: 'provider:model-a',
        provider: 'provider',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.125,
        durationMs: 100,
        success: true,
      })
      await repositories.usage.add({
        profileId: 'usage-a',
        model: 'provider:model-b',
        provider: 'provider',
        inputTokens: 2,
        outputTokens: 3,
        costUsd: 0.25,
        success: false,
      })
      await repositories.usage.add({
        profileId: 'usage-b',
        model: 'provider:model-c',
        provider: 'provider',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      })

      expect(await repositories.usage.summary()).toEqual({
        totalTokens: 22,
        totalCost: 0.375,
        requestCount: 3,
      })
      expect(await repositories.usage.summary('usage-a')).toEqual({
        totalTokens: 20,
        totalCost: 0.375,
        requestCount: 2,
      })
      expect(await repositories.threads.get(thread.id)).toMatchObject({
        totalTokens: 15,
        totalCost: 0.125,
      })

      const breakdown = await repositories.usage.profileBreakdown()
      expect(breakdown.map(row => row.profileId)).toEqual(['usage-a', 'usage-b'])
      expect(breakdown[0]).toMatchObject({ runs: 2, tokens: 20, cost: 0.375 })
      expect(breakdown[1]!.avgDurationMs).toBeNull()
      const recent = await repositories.usage.recentActivity(10)
      const expectedRecent = [...recent].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      )
      expect(recent.map(row => row.id)).toEqual(expectedRecent.map(row => row.id))
      expect(recent.some(row => row.durationMs === null)).toBe(true)
      expect((await repositories.usage.timeSeries('7d'))).toHaveLength(7)
      expect((await repositories.usage.kpis('7d')).cards).toHaveLength(4)
      expect(await repositories.usage.dashboardStats()).toMatchObject({
        todayRuns: 3,
        todayTokens: 22,
        todayCost: 0.375,
      })
    })

    it('allocates per-stream event sequences, replays bounds and rolls back malformed payloads', async () => {
      const thread = await repositories.threads.create('events')
      const append = (agentId: string, type: string, payload: unknown, parentAgentId: string | null = null) =>
        repositories.events.append({
          threadId: thread.id,
          agentId,
          parentAgentId,
          type,
          payload,
        })

      const rootSeqs = await Promise.all([
        append('root', 'turn.start', { type: 'turn.start' }),
        append('root', 'text.delta', { type: 'text.delta', text: 'a' }),
        append('root', 'turn.end', { type: 'turn.end' }),
      ])
      expect([...rootSeqs].sort((a, b) => a - b)).toEqual([1, 2, 3])
      expect(await append('agent-child', 'text.delta', { type: 'text.delta' }, 'root')).toBe(1)
      expect(await repositories.events.maxSeq(thread.id, 'root')).toBe(3)
      expect(await repositories.events.maxSeq(thread.id, 'missing')).toBe(0)
      expect(await repositories.events.minSeq(thread.id, 'root', 1, 2)).toBe(2)
      expect(await repositories.events.lastTurnEndSeq(thread.id, 'root')).toBe(3)
      expect(await repositories.events.hasType(thread.id, 'root', 'turn.end')).toBe(true)
      expect(await repositories.events.hasType(thread.id, 'root', 'agent.complete')).toBe(false)
      expect((await repositories.events.list({
        threadId: thread.id,
        agentId: 'root',
        since: 1,
        limit: 1,
      })).map(row => row.seq)).toEqual([2])
      expect((await repositories.events.listAgents(thread.id)).map(row => row.agentId))
        .toEqual(['agent-child', 'root'])

      const circular: { self?: unknown } = {}
      circular.self = circular
      await expect(append('root', 'bad.payload', circular)).rejects.toThrow()
      expect(await repositories.events.maxSeq(thread.id, 'root')).toBe(3)
      expect(await append('root', 'text.delta', { type: 'text.delta', text: 'b' })).toBe(4)
      expect(await repositories.events.count()).toBe(5)
    })

    it('keeps provider-call facts immutable and chooses latest cost by adapter sequence', async () => {
      const thread = await repositories.threads.create('usage-evidence')
      const entry = usageEvidenceEntry({ threadId: thread.id })
      await expect(repositories.usageEvidence.record(entry, usageEvidencePrice()))
        .resolves.toEqual(entry)
      expect(await repositories.usageEvidence.get(entry.id)).toEqual(entry)

      // Deliberately older than the estimate: caller time must not outrank the
      // adapter-assigned append sequence.
      const reconciled = await repositories.usageEvidence.appendCostObservation(entry.id, {
        classification: 'reconciled',
        amountUsd: 0.0055,
        currency: 'USD',
        observedAt: '2026-08-08T04:00:00.000Z',
        reconciledAt: '2026-08-10T04:00:00.000Z',
      })
      expect(reconciled.cost).toMatchObject({
        classification: 'reconciled',
        amountUsd: 0.0055,
      })
      expect((await repositories.usageEvidence.list({ classification: 'reconciled' })))
        .toHaveLength(1)
      expect((await repositories.usageEvidence.list({ classification: 'estimated' })))
        .toHaveLength(0)
      expect((await repositories.usageEvidence.summary()).observations.reconciled)
        .toEqual({ requestCount: 1, amountUsd: 0.0055 })

      const exported = await repositories.usageEvidence.exportEvidence()
      expect(exported.entries[0]?.fact.id).toBe(entry.id)
      expect(exported.entries[0]?.costObservations.map(observation => ({
        sequence: observation.sequence,
        classification: observation.cost.classification,
      }))).toEqual([
        { sequence: 1, classification: 'estimated' },
        { sequence: 2, classification: 'reconciled' },
      ])
      expect(exported.pricebookSnapshots[0]?.entry).toEqual(usageEvidencePrice())

      // Product retention cannot rewrite historical provider evidence.
      await repositories.threads.delete(thread.id)
      expect((await repositories.usageEvidence.get(entry.id))?.threadId).toBe(thread.id)
      repositories = await harness.reopen()
      expect((await repositories.usageEvidence.get(entry.id))?.cost.classification)
        .toBe('reconciled')
    })

    it('rejects conflicting price evidence atomically and keeps failures content-free', async () => {
      const first = usageEvidenceEntry()
      await repositories.usageEvidence.record(first, usageEvidencePrice())
      const conflicting = {
        ...usageEvidencePrice(),
        rates: [{ dimension: 'input_text_tokens' as const, unitSize: 1, amountUsd: 99 }],
      }
      await expect(repositories.usageEvidence.record(
        usageEvidenceEntry({
          id: 'usage:contract:conflict',
          wireModelId: 'customer-secret-canary',
        }),
        conflicting,
      )).rejects.not.toThrow('customer-secret-canary')
      expect(await repositories.usageEvidence.get('usage:contract:conflict')).toBeNull()
      await expect(repositories.usageEvidence.appendCostObservation('missing', {
        classification: 'unknown',
        amountUsd: null,
        currency: 'USD',
        observedAt: USAGE_EVIDENCE_NOW,
      })).rejects.toMatchObject({ name: 'UsageEvidenceNotFoundError' })
    })

    it('serializes concurrent cost appends into one gap-free evidence order', async () => {
      const entry = usageEvidenceEntry({ id: 'usage:contract:concurrent' })
      await repositories.usageEvidence.record(entry, usageEvidencePrice())
      await Promise.all(Array.from({ length: 8 }, (_, index) => {
        const reconciledAt = new Date(Date.parse(USAGE_EVIDENCE_NOW) + index + 1).toISOString()
        return repositories.usageEvidence.appendCostObservation(entry.id, {
          classification: 'reconciled',
          amountUsd: 0.01 + index / 10_000,
          currency: 'USD',
          observedAt: reconciledAt,
          reconciledAt,
        })
      }))
      const exported = await repositories.usageEvidence.exportEvidence()
      const observations = exported.entries.find(row => row.fact.id === entry.id)?.costObservations
      expect(observations?.map(observation => observation.sequence))
        .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      expect(observations?.filter(observation => (
        observation.cost.classification === 'reconciled'
      ))).toHaveLength(8)
      expect((await repositories.usageEvidence.get(entry.id))?.cost.classification)
        .toBe('reconciled')
    })

    it('keeps the complete core value journey durable across reopen', async () => {
      const thread = await repositories.threads.create('restart')
      await repositories.messages.add(thread.id, message(
        'restart-message',
        '2026-08-02T04:00:00.123Z',
        { role: 'user', content: 'persist me' },
      ))
      await repositories.usage.add({
        threadId: thread.id,
        profileId: 'restart',
        model: 'provider:model',
        provider: 'provider',
        inputTokens: 4,
        outputTokens: 6,
        costUsd: 0.5,
      })
      await repositories.events.append({
        threadId: thread.id,
        agentId: 'root',
        parentAgentId: null,
        type: 'text.delta',
        payload: { type: 'text.delta', text: 'persist me' },
      })

      repositories = await harness.reopen()
      expect(await repositories.threads.get(thread.id)).toMatchObject({
        id: thread.id,
        profileId: 'restart',
        title: null,
        totalTokens: 10,
        totalCost: 0.5,
      })
      expect(await repositories.messages.list(thread.id)).toHaveLength(1)
      expect(await repositories.usage.summary('restart')).toEqual({
        totalTokens: 10,
        totalCost: 0.5,
        requestCount: 1,
      })
      expect(await repositories.events.maxSeq(thread.id, 'root')).toBe(1)
    })
  })
}
