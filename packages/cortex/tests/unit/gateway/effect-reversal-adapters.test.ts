import { describe, expect, it, vi } from 'vitest'
import { createDefaultConfig, defineTool, type ToolContext } from '@ownware/loom'
import { createRememberTool } from '../../../src/memory/index.js'
import {
  EffectReversalAdapterRegistry,
  createMemoryProposalReversalAdapter,
  wrapMemoryProposalReversalTool,
} from '../../../src/gateway/effect-reversal-adapters.js'
import type { EffectReversalRepository } from '../../../src/gateway/effect-reversal-store.js'

function repository(): EffectReversalRepository {
  return {
    observeMemoryProposal: vi.fn(async (input) => ({
      offerId: '00000000-0000-4000-8000-000000000001',
      sequence: 1,
      runId: input.runId,
      effectId: '00000000-0000-4000-8000-000000000002',
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      adapterRef: input.adapterRef,
      adapterRevision: input.adapterRevision,
      operationKind: 'inverse',
      status: 'available',
      createdAt: 1,
      expiresAt: null,
      resolvedAt: null,
    })),
    getOffer: vi.fn(async () => null),
    listOffersForRun: vi.fn(async () => ({ items: [], nextCursor: null })),
    executeMemoryProposal: vi.fn(async () => ({ disposition: 'missing' })),
    listReceiptsForRun: vi.fn(async () => ({ items: [], nextCursor: null })),
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'thread_1',
    rootSessionId: 'thread_1',
    agentId: null,
    toolCallId: 'call_1',
    turnIndex: 0,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: createDefaultConfig('test:model'),
    requestPermission: async () => false,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
    ...overrides,
  }
}

describe('exact reversible-tool adapter', () => {
  it('observes only a newly-created proposal from the registered exact tool result', async () => {
    const repo = repository()
    const remember = createRememberTool({
      hook: {
        propose: async () => ({
          proposalId: 'prop_1',
          created: true,
          targetRevision: '2026-08-16T00:00:00.000Z',
        }),
      },
    })
    const wrapped = wrapMemoryProposalReversalTool(remember, {
      profileId: 'profile-1',
      threadId: 'thread_1',
      repository: repo,
      getActiveRunId: () => '00000000-0000-4000-8000-000000000010',
    })
    const result = await wrapped.execute({ content: 'User prefers exact contracts.' }, context())
    if (Symbol.asyncIterator in result) throw new Error('unexpected generator')
    expect(await result).toMatchObject({ isError: false, metadata: { proposalId: 'prop_1' } })
    expect(repo.observeMemoryProposal).toHaveBeenCalledOnce()
    expect(repo.observeMemoryProposal).toHaveBeenCalledWith({
      runId: '00000000-0000-4000-8000-000000000010',
      toolCallId: 'call_1',
      toolName: 'remember',
      profileId: 'profile-1',
      threadId: 'thread_1',
      proposalId: 'prop_1',
      targetRevision: '2026-08-16T00:00:00.000Z',
      adapterRef: 'memory.pending-proposal',
      adapterRevision: '1',
    })
  })

  it('does not offer reversal for a deduplicated proposal or helper execution', async () => {
    const repo = repository()
    const deduped = createRememberTool({
      hook: { propose: async () => ({ proposalId: 'prop_old', created: false }) },
    })
    const wrapped = wrapMemoryProposalReversalTool(deduped, {
      profileId: 'profile-1',
      threadId: 'thread_1',
      repository: repo,
      getActiveRunId: () => '00000000-0000-4000-8000-000000000010',
    })
    const first = wrapped.execute({ content: 'Existing fact' }, context())
    if (Symbol.asyncIterator in first) throw new Error('unexpected generator')
    await first

    const created = createRememberTool({
      hook: {
        propose: async () => ({
          proposalId: 'prop_helper',
          created: true,
          targetRevision: '2026-08-16T00:00:00.000Z',
        }),
      },
    })
    const helperWrapped = wrapMemoryProposalReversalTool(created, {
      profileId: 'profile-1',
      threadId: 'thread_1',
      repository: repo,
      getActiveRunId: () => '00000000-0000-4000-8000-000000000010',
    })
    const second = helperWrapped.execute({ content: 'Helper fact' }, context({ agentId: 'helper_1' }))
    if (Symbol.asyncIterator in second) throw new Error('unexpected generator')
    await second
    expect(repo.observeMemoryProposal).not.toHaveBeenCalled()
  })

  it('does not grant authority to matching names, metadata, or absent run correlation', async () => {
    const repo = repository()
    const lookalike = defineTool({
      name: 'remember',
      description: 'lookalike',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return {
          content: 'Proposed for review',
          metadata: { proposalId: 'prop_forged', created: true },
        }
      },
    })
    await lookalike.execute({}, context())
    expect(repo.observeMemoryProposal).not.toHaveBeenCalled()

    const remember = createRememberTool({
      hook: {
        propose: async () => ({
          proposalId: 'prop_1',
          created: true,
          targetRevision: '2026-08-16T00:00:00.000Z',
        }),
      },
    })
    const wrapped = wrapMemoryProposalReversalTool(remember, {
      profileId: 'profile-1',
      threadId: 'thread_1',
      repository: repo,
      getActiveRunId: () => null,
    })
    const result = wrapped.execute({ content: 'No active run' }, context())
    if (Symbol.asyncIterator in result) throw new Error('unexpected generator')
    await result
    expect(repo.observeMemoryProposal).not.toHaveBeenCalled()
  })

  it('fails closed for unknown persisted adapter identities', async () => {
    const repo = repository()
    const registry = new EffectReversalAdapterRegistry()
    registry.register(createMemoryProposalReversalAdapter(repo))
    const offer = await repo.observeMemoryProposal({
      runId: '00000000-0000-4000-8000-000000000010',
      toolCallId: 'call_1',
      toolName: 'remember',
      profileId: 'profile-1',
      threadId: 'thread_1',
      proposalId: 'prop_1',
      targetRevision: 'revision-1',
      adapterRef: 'future.unregistered',
      adapterRevision: '9',
    })
    expect(registry.has(offer)).toBe(false)
    await expect(registry.execute(offer, {
      runId: offer.runId,
      offerId: offer.offerId,
      idempotencyKey: '00000000-0000-4000-8000-000000000020',
      actorKind: 'owner',
    })).rejects.toThrow(/unavailable/)
  })
})
