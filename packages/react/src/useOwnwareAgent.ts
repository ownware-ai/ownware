/**
 * Production transport lifecycle for a reusable Ownware React host.
 *
 * Authority stays separated: events build transcript state, capability
 * discovery gates actions, evidence endpoints build evidence projections,
 * and sensitive values travel only from the caller to the dedicated client
 * method. They never enter reducer actions or durable React state here.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  OwnwareClient,
  SENSITIVE_INPUT_INTERACTION_CAPABILITY,
  type CapabilityNegotiationResult,
  type CapabilityRequirements,
  type EffectReceipt,
  type EffectReceiptListOptions,
  type EffectReceiptPage,
  type EffectReversalExecutionResult,
  type EffectReversalListOptions,
  type EffectReversalOffer,
  type EffectReversalOfferPage,
  type EffectReversalReceipt,
  type EffectReversalReceiptPage,
  type EgressMode,
  type EgressReceipt,
  type EgressReceiptListOptions,
  type EgressReceiptPage,
  type GatewayEvent,
  type PermissionDecisionInput,
  type PermissionDecisionResult,
  type ProviderHubModelPage,
  type ProviderHubModelQuery,
  type ProviderHubModelRoute,
  type RunAttachmentInput,
  type RunCancellationResult,
  type RunInput,
  type RunResult,
  type RunSnapshot,
  type SensitiveInputDecisionResult,
  type SkillActivationReceipt,
  type SkillActivationReceiptListOptions,
  type SkillActivationReceiptPage,
  type ThreadHydration,
} from '@ownware/client'
import {
  EVIDENCE_CAPABILITIES,
  addUserMessage,
  chatReducer,
  failedProjection,
  hydrateChatState,
  initialChatState,
  loadingProjection,
  partialProjection,
  readyProjection,
  selectCapabilitySupport,
  selectEgress,
  selectRunConsequence,
  selectSkillPlacement,
  unavailableProjection,
  type AgentEvent,
  type CapabilitySupport,
  type ChatState,
  type EgressProjection,
  type Message,
  type PendingApproval,
  type PendingSensitiveInput,
  type ProjectionCapability,
  type ProjectionResource,
  type RunConsequenceProjection,
  type SkillPlacementProjection,
} from '@ownware/ui'

/**
 * The transport boundary. Optional methods represent an older/custom client;
 * the hook reports those capabilities unavailable and never falls back from
 * an exact public mutation to a broad legacy thread mutation.
 */
