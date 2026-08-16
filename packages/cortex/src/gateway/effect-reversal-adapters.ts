import type { Tool, ToolContext, ToolProgress, ToolResult } from '@ownware/loom'
import { consumeRememberProposalEffect } from '../memory/remember-tool.js'
import {
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
  MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
  type EffectReversalActorKind,
  type EffectReversalExecutionResult,
  type EffectReversalOffer,
  type EffectReversalRepository,
} from './effect-reversal-store.js'

interface MemoryProposalObservationDeps {
  readonly profileId: string
  readonly threadId: string
  readonly repository: EffectReversalRepository
  /** Active run identity from the gateway-owned runner, never model input. */
  readonly getActiveRunId: () => string | null
  readonly onObservationFailure?: (input: {
    readonly toolCallId: string
    readonly code: string
  }) => void
}

function isAsyncGenerator(
  value: Promise<ToolResult> | AsyncGenerator<ToolProgress, ToolResult>,
): value is AsyncGenerator<ToolProgress, ToolResult> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
    && typeof value.next === 'function'
}

async function observeMemoryProposalResult(
  tool: Tool,
  result: ToolResult,
  context: ToolContext,
  deps: MemoryProposalObservationDeps,
): Promise<void> {
  if (result.isError === true || context.agentId !== null || context.toolCallId === undefined) return
  const runId = deps.getActiveRunId()
  if (runId === null) return
  const mark = consumeRememberProposalEffect(result)
  if (mark === null) return
  try {
    await deps.repository.observeMemoryProposal({
      runId,
      toolCallId: context.toolCallId,
      toolName: tool.name,
      profileId: deps.profileId,
      threadId: deps.threadId,
      proposalId: mark.proposalId,
      targetRevision: mark.targetRevision,
      adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
      adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
    })
  } catch {
    // The proposal may already exist, so observer failure cannot be reported
    // as "nothing happened" and must not trigger an automatic tool retry.
    // No offer is published; the bounded sink receives identifiers only.
    deps.onObservationFailure?.({
      toolCallId: context.toolCallId,
      code: 'unavailable',
    })
  }
}

/**
 * Register one exact post-policy Tool object for memory-proposal reversal.
 * The wrapper preserves every declaration and observes only the raw final
 * result from that exact object. No name lookup or caller-declared undo flag
 * can enter this path.
 */
export function wrapMemoryProposalReversalTool(
  tool: Tool,
  deps: MemoryProposalObservationDeps,
): Tool {
  return Object.freeze({
    ...tool,
    execute(input: Record<string, unknown>, context: ToolContext) {
      const execution = tool.execute(input, context)
      if (!isAsyncGenerator(execution)) {
        return Promise.resolve(execution).then(async (result) => {
          await observeMemoryProposalResult(tool, result, context, deps)
          return result
        })
      }
      return (async function* (): AsyncGenerator<ToolProgress, ToolResult, unknown> {
        let sent: unknown = undefined
        while (true) {
          const step = await execution.next(sent as never)
          if (step.done) {
            await observeMemoryProposalResult(tool, step.value, context, deps)
            return step.value
          }
          sent = yield step.value
        }
      })()
    },
  })
}

export interface ExecuteRegisteredReversalInput {
  readonly runId: string
  readonly offerId: string
  readonly idempotencyKey: string
  readonly actorKind: EffectReversalActorKind
}

export interface RegisteredEffectReversalAdapter {
  readonly adapterRef: string
  readonly adapterRevision: string
  execute(input: ExecuteRegisteredReversalInput): Promise<EffectReversalExecutionResult>
}

function adapterKey(ref: string, revision: string): string {
  return `${ref}\u0000${revision}`
}

/**
 * Trusted host registry for restart-safe adapter execution. Stable adapter
 * identities are persisted; tool names are not registration keys. Unknown
 * identities fail closed and are never treated as a generic undo request.
 */
export class EffectReversalAdapterRegistry {
  private readonly adapters = new Map<string, RegisteredEffectReversalAdapter>()

  register(adapter: RegisteredEffectReversalAdapter): void {
    const key = adapterKey(adapter.adapterRef, adapter.adapterRevision)
    if (this.adapters.has(key)) throw new TypeError('Effect reversal adapter is already registered.')
    this.adapters.set(key, Object.freeze(adapter))
  }

  has(offer: Pick<EffectReversalOffer, 'adapterRef' | 'adapterRevision'>): boolean {
    return this.adapters.has(adapterKey(offer.adapterRef, offer.adapterRevision))
  }

  execute(
    offer: EffectReversalOffer,
    input: ExecuteRegisteredReversalInput,
  ): Promise<EffectReversalExecutionResult> {
    const adapter = this.adapters.get(adapterKey(offer.adapterRef, offer.adapterRevision))
    if (adapter === undefined) {
      return Promise.reject(new Error('Effect reversal adapter is unavailable.'))
    }
    return adapter.execute(input)
  }
}

export function createMemoryProposalReversalAdapter(
  repository: EffectReversalRepository,
): RegisteredEffectReversalAdapter {
  return {
    adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
    adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
    execute(input) {
      return repository.executeMemoryProposal({
        ...input,
        adapterRef: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REF,
        adapterRevision: MEMORY_PROPOSAL_REVERSAL_ADAPTER_REVISION,
      })
    },
  }
}