export interface AgentTransport {
  run(input: RunInput): Promise<RunResult>
  events(runIdOrThreadId: string, opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<GatewayEvent>
  providerHubModels(query?: ProviderHubModelQuery): Promise<ProviderHubModelPage>
  hydrateThread?(threadId: string): Promise<ThreadHydration>
  capabilities?(requirements?: CapabilityRequirements): Promise<CapabilityNegotiationResult>
  decidePermission?(
    runId: string,
    requestId: string,
    input: PermissionDecisionInput,
  ): Promise<PermissionDecisionResult>
  submitSensitiveInput?(
    runId: string,
    requestId: string,
    value: string,
  ): Promise<SensitiveInputDecisionResult>
  denySensitiveInput?(runId: string, requestId: string): Promise<SensitiveInputDecisionResult>
  cancel?(runId: string): Promise<RunCancellationResult>
  runSnapshot?(runId: string): Promise<RunSnapshot>
  listEffectReceipts?(runId: string, options?: EffectReceiptListOptions): Promise<EffectReceiptPage>
  listEgressReceipts?(runId: string, options?: EgressReceiptListOptions): Promise<EgressReceiptPage>
  listSkillActivationReceipts?(
    runId: string,
    options?: SkillActivationReceiptListOptions,
  ): Promise<SkillActivationReceiptPage>
  listEffectReversalOffers?(
    runId: string,
    options?: EffectReversalListOptions,
  ): Promise<EffectReversalOfferPage>
  listEffectReversalReceipts?(
    runId: string,
    options?: EffectReversalListOptions,
  ): Promise<EffectReversalReceiptPage>
  executeEffectReversal?(
    runId: string,
    offerId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<EffectReversalExecutionResult>
}

export interface UseOwnwareAgentOptions {
  readonly profileId: string
  readonly baseUrl?: string
  readonly token?: string
  readonly model?: string
  readonly threadId?: string
  readonly workspaceId?: string
  readonly egressMode?: EgressMode
  /**
   * Advertise sensitive-input only when the host keeps the value in a local
   * controlled field and calls submitSensitiveInput directly.
   */
  readonly sensitiveInputMode?: 'component-local'
  readonly client?: AgentTransport
}

export interface SendOptions {
  readonly attachments?: readonly RunAttachmentInput[]
  readonly idempotencyKey?: string
}

export interface OwnwareAgentEvidence {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly snapshot: ProjectionResource<RunSnapshot>
  readonly effects: ProjectionResource<readonly EffectReceipt[]>
  readonly egressReceipts: ProjectionResource<readonly EgressReceipt[]>
  readonly skillReceipts: ProjectionResource<readonly SkillActivationReceipt[]>
  readonly reversalOffers: ProjectionResource<readonly EffectReversalOffer[]>
  readonly reversalReceipts: ProjectionResource<readonly EffectReversalReceipt[]>
  readonly consequence: RunConsequenceProjection
  readonly egress: EgressProjection
  readonly skillPlacement: SkillPlacementProjection
}

export interface OwnwareAgentSupport {
  readonly permissionDecision: CapabilitySupport
  readonly sensitiveInputSubmit: CapabilitySupport
  readonly sensitiveInputDeny: CapabilitySupport
  readonly cancellation: CapabilitySupport
  readonly hydration: CapabilitySupport
}

export interface OwnwareAgent {
  readonly messages: readonly Message[]
  readonly status: ChatState['status']
  readonly streaming: boolean
  readonly hydrating: boolean
  readonly sending: boolean
  readonly connection: ChatState['connection']
  readonly pendingApproval: PendingApproval | null
  readonly pendingApprovals: readonly PendingApproval[]
  readonly pendingSensitiveInput: PendingSensitiveInput | null
  readonly pendingSensitiveInputs: readonly PendingSensitiveInput[]
  readonly model?: string
  readonly error?: string
  readonly models: readonly ProviderHubModelRoute[]
  readonly modelsStatus: 'loading' | 'ready' | 'error'
  readonly threadId?: string
  readonly activeRunId?: string
  readonly evidence: OwnwareAgentEvidence
  readonly support: OwnwareAgentSupport
  readonly busyActions: ReadonlySet<string>
  readonly actionErrors: Readonly<Record<string, string>>
  readonly send: (prompt: string, options?: SendOptions) => Promise<void>
  readonly decidePermission: (requestId: string, decision: 'approve' | 'deny') => Promise<void>
  readonly approve: () => Promise<void>
  readonly deny: () => Promise<void>
  readonly submitSensitiveInput: (requestId: string, value: string) => Promise<void>
  readonly denySensitiveInput: (requestId: string) => Promise<void>
  readonly executeReversal: (offerId: string, idempotencyKey: string) => Promise<void>
  readonly abort: () => Promise<void>
  readonly refreshEvidence: () => Promise<void>
  readonly rehydrate: () => Promise<void>
}

type Action =
  | { readonly k: 'ev'; readonly e: AgentEvent }
  | { readonly k: 'user'; readonly text: string }
  | { readonly k: 'hydrate'; readonly value: ThreadHydration }
  | { readonly k: 'reset' }

function reduce(state: ChatState, action: Action): ChatState {
  switch (action.k) {
    case 'ev': return chatReducer(state, action.e)
    case 'user': return addUserMessage(state, action.text)
    case 'hydrate': return hydrateChatState(state, action.value)
    case 'reset': return initialChatState()
  }
}

interface EvidenceResources {
  capabilities: ProjectionResource<readonly ProjectionCapability[]>
  snapshot: ProjectionResource<RunSnapshot>
  effects: ProjectionResource<readonly EffectReceipt[]>
  egressReceipts: ProjectionResource<readonly EgressReceipt[]>
  skillReceipts: ProjectionResource<readonly SkillActivationReceipt[]>
  reversalOffers: ProjectionResource<readonly EffectReversalOffer[]>
  reversalReceipts: ProjectionResource<readonly EffectReversalReceipt[]>
}

const NO_RUN = 'no_active_run'

function initialEvidence(): EvidenceResources {
  return {
    capabilities: loadingProjection(),
    snapshot: unavailableProjection(NO_RUN),
    effects: unavailableProjection(NO_RUN),
    egressReceipts: unavailableProjection(NO_RUN),
    skillReceipts: unavailableProjection(NO_RUN),
    reversalOffers: unavailableProjection(NO_RUN),
    reversalReceipts: unavailableProjection(NO_RUN),
  }
}

const PERMISSION_CAPABILITY = { id: 'runs.permissions.decide', minVersion: 1 } as const
const SENSITIVE_SUBMIT_CAPABILITY = { id: 'runs.sensitive-input.submit', minVersion: 1 } as const
const SENSITIVE_DENY_CAPABILITY = { id: 'runs.sensitive-input.deny', minVersion: 1 } as const
const CANCEL_CAPABILITY = { id: 'runs.abort', minVersion: 4 } as const
const HYDRATE_CAPABILITY = { id: 'threads.hydrate', minVersion: 1 } as const

export function useOwnwareAgent(opts: UseOwnwareAgentOptions): OwnwareAgent {
  const { profileId, model, workspaceId, egressMode, sensitiveInputMode } = opts
  const client = useMemo<AgentTransport>(() => {
    if (opts.client) return opts.client
    if (!opts.baseUrl) throw new Error('useOwnwareAgent requires `baseUrl` (or a `client`)')
    return new OwnwareClient({ baseUrl: opts.baseUrl, token: opts.token })
  }, [opts.client, opts.baseUrl, opts.token])

  const [state, dispatch] = useReducer(reduce, null, initialChatState)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const [models, setModels] = useState<readonly ProviderHubModelRoute[]>([])
  const [modelsStatus, setModelsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [threadId, setThreadId] = useState<string | undefined>(opts.threadId)
  const threadIdRef = useRef<string | undefined>(opts.threadId)
  const [activeRunId, setActiveRunId] = useState<string | undefined>()
  const activeRunIdRef = useRef<string | undefined>(undefined)
  const [hydrating, setHydrating] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [evidenceResources, setEvidenceResources] = useState<EvidenceResources>(initialEvidence)
  const capabilitiesRef = useRef<ProjectionResource<readonly ProjectionCapability[]>>(
    loadingProjection(),
  )
  const capabilityPromiseRef = useRef<Promise<ProjectionResource<readonly ProjectionCapability[]>> | null>(null)
  const [busyActions, setBusyActions] = useState<ReadonlySet<string>>(() => new Set())
  const [actionErrors, setActionErrors] = useState<Readonly<Record<string, string>>>({})

  const streamAbortRef = useRef<AbortController | null>(null)
  const streamGenerationRef = useRef(0)

  const setThreadIdentity = useCallback((nextThreadId: string | undefined) => {
    threadIdRef.current = nextThreadId
    setThreadId(nextThreadId)
  }, [])

  const setRunIdentity = useCallback((nextRunId: string | undefined) => {
    activeRunIdRef.current = nextRunId
    setActiveRunId(nextRunId)
  }, [])

  const negotiateCapabilities = useCallback(() => {
    if (capabilityPromiseRef.current !== null) return capabilityPromiseRef.current
    const promise = (async (): Promise<ProjectionResource<readonly ProjectionCapability[]>> => {
      if (!client.capabilities) return unavailableProjection('capability_method_unavailable')
      try {
        const result = await client.capabilities({ requiredMajor: 1 })
        if (result.status === 'available') return readyProjection(result.capabilities)
        if (result.status === 'incompatible') {
          return {
            state: 'incompatible',
            completeness: 'none',
            reason: 'gateway_contract_incompatible',
          }
        }
        return unavailableProjection('gateway_capabilities_unavailable')
      } catch {
        return failedProjection('capability_request_failed')
      }
    })().then((resource) => {
      capabilitiesRef.current = resource
      setEvidenceResources(current => ({ ...current, capabilities: resource }))
      return resource
    })
    capabilityPromiseRef.current = promise
    return promise
  }, [client])

  useEffect(() => {
    capabilityPromiseRef.current = null
    capabilitiesRef.current = loadingProjection()
    setEvidenceResources(initialEvidence())
    void negotiateCapabilities()
  }, [client, negotiateCapabilities])

  useEffect(() => {
    let alive = true
    setModelsStatus('loading')
    client.providerHubModels({ scope: 'recommended', limit: 200 })
      .then((page) => {
        if (!alive) return
        setModels(page.items.map(item => item.model))
        setModelsStatus('ready')
      })
      .catch(() => {
        if (alive) setModelsStatus('error')
      })
    return () => { alive = false }
  }, [client])

  const refreshRunEvidence = useCallback(async (runId: string): Promise<void> => {
    const capabilities = await negotiateCapabilities()
    const supported = (requirement: { readonly id: string; readonly minVersion: number }) =>
      selectCapabilitySupport(capabilities, requirement).state === 'supported'

    setEvidenceResources(current => ({
      ...current,
      snapshot: supported(EVIDENCE_CAPABILITIES.runSnapshot) && client.runSnapshot
        ? loadingProjection()
        : unavailableProjection('run_snapshot_unavailable'),
      effects: supported(EVIDENCE_CAPABILITIES.effectsRead) && client.listEffectReceipts
        ? loadingProjection()
        : unavailableProjection('effect_receipts_unavailable'),
      egressReceipts: supported(EVIDENCE_CAPABILITIES.egressRead) && client.listEgressReceipts
        ? loadingProjection()
        : unavailableProjection('egress_receipts_unavailable'),
      skillReceipts: supported(EVIDENCE_CAPABILITIES.skillActivationsRead) && client.listSkillActivationReceipts
        ? loadingProjection()
        : unavailableProjection('skill_receipts_unavailable'),
      reversalOffers: supported(EVIDENCE_CAPABILITIES.reversalsRead) && client.listEffectReversalOffers
        ? loadingProjection()
        : unavailableProjection('reversal_offers_unavailable'),
      reversalReceipts: supported(EVIDENCE_CAPABILITIES.reversalsRead) && client.listEffectReversalReceipts
        ? loadingProjection()
        : unavailableProjection('reversal_receipts_unavailable'),
    }))

    const [snapshot, effects, egress, skills, offers, reversalReceipts] = await Promise.all([
      loadOne(
        supported(EVIDENCE_CAPABILITIES.runSnapshot) ? client.runSnapshot : undefined,
        runId,
        'run_snapshot_request_failed',
      ),
      loadAllPages(
        supported(EVIDENCE_CAPABILITIES.effectsRead) && client.listEffectReceipts
          ? cursor => client.listEffectReceipts!(runId, { limit: 200, ...(cursor ? { cursor } : {}) })
          : undefined,
        'effect_receipt_request_failed',
      ),
      loadAllPages(
        supported(EVIDENCE_CAPABILITIES.egressRead) && client.listEgressReceipts
          ? cursor => client.listEgressReceipts!(runId, { limit: 200, ...(cursor ? { cursor } : {}) })
          : undefined,
        'egress_receipt_request_failed',
      ),
      loadAllPages(
        supported(EVIDENCE_CAPABILITIES.skillActivationsRead) && client.listSkillActivationReceipts
          ? cursor => client.listSkillActivationReceipts!(runId, { limit: 200, ...(cursor ? { cursor } : {}) })
          : undefined,
        'skill_receipt_request_failed',
      ),
      loadAllPages(
        supported(EVIDENCE_CAPABILITIES.reversalsRead) && client.listEffectReversalOffers
          ? cursor => client.listEffectReversalOffers!(runId, { limit: 200, ...(cursor ? { cursor } : {}) })
          : undefined,
        'reversal_offer_request_failed',
      ),
      loadAllPages(
        supported(EVIDENCE_CAPABILITIES.reversalsRead) && client.listEffectReversalReceipts
          ? cursor => client.listEffectReversalReceipts!(runId, { limit: 200, ...(cursor ? { cursor } : {}) })
          : undefined,
        'reversal_receipt_request_failed',
      ),
    ])

    if (activeRunIdRef.current !== runId) return
    setEvidenceResources(current => ({
      ...current,
      snapshot,
      effects,
      egressReceipts: egress,
      skillReceipts: skills,
      reversalOffers: offers,
      reversalReceipts,
    }))
  }, [client, negotiateCapabilities])

  const hydrateThread = useCallback(async (targetThreadId: string): Promise<ThreadHydration> => {
    if (!client.hydrateThread) throw new Error('thread_hydration_unavailable')
    setHydrating(true)
    try {
      const hydration = await client.hydrateThread(targetThreadId)
      dispatch({ k: 'hydrate', value: hydration })
      setThreadIdentity(hydration.thread.id)
      setRunIdentity(hydration.runningRunId ?? undefined)
      if (hydration.runningRunId) void refreshRunEvidence(hydration.runningRunId)
      return hydration
    } finally {
      setHydrating(false)
    }
  }, [client, refreshRunEvidence, setRunIdentity, setThreadIdentity])

  const startStream = useCallback((streamId: string, targetThreadId: string, since: number) => {
    streamAbortRef.current?.abort()
    const generation = ++streamGenerationRef.current
    const controller = new AbortController()
    streamAbortRef.current = controller

    void (async () => {
      let cursor = since
      let attempts = 0
      while (!controller.signal.aborted && generation === streamGenerationRef.current) {
        let terminal = false
        let needsHydration = false
        try {
          for await (const event of client.events(streamId, {
            since: cursor,
            signal: controller.signal,
          })) {
            const sequenceGap = isSequencedRunObservation(event)
              && cursor > 0
              && event.seq > cursor + 1
            dispatch({ k: 'ev', e: event })
            if (sequenceGap) {
              needsHydration = true
            } else if (Number.isSafeInteger(event.seq) && event.seq > cursor) {
              cursor = event.seq
            }
            attempts = 0
            if (event.type === 'stream.shutdown' && event.data['reason'] === 'slow_consumer') {
              needsHydration = true
            }
            if (hasUnknownStopReason(event)) needsHydration = true
            if (isTerminalEvent(event)) terminal = true
            if (terminal || needsHydration) break
          }
          if (!terminal && !needsHydration) {
            dispatch({
              k: 'ev',
              e: { type: 'stream.shutdown', seq: cursor, data: { reason: 'gateway_shutdown' } },
            })
            attempts += 1
          }
        } catch {
          if (controller.signal.aborted) return
          dispatch({
            k: 'ev',
            e: { type: 'stream.shutdown', seq: cursor, data: { reason: 'gateway_shutdown' } },
          })
          attempts += 1
        }

        if (controller.signal.aborted || generation !== streamGenerationRef.current) return
        if (terminal) {
          dispatch({ k: 'ev', e: { type: 'done', seq: cursor, data: { status: 'complete' } } })
          if (activeRunIdRef.current) await refreshRunEvidence(activeRunIdRef.current)
          return
        }

        if (needsHydration || stateRef.current.connection.phase === 'resync_required') {
          try {
            const hydration = await hydrateThread(targetThreadId)
            cursor = hydration.lastClosedTurnEndSeq
            if (hydration.runningRunId === null) return
            if (hydration.runningRunId !== streamId) {
              startStream(hydration.runningRunId, targetThreadId, cursor)
              return
            }
          } catch {
            dispatch({
              k: 'ev',
              e: { type: 'error', seq: 0, data: { message: 'Could not restore the live thread.' } },
            })
            return
          }
        } else if (activeRunIdRef.current && client.runSnapshot) {
          try {
            const snapshot = await client.runSnapshot(activeRunIdRef.current)
            if (snapshot.terminal) {
              await refreshRunEvidence(snapshot.runId)
              return
            }
          } catch {
            // The reconnect loop remains the source of truth while the Gateway is unavailable.
          }
        }

        await abortableDelay(Math.min(5_000, 250 * 2 ** Math.min(attempts, 4)), controller.signal)
      }
    })()
  }, [client, hydrateThread, refreshRunEvidence])

  useEffect(() => {
    streamAbortRef.current?.abort()
    dispatch({ k: 'reset' })
    setThreadIdentity(opts.threadId)
    setRunIdentity(undefined)
    if (!opts.threadId) return
    let alive = true
    void hydrateThread(opts.threadId)
      .then((hydration) => {
        if (!alive || !hydration.runningRunId) return
        startStream(hydration.runningRunId, hydration.thread.id, hydration.lastClosedTurnEndSeq)
      })
      .catch(() => {
        if (alive) {
          dispatch({
            k: 'ev',
            e: { type: 'error', seq: 0, data: { message: 'Could not load this thread.' } },
          })
        }
      })
    return () => { alive = false }
  }, [opts.threadId, hydrateThread, setRunIdentity, setThreadIdentity, startStream])

  useEffect(() => () => {
    streamGenerationRef.current += 1
    streamAbortRef.current?.abort()
  }, [])

  const send = useCallback(async (prompt: string, options: SendOptions = {}) => {
    const text = prompt.trim()
    if (!text) return
    if (sendingRef.current) throw new Error('run_start_in_progress')
    sendingRef.current = true
    setSending(true)
    clearActionError(setActionErrors, 'send')
    try {
      const interactionCapabilities = sensitiveInputMode === 'component-local'
        ? [SENSITIVE_INPUT_INTERACTION_CAPABILITY]
        : undefined
      const result = await client.run({
        profileId,
        prompt: text,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        ...(model ? { model } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(egressMode ? { egressMode } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(interactionCapabilities ? { interactionCapabilities } : {}),
      })
      setThreadIdentity(result.threadId)
      setRunIdentity(result.runId)
      dispatch({ k: 'user', text })
      if (result.runId) {
        void refreshRunEvidence(result.runId)
        startStream(result.runId, result.threadId, stateRef.current.lastSeq)
      } else {
        startStream(result.threadId, result.threadId, stateRef.current.lastSeq)
      }
    } catch (error) {
      setActionError(setActionErrors, 'send', 'Could not start the run.')
      dispatch({ k: 'ev', e: { type: 'error', seq: 0, data: { message: 'Could not start the run.' } } })
      throw error
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }, [
    client,
    egressMode,
    model,
    profileId,
    refreshRunEvidence,
    sensitiveInputMode,
    setRunIdentity,
    setThreadIdentity,
    startStream,
    workspaceId,
  ])

  const mutate = useCallback(async (
    key: string,
    operation: () => Promise<void>,
    failureMessage: string,
  ) => {
    setBusyActions(current => new Set(current).add(key))
    clearActionError(setActionErrors, key)
    try {
      await operation()
    } catch (error) {
      setActionError(setActionErrors, key, failureMessage)
      throw error
    } finally {
      setBusyActions((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }, [])

  const decidePermission = useCallback(async (
    requestId: string,
    decision: 'approve' | 'deny',
  ) => {
    const runId = activeRunIdRef.current
    const request = stateRef.current.pendingApprovals.find(item => item.requestId === requestId)
    const support = selectCapabilitySupport(capabilitiesRef.current, PERMISSION_CAPABILITY)
    if (
      !runId || !request || !request.operationHash || request.intentRevision !== 1
      || support.state !== 'supported' || !client.decidePermission
    ) throw new Error('exact_permission_decision_unavailable')
    await mutate(`permission:${requestId}`, async () => {
      await client.decidePermission!(runId, requestId, {
        decision,
        operationHash: request.operationHash!,
      })
      dispatch({ k: 'ev', e: { type: 'permission.response', seq: 0, data: { requestId } } })
    }, 'The exact permission decision was not accepted.')
  }, [client, mutate])

  const approve = useCallback(async () => {
    const request = stateRef.current.pendingApprovals[0]
    if (!request) return
    await decidePermission(request.requestId, 'approve')
  }, [decidePermission])

  const deny = useCallback(async () => {
    const request = stateRef.current.pendingApprovals[0]
    if (!request) return
    await decidePermission(request.requestId, 'deny')
  }, [decidePermission])

  const submitSensitiveInput = useCallback(async (requestId: string, value: string) => {
    const runId = activeRunIdRef.current
    const request = stateRef.current.pendingSensitiveInputs.find(item => item.requestId === requestId)
    const support = selectCapabilitySupport(capabilitiesRef.current, SENSITIVE_SUBMIT_CAPABILITY)
    if (
      sensitiveInputMode !== 'component-local' || !runId || !request || value.length === 0
      || support.state !== 'supported' || !client.submitSensitiveInput
    ) throw new Error('sensitive_input_submit_unavailable')
    await mutate(`sensitive:${requestId}`, async () => {
      await client.submitSensitiveInput!(runId, requestId, value)
      dispatch({ k: 'ev', e: { type: 'sensitive.input.response', seq: 0, data: { requestId } } })
    }, 'The sensitive value was not accepted.')
  }, [client, mutate, sensitiveInputMode])

  const denySensitiveInput = useCallback(async (requestId: string) => {
    const runId = activeRunIdRef.current
    const request = stateRef.current.pendingSensitiveInputs.find(item => item.requestId === requestId)
    const support = selectCapabilitySupport(capabilitiesRef.current, SENSITIVE_DENY_CAPABILITY)
    if (!runId || !request || support.state !== 'supported' || !client.denySensitiveInput) {
      throw new Error('sensitive_input_deny_unavailable')
    }
    await mutate(`sensitive:${requestId}`, async () => {
      await client.denySensitiveInput!(runId, requestId)
      dispatch({ k: 'ev', e: { type: 'sensitive.input.response', seq: 0, data: { requestId } } })
    }, 'The sensitive-input denial was not accepted.')
  }, [client, mutate])

  const executeReversal = useCallback(async (offerId: string, idempotencyKey: string) => {
    const runId = activeRunIdRef.current
    const support = selectCapabilitySupport(
      capabilitiesRef.current,
      EVIDENCE_CAPABILITIES.reversalsExecute,
    )
    if (!runId || support.state !== 'supported' || !client.executeEffectReversal) {
      throw new Error('reversal_execution_unavailable')
    }
    await mutate(`reversal:${offerId}`, async () => {
      await client.executeEffectReversal!(runId, offerId, { idempotencyKey })
      await refreshRunEvidence(runId)
    }, 'The reversal request was not confirmed.')
  }, [client, mutate, refreshRunEvidence])

  const abort = useCallback(async () => {
    const runId = activeRunIdRef.current
    const support = selectCapabilitySupport(capabilitiesRef.current, CANCEL_CAPABILITY)
    if (!runId || support.state !== 'supported' || !client.cancel) {
      throw new Error('run_cancellation_unavailable')
    }
    await mutate(`cancel:${runId}`, async () => {
      await client.cancel!(runId)
      await refreshRunEvidence(runId)
    }, 'The cancellation request was not accepted.')
  }, [client, mutate, refreshRunEvidence])

  const refreshEvidence = useCallback(async () => {
    const runId = activeRunIdRef.current
    if (runId) await refreshRunEvidence(runId)
  }, [refreshRunEvidence])

  const rehydrate = useCallback(async () => {
    const targetThreadId = threadIdRef.current
    if (!targetThreadId) return
    const hydration = await hydrateThread(targetThreadId)
    if (hydration.runningRunId) {
      startStream(hydration.runningRunId, targetThreadId, hydration.lastClosedTurnEndSeq)
    }
  }, [hydrateThread, startStream])

  const consequence = useMemo(() => selectRunConsequence({
    capabilities: evidenceResources.capabilities,
    snapshot: evidenceResources.snapshot,
  }), [evidenceResources.capabilities, evidenceResources.snapshot])
  const egress = useMemo(() => selectEgress({
    capabilities: evidenceResources.capabilities,
    snapshot: evidenceResources.snapshot,
    receipts: evidenceResources.egressReceipts,
  }), [
    evidenceResources.capabilities,
    evidenceResources.egressReceipts,
    evidenceResources.snapshot,
  ])
  const skillPlacement = useMemo(() => selectSkillPlacement({
    capabilities: evidenceResources.capabilities,
    receipts: evidenceResources.skillReceipts,
    runId: activeRunId ?? '',
  }), [activeRunId, evidenceResources.capabilities, evidenceResources.skillReceipts])

  const support = useMemo<OwnwareAgentSupport>(() => ({
    permissionDecision: selectCapabilitySupport(evidenceResources.capabilities, PERMISSION_CAPABILITY),
    sensitiveInputSubmit: sensitiveInputMode === 'component-local'
      ? selectCapabilitySupport(evidenceResources.capabilities, SENSITIVE_SUBMIT_CAPABILITY)
      : { state: 'unavailable', reason: 'secure_presenter_absent' },
    sensitiveInputDeny: selectCapabilitySupport(
      evidenceResources.capabilities,
      SENSITIVE_DENY_CAPABILITY,
    ),
    cancellation: selectCapabilitySupport(evidenceResources.capabilities, CANCEL_CAPABILITY),
    hydration: selectCapabilitySupport(evidenceResources.capabilities, HYDRATE_CAPABILITY),
  }), [evidenceResources.capabilities, sensitiveInputMode])

  return {
    messages: state.messages,
    status: state.status,
    streaming: state.status === 'streaming',
    hydrating,
    sending,
    connection: state.connection,
    pendingApproval: state.pendingApproval,
    pendingApprovals: state.pendingApprovals,
    pendingSensitiveInput: state.pendingSensitiveInput,
    pendingSensitiveInputs: state.pendingSensitiveInputs,
    model: state.model,
    error: state.error,
    models,
    modelsStatus,
    threadId,
    activeRunId,
    evidence: {
      ...evidenceResources,
      consequence,
      egress,
      skillPlacement,
    },
    support,
    busyActions,
    actionErrors,
    send,
    decidePermission,
    approve,
    deny,
    submitSensitiveInput,
    denySensitiveInput,
    executeReversal,
    abort,
    refreshEvidence,
    rehydrate,
  }
}

async function loadOne<T>(
  method: ((id: string) => Promise<T>) | undefined,
  id: string,
  errorReason: string,
): Promise<ProjectionResource<T>> {
  if (!method) return unavailableProjection('method_unavailable')
  try {
    return readyProjection(await method(id))
  } catch {
    return failedProjection(errorReason)
  }
}

interface EvidencePage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

async function loadAllPages<T>(
  page: ((cursor?: string) => Promise<EvidencePage<T>>) | undefined,
  errorReason: string,
): Promise<ProjectionResource<readonly T[]>> {
  if (!page) return unavailableProjection('method_unavailable')
  const items: T[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  try {
    for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
      const result = await page(cursor)
      items.push(...result.items)
      if (result.nextCursor === null) return readyProjection(items)
      if (seenCursors.has(result.nextCursor)) {
        return partialProjection(items, 'pagination_cursor_cycle')
      }
      seenCursors.add(result.nextCursor)
      cursor = result.nextCursor
    }
    return partialProjection(items, 'pagination_page_limit')
  } catch {
    return items.length > 0
      ? partialProjection(items, errorReason)
      : failedProjection(errorReason)
  }
}

function isTerminalEvent(event: GatewayEvent): boolean {
  if (event.type === 'turn.interrupted' || event.type === 'error' || event.type === 'done') return true
  if (event.type !== 'turn.end') return false
  const reason = event.data['stopReason']
  return reason === 'end_turn' || reason === 'max_tokens' || reason === 'stop_sequence'
}

function hasUnknownStopReason(event: GatewayEvent): boolean {
  if (event.type !== 'turn.end') return false
  const reason = event.data['stopReason']
  return reason !== 'tool_use' &&
    reason !== 'pause_turn' &&
    reason !== 'end_turn' &&
    reason !== 'max_tokens' &&
    reason !== 'stop_sequence'
}

function isSequencedRunObservation(event: GatewayEvent): boolean {
  return Number.isSafeInteger(event.seq)
    && event.seq > 0
    && event.type !== 'stream.start'
    && event.type !== 'stream.replay.complete'
    && event.type !== 'stream.shutdown'
    && event.type !== 'heartbeat'
    && event.type !== 'done'
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
}

function clearActionError(
  setErrors: (update: (current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>) => void,
  key: string,
): void {
  setErrors((current) => {
    if (!(key in current)) return current
    const next = { ...current }
    delete next[key]
    return next
  })
}

function setActionError(
  setErrors: (update: (current: Readonly<Record<string, string>>) => Readonly<Record<string, string>>) => void,
  key: string,
  message: string,
): void {
  setErrors(current => ({ ...current, [key]: message }))
}
