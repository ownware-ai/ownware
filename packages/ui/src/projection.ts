/**
 * Framework-independent projections of Ownware's public run evidence.
 *
 * These selectors only restate negotiated Gateway records. They never infer an
 * effect, egress containment, skill placement, or reversal support from tool
 * names, result text, or a successful run status.
 */

// ---------------------------------------------------------------------------
// Resource and capability state
// ---------------------------------------------------------------------------

export type ProjectionResource<T> =
  | { readonly state: 'unavailable'; readonly completeness: 'none'; readonly reason: string }
  | { readonly state: 'loading'; readonly completeness: 'none' }
  | { readonly state: 'partial'; readonly completeness: 'partial'; readonly value: T; readonly reason: string }
  | { readonly state: 'ready'; readonly completeness: 'complete'; readonly value: T }
  | { readonly state: 'incompatible'; readonly completeness: 'none'; readonly reason: string }
  | {
      readonly state: 'error'
      readonly completeness: 'none' | 'partial'
      readonly reason: string
      readonly value?: T
    }
  | {
      readonly state: 'unsupported'
      readonly completeness: 'none' | 'partial'
      readonly reason: string
      readonly value?: T
    }

export type ProjectionViewState = ProjectionResource<never>['state']

export function unavailableProjection<T>(reason: string): ProjectionResource<T> {
  return { state: 'unavailable', completeness: 'none', reason }
}

export function loadingProjection<T>(): ProjectionResource<T> {
  return { state: 'loading', completeness: 'none' }
}

export function partialProjection<T>(value: T, reason: string): ProjectionResource<T> {
  return { state: 'partial', completeness: 'partial', value, reason }
}

export function readyProjection<T>(value: T): ProjectionResource<T> {
  return { state: 'ready', completeness: 'complete', value }
}

export function failedProjection<T>(reason: string, value?: T): ProjectionResource<T> {
  return value === undefined
    ? { state: 'error', completeness: 'none', reason }
    : { state: 'error', completeness: 'partial', reason, value }
}

export interface ProjectionCapability {
  readonly id: string
  readonly version: number
}

export interface CapabilityRequirement<Id extends string = string> {
  readonly id: Id
  readonly minVersion: number
}

/** Exact public contracts consumed by the evidence selectors in this module. */
export const EVIDENCE_CAPABILITIES = {
  runSnapshot: { id: 'runs.snapshot', minVersion: 5 },
  effectsRead: { id: 'runs.effects.read', minVersion: 1 },
  egressRead: { id: 'runs.egress.read', minVersion: 1 },
  skillActivationsRead: { id: 'runs.skill-activations.read', minVersion: 1 },
  reversalsRead: { id: 'runs.reversals.read', minVersion: 1 },
  reversalsExecute: { id: 'runs.reversals.execute', minVersion: 1 },
} as const satisfies Readonly<Record<string, CapabilityRequirement>>

export type CapabilitySupport =
  | { readonly state: 'supported'; readonly observedVersion: number }
  | {
      readonly state: Exclude<ProjectionViewState, 'ready'>
      readonly reason: string
      readonly observedVersion?: number
    }

export function selectCapabilitySupport(
  capabilities: ProjectionResource<readonly ProjectionCapability[]>,
  requirement: CapabilityRequirement,
): CapabilitySupport {
  if (capabilities.state !== 'ready') return resourceBlocked(capabilities)!

  if (!Array.isArray(capabilities.value) || !capabilities.value.every(isCapability)) {
    return { state: 'unsupported', reason: 'malformed_capability_set' }
  }

  let observedVersion: number | undefined
  for (const capability of capabilities.value) {
    if (capability.id !== requirement.id) continue
    if (observedVersion === undefined || capability.version > observedVersion) {
      observedVersion = capability.version
    }
  }

  if (observedVersion === undefined) {
    return { state: 'unavailable', reason: 'capability_absent' }
  }
  if (observedVersion < requirement.minVersion) {
    return { state: 'incompatible', reason: 'capability_version_too_old', observedVersion }
  }
  return { state: 'supported', observedVersion }
}

// ---------------------------------------------------------------------------
// Public evidence records mirrored structurally for a zero-dependency package
// ---------------------------------------------------------------------------

export type ProjectedDurableRunStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate'

export type ProjectedRunConsequence =
  | 'none_observed'
  | 'output_observed'
  | 'effect_possible'
  | 'effect_confirmed'

export type ProjectedEgressMode = 'unrestricted' | 'local-only'

export interface ProjectedRunSnapshot {
  readonly runId: string
  readonly status: ProjectedDurableRunStatus
  readonly consequence: ProjectedRunConsequence
  readonly terminal: boolean
  readonly outcomeKnown: boolean
  readonly egressMode: ProjectedEgressMode
}

export type ProjectedEffectReceiptKind =
  | 'intent_observed'
  | 'outcome_observed'
  | 'authority_confirmed'
  | 'reconciliation'

export type ProjectedEffectReceiptOutcome = 'pending' | 'succeeded' | 'failed' | 'denied' | 'unknown'

export interface ProjectedEffectReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly effectId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: ProjectedEffectReceiptKind
  /** Tool lifecycle outcome; it is not external-effect proof. */
  readonly outcome: ProjectedEffectReceiptOutcome
  readonly consequence: ProjectedRunConsequence
  readonly authorityKind: 'runtime' | 'effect_observer' | 'reconciler'
  readonly authorityRef: string
  readonly observedAt: number
}

export type ProjectedEgressReceiptPhase =
  | 'dispatch_started'
  | 'response_observed'
  | 'dispatch_failed'
  | 'dispatch_blocked'
  | 'route_unavailable'
  | 'outcome_unknown'

export type ProjectedEgressReasonCode =
  | 'local_only_remote_destination'
  | 'local_only_custom_transport'
  | 'local_only_route_unavailable'
  | 'local_only_redirect'
  | 'route_unavailable'
  | 'run_terminated_after_dispatch'
  | 'gateway_restarted_after_dispatch'

export interface ProjectedEgressReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly dispatchId: string
  readonly runId: string
  readonly mode: ProjectedEgressMode
  readonly sourceKind: 'provider' | 'tool' | 'connector' | 'browser' | 'process' | 'runtime'
  readonly sourceRef: string
  readonly transport: 'http' | 'https' | 'ws' | 'wss' | 'tcp' | 'tls' | 'unknown'
  readonly mediation: 'platform_fetch' | 'custom_fetch' | 'uncontained' | 'unknown'
  readonly destinationOrigin: string | null
  readonly phase: ProjectedEgressReceiptPhase
  readonly reasonCode: ProjectedEgressReasonCode | null
  readonly observedAt: number
}

export interface ProjectedSkillActivationReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly runId: string
  readonly profileId: string
  readonly profileDigest: string
  readonly skillName: string
  readonly skillDigest: string
  readonly agentId: string | null
  readonly toolCallId: string | null
  readonly turnIndex: number
  readonly activatedAt: number
}

export type ProjectedReversalOperationKind = 'inverse' | 'compensation'
export type ProjectedReversalOfferStatus = 'available' | 'confirmed' | 'stale' | 'expired'
export type ProjectedReversalReceiptOutcome = 'confirmed' | 'stale' | 'expired'

export interface ProjectedEffectReversalOffer {
  readonly offerId: string
  readonly sequence: number
  readonly runId: string
  readonly effectId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly adapterRef: string
  readonly adapterRevision: string
  readonly operationKind: ProjectedReversalOperationKind
  readonly status: ProjectedReversalOfferStatus
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly resolvedAt: number | null
}

export interface ProjectedEffectReversalReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly offerId: string
  readonly runId: string
  readonly effectId: string
  readonly operationKind: ProjectedReversalOperationKind
  readonly outcome: ProjectedReversalReceiptOutcome
  readonly authorityRef: string
  readonly actorKind: 'owner' | 'delegated'
  readonly observedAt: number
}

export interface ProjectionBlocked {
  readonly state: Exclude<ProjectionViewState, 'ready'>
  readonly reason: string
}

// ---------------------------------------------------------------------------
// EE0: durable run consequence
// ---------------------------------------------------------------------------

export type RunConsequenceProjection =
  | ProjectionBlocked
  | {
      readonly state: 'ready'
      readonly status: ProjectedDurableRunStatus
      readonly consequence: ProjectedRunConsequence
      readonly terminal: boolean
      readonly outcomeKnown: boolean
      readonly statement: string
    }

export function selectRunConsequence(input: {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly snapshot: ProjectionResource<ProjectedRunSnapshot>
}): RunConsequenceProjection {
  const capability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.runSnapshot)
  if (capability !== null) return capability
  if (input.snapshot.state !== 'ready') return resourceBlocked(input.snapshot)!
  if (!isRunConsequenceSnapshot(input.snapshot.value)) {
    return { state: 'unsupported', reason: 'unknown_run_snapshot_variant' }
  }

  return {
    state: 'ready',
    status: input.snapshot.value.status,
    consequence: input.snapshot.value.consequence,
    terminal: input.snapshot.value.terminal,
    outcomeKnown: input.snapshot.value.outcomeKnown,
    statement: consequenceStatement(input.snapshot.value.consequence),
  }
}

// ---------------------------------------------------------------------------
// EE1: tool lifecycle and effect evidence remain separate
// ---------------------------------------------------------------------------

export type ProjectedToolLifecycleStatus = 'running' | 'done' | 'error'

export type ToolEffectProjection =
  | ProjectionBlocked
  | {
      readonly state: 'ready'
      readonly toolLifecycle: ProjectedToolLifecycleStatus
      readonly effect:
        | {
            readonly state: 'not_observed'
            readonly statement: string
          }
        | {
            readonly state: 'receipt_observed'
            readonly receipt: ProjectedEffectReceipt
            readonly consequence: ProjectedRunConsequence
            readonly statement: string
          }
    }

export function selectToolEffect(input: {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly receipts: ProjectionResource<readonly ProjectedEffectReceipt[]>
  readonly runId: string
  readonly toolCallId: string
  readonly toolLifecycle: ProjectedToolLifecycleStatus
}): ToolEffectProjection {
  const capability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.effectsRead)
  if (capability !== null) return capability
  if (input.receipts.state !== 'ready') return resourceBlocked(input.receipts)!
  if (
    !isNonEmptyString(input.runId)
    || !isNonEmptyString(input.toolCallId)
    || !isToolLifecycle(input.toolLifecycle)
    || !Array.isArray(input.receipts.value)
    || !input.receipts.value.every(isEffectReceipt)
    || input.receipts.value.some((receipt) => receipt.runId !== input.runId)
    || hasDuplicateIdentity(input.receipts.value, (receipt) => receipt.receiptId, (receipt) => receipt.sequence)
  ) {
    return { state: 'unsupported', reason: 'malformed_effect_receipt_set' }
  }

  const matching = input.receipts.value
    .filter((receipt) => receipt.toolCallId === input.toolCallId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence)

  if (matching.length === 0) {
    return {
      state: 'ready',
      toolLifecycle: input.toolLifecycle,
      effect: {
        state: 'not_observed',
        statement: 'No supported effect receipt was observed for this tool call.',
      },
    }
  }

  const effectId = matching[0]!.effectId
  let previousRank = -1
  for (const receipt of matching) {
    const rank = consequenceRank(receipt.consequence)
    if (receipt.effectId !== effectId || rank < previousRank) {
      return { state: 'unsupported', reason: 'conflicting_effect_receipts' }
    }
    previousRank = rank
  }

  const receipt = matching.at(-1)!
  return {
    state: 'ready',
    toolLifecycle: input.toolLifecycle,
    effect: {
      state: 'receipt_observed',
      receipt,
      consequence: receipt.consequence,
      statement: consequenceStatement(receipt.consequence),
    },
  }
}

// ---------------------------------------------------------------------------
// EE3: egress mode and content-free observations
// ---------------------------------------------------------------------------

export type EgressProjection =
  | ProjectionBlocked
  | {
      readonly state: 'ready'
      readonly mode: ProjectedEgressMode
      readonly modeStatement: string
      readonly observations: readonly ProjectedEgressReceipt[]
      readonly observationStatement: string
      /** Complete means all pages of the supported receipt endpoint were loaded. */
      readonly receiptSetComplete: true
    }

export function selectEgress(input: {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly snapshot: ProjectionResource<ProjectedRunSnapshot>
  readonly receipts: ProjectionResource<readonly ProjectedEgressReceipt[]>
}): EgressProjection {
  const snapshotCapability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.runSnapshot)
  if (snapshotCapability !== null) return snapshotCapability
  const egressCapability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.egressRead)
  if (egressCapability !== null) return egressCapability

  if (input.snapshot.state !== 'ready') return resourceBlocked(input.snapshot)!
  if (input.receipts.state !== 'ready') return resourceBlocked(input.receipts)!

  const snapshot = input.snapshot.value
  if (
    !isRunEgressSnapshot(snapshot)
    || !Array.isArray(input.receipts.value)
    || !input.receipts.value.every(isEgressReceipt)
    || input.receipts.value.some((receipt) => receipt.runId !== snapshot.runId)
    || hasDuplicateIdentity(input.receipts.value, (receipt) => receipt.receiptId, (receipt) => receipt.sequence)
  ) {
    return { state: 'unsupported', reason: 'malformed_egress_evidence' }
  }

  const observations = input.receipts.value.slice().sort((a, b) => a.sequence - b.sequence)
  return {
    state: 'ready',
    mode: snapshot.egressMode,
    modeStatement: snapshot.egressMode === 'local-only'
      ? 'The Gateway enforced local-only mode for this run.'
      : 'This run was not restricted to local-only egress.',
    observations,
    observationStatement: observations.length === 0
      ? 'No supported egress receipt was observed. Receipt absence is not proof of universal network inactivity.'
      : 'These are the content-free outbound route observations recorded for this run.',
    receiptSetComplete: true,
  }
}

// ---------------------------------------------------------------------------
// EE5: exact skill-body placement, never behavioral compliance
// ---------------------------------------------------------------------------

export type SkillPlacementProjection =
  | ProjectionBlocked
  | {
      readonly state: 'ready'
      readonly placement: 'observed' | 'not_observed'
      readonly receipts: readonly ProjectedSkillActivationReceipt[]
      readonly statement: string
    }

export function selectSkillPlacement(input: {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly receipts: ProjectionResource<readonly ProjectedSkillActivationReceipt[]>
  readonly runId: string
}): SkillPlacementProjection {
  const capability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.skillActivationsRead)
  if (capability !== null) return capability
  if (input.receipts.state !== 'ready') return resourceBlocked(input.receipts)!
  if (
    !isNonEmptyString(input.runId)
    || !Array.isArray(input.receipts.value)
    || !input.receipts.value.every(isSkillReceipt)
    || input.receipts.value.some((receipt) => receipt.runId !== input.runId)
    || hasDuplicateIdentity(input.receipts.value, (receipt) => receipt.receiptId, (receipt) => receipt.sequence)
  ) {
    return { state: 'unsupported', reason: 'malformed_skill_activation_receipt_set' }
  }

  const receipts = input.receipts.value.slice().sort((a, b) => a.sequence - b.sequence)
  return receipts.length === 0
    ? {
        state: 'ready',
        placement: 'not_observed',
        receipts,
        statement: 'No supported skill-body placement was observed for this run.',
      }
    : {
        state: 'ready',
        placement: 'observed',
        receipts,
        statement: 'The exact recorded skill body was placed into the conversation; behavioral compliance is not proven.',
      }
}

// ---------------------------------------------------------------------------
// EE6: exact inverse/compensation offers and fail-closed execution affordance
// ---------------------------------------------------------------------------

export type ReversalActionDisabledReason =
  | 'offer_not_found'
  | 'execute_capability_unavailable'
  | 'offer_confirmed'
  | 'offer_stale'
  | 'offer_expired'
  | 'expired_at_observed_time'
  | 'invalid_observed_time'

export type ReversalProjection =
  | ProjectionBlocked
  | {
      readonly state: 'ready'
      readonly offer?: ProjectedEffectReversalOffer
      readonly latestReceipt?: ProjectedEffectReversalReceipt
      readonly operationLabel?: 'Reverse effect' | 'Apply compensation'
      readonly operationStatement?: string
      readonly action:
        | { readonly enabled: true; readonly reason: 'available' }
        | { readonly enabled: false; readonly reason: ReversalActionDisabledReason }
    }

export function selectReversal(input: {
  readonly capabilities: ProjectionResource<readonly ProjectionCapability[]>
  readonly offers: ProjectionResource<readonly ProjectedEffectReversalOffer[]>
  readonly receipts: ProjectionResource<readonly ProjectedEffectReversalReceipt[]>
  readonly runId: string
  readonly offerId: string
  /** Explicit caller observation time; selectors never read the system clock. */
  readonly now: number
}): ReversalProjection {
  const readCapability = requireCapability(input.capabilities, EVIDENCE_CAPABILITIES.reversalsRead)
  if (readCapability !== null) return readCapability
  if (input.offers.state !== 'ready') return resourceBlocked(input.offers)!
  if (input.receipts.state !== 'ready') return resourceBlocked(input.receipts)!

  if (
    !isNonEmptyString(input.runId)
    || !isNonEmptyString(input.offerId)
    || !Array.isArray(input.offers.value)
    || !input.offers.value.every(isReversalOffer)
    || input.offers.value.some((offer) => offer.runId !== input.runId)
    || hasDuplicateIdentity(input.offers.value, (offer) => offer.offerId, (offer) => offer.sequence)
    || !Array.isArray(input.receipts.value)
    || !input.receipts.value.every(isReversalReceipt)
    || input.receipts.value.some((receipt) => receipt.runId !== input.runId)
    || hasDuplicateIdentity(input.receipts.value, (receipt) => receipt.receiptId, (receipt) => receipt.sequence)
  ) {
    return { state: 'unsupported', reason: 'malformed_reversal_evidence' }
  }

  const offer = input.offers.value.find((candidate) => candidate.offerId === input.offerId)
  if (offer === undefined) {
    return { state: 'ready', action: { enabled: false, reason: 'offer_not_found' } }
  }

  const matchingReceipts = input.receipts.value
    .filter((receipt) => receipt.offerId === offer.offerId)
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
  const latestReceipt = matchingReceipts.at(-1)
  if (
    matchingReceipts.some((receipt) =>
      receipt.effectId !== offer.effectId || receipt.operationKind !== offer.operationKind)
    || (offer.status === 'available' && latestReceipt !== undefined)
    || (offer.status !== 'available' && latestReceipt === undefined)
    || (latestReceipt !== undefined && offer.status !== latestReceipt.outcome)
  ) {
    return { state: 'unsupported', reason: 'conflicting_reversal_evidence' }
  }

  const operationLabel: 'Reverse effect' | 'Apply compensation' = offer.operationKind === 'inverse'
    ? 'Reverse effect'
    : 'Apply compensation'
  const operationStatement = offer.operationKind === 'inverse'
    ? 'Apply the registered inverse under its current authority preconditions.'
    : 'Apply a separate compensating effect; the original effect remains in history.'

  const base = { state: 'ready' as const, offer, latestReceipt, operationLabel, operationStatement }
  if (offer.status === 'confirmed') {
    return { ...base, action: { enabled: false, reason: 'offer_confirmed' } }
  }
  if (offer.status === 'stale') {
    return { ...base, action: { enabled: false, reason: 'offer_stale' } }
  }
  if (offer.status === 'expired') {
    return { ...base, action: { enabled: false, reason: 'offer_expired' } }
  }
  if (!isTimestamp(input.now)) {
    return { ...base, action: { enabled: false, reason: 'invalid_observed_time' } }
  }
  if (offer.expiresAt !== null && offer.expiresAt <= input.now) {
    return { ...base, action: { enabled: false, reason: 'expired_at_observed_time' } }
  }

  const executeCapability = selectCapabilitySupport(input.capabilities, EVIDENCE_CAPABILITIES.reversalsExecute)
  if (executeCapability.state !== 'supported') {
    return { ...base, action: { enabled: false, reason: 'execute_capability_unavailable' } }
  }
  return { ...base, action: { enabled: true, reason: 'available' } }
}

// ---------------------------------------------------------------------------
// Defensive structural validation
// ---------------------------------------------------------------------------

function resourceBlocked<T>(resource: ProjectionResource<T>): ProjectionBlocked | null {
  switch (resource.state) {
    case 'ready':
      return null
    case 'unavailable':
    case 'partial':
    case 'incompatible':
    case 'error':
    case 'unsupported':
      return { state: resource.state, reason: resource.reason }
    case 'loading':
      return { state: 'loading', reason: 'resource_loading' }
    default:
      return { state: 'unsupported', reason: 'unknown_resource_state' }
  }
}

function requireCapability(
  capabilities: ProjectionResource<readonly ProjectionCapability[]>,
  requirement: CapabilityRequirement,
): ProjectionBlocked | null {
  const support = selectCapabilitySupport(capabilities, requirement)
  if (support.state === 'supported') return null
  return { state: support.state, reason: support.reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value)
}

function isCapability(value: unknown): value is ProjectionCapability {
  return isRecord(value)
    && isNonEmptyString(value['id'])
    && isPositiveSequence(value['version'])
}

function isDurableRunStatus(value: unknown): value is ProjectedDurableRunStatus {
  switch (value) {
    case 'accepted':
    case 'running':
    case 'waiting':
    case 'cancel_requested':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'timed_out':
    case 'indeterminate':
      return true
    default:
      return false
  }
}

function isConsequence(value: unknown): value is ProjectedRunConsequence {
  switch (value) {
    case 'none_observed':
    case 'output_observed':
    case 'effect_possible':
    case 'effect_confirmed':
      return true
    default:
      return false
  }
}

function consequenceRank(value: ProjectedRunConsequence): number {
  switch (value) {
    case 'none_observed': return 0
    case 'output_observed': return 1
    case 'effect_possible': return 2
    case 'effect_confirmed': return 3
  }
}

function consequenceStatement(value: ProjectedRunConsequence): string {
  switch (value) {
    case 'none_observed':
      return 'No output or external effect has been observed.'
    case 'output_observed':
      return 'Output was observed; no external effect is confirmed.'
    case 'effect_possible':
      return 'An external effect may have occurred.'
    case 'effect_confirmed':
      return 'An external effect was confirmed within the registered authority boundary.'
  }
}

function isEgressMode(value: unknown): value is ProjectedEgressMode {
  return value === 'unrestricted' || value === 'local-only'
}

function isRunConsequenceSnapshot(value: unknown): value is ProjectedRunSnapshot {
  return isRecord(value)
    && isNonEmptyString(value['runId'])
    && isDurableRunStatus(value['status'])
    && isConsequence(value['consequence'])
    && typeof value['terminal'] === 'boolean'
    && typeof value['outcomeKnown'] === 'boolean'
}

function isRunEgressSnapshot(value: unknown): value is ProjectedRunSnapshot {
  return isRecord(value)
    && isNonEmptyString(value['runId'])
    && isEgressMode(value['egressMode'])
}

function isToolLifecycle(value: unknown): value is ProjectedToolLifecycleStatus {
  return value === 'running' || value === 'done' || value === 'error'
}

function isEffectReceiptKind(value: unknown): value is ProjectedEffectReceiptKind {
  switch (value) {
    case 'intent_observed':
    case 'outcome_observed':
    case 'authority_confirmed':
    case 'reconciliation':
      return true
    default:
      return false
  }
}

function isEffectOutcome(value: unknown): value is ProjectedEffectReceiptOutcome {
  switch (value) {
    case 'pending':
    case 'succeeded':
    case 'failed':
    case 'denied':
    case 'unknown':
      return true
    default:
      return false
  }
}

function isAuthorityKind(value: unknown): value is ProjectedEffectReceipt['authorityKind'] {
  return value === 'runtime' || value === 'effect_observer' || value === 'reconciler'
}

function isEffectReceipt(value: unknown): value is ProjectedEffectReceipt {
  return isRecord(value)
    && isNonEmptyString(value['receiptId'])
    && isPositiveSequence(value['sequence'])
    && isNonEmptyString(value['effectId'])
    && isNonEmptyString(value['runId'])
    && isNonEmptyString(value['toolCallId'])
    && isNonEmptyString(value['toolName'])
    && isEffectReceiptKind(value['kind'])
    && isEffectOutcome(value['outcome'])
    && isConsequence(value['consequence'])
    && isAuthorityKind(value['authorityKind'])
    && isNonEmptyString(value['authorityRef'])
    && isTimestamp(value['observedAt'])
}

function isEgressPhase(value: unknown): value is ProjectedEgressReceiptPhase {
  switch (value) {
    case 'dispatch_started':
    case 'response_observed':
    case 'dispatch_failed':
    case 'dispatch_blocked':
    case 'route_unavailable':
    case 'outcome_unknown':
      return true
    default:
      return false
  }
}

function isEgressReason(value: unknown): value is ProjectedEgressReasonCode | null {
  switch (value) {
    case null:
    case 'local_only_remote_destination':
    case 'local_only_custom_transport':
    case 'local_only_route_unavailable':
    case 'local_only_redirect':
    case 'route_unavailable':
    case 'run_terminated_after_dispatch':
    case 'gateway_restarted_after_dispatch':
      return true
    default:
      return false
  }
}

function isEgressSource(value: unknown): value is ProjectedEgressReceipt['sourceKind'] {
  switch (value) {
    case 'provider':
    case 'tool':
    case 'connector':
    case 'browser':
    case 'process':
    case 'runtime':
      return true
    default:
      return false
  }
}

function isEgressTransport(value: unknown): value is ProjectedEgressReceipt['transport'] {
  switch (value) {
    case 'http':
    case 'https':
    case 'ws':
    case 'wss':
    case 'tcp':
    case 'tls':
    case 'unknown':
      return true
    default:
      return false
  }
}

function isEgressMediation(value: unknown): value is ProjectedEgressReceipt['mediation'] {
  return value === 'platform_fetch'
    || value === 'custom_fetch'
    || value === 'uncontained'
    || value === 'unknown'
}

function isEgressReceipt(value: unknown): value is ProjectedEgressReceipt {
  return isRecord(value)
    && isNonEmptyString(value['receiptId'])
    && isPositiveSequence(value['sequence'])
    && isNonEmptyString(value['dispatchId'])
    && isNonEmptyString(value['runId'])
    && isEgressMode(value['mode'])
    && isEgressSource(value['sourceKind'])
    && isNonEmptyString(value['sourceRef'])
    && isEgressTransport(value['transport'])
    && isEgressMediation(value['mediation'])
    && (value['destinationOrigin'] === null || isNonEmptyString(value['destinationOrigin']))
    && isEgressPhase(value['phase'])
    && isEgressReason(value['reasonCode'])
    && isTimestamp(value['observedAt'])
}

function isSkillReceipt(value: unknown): value is ProjectedSkillActivationReceipt {
  return isRecord(value)
    && isNonEmptyString(value['receiptId'])
    && isPositiveSequence(value['sequence'])
    && isNonEmptyString(value['runId'])
    && isNonEmptyString(value['profileId'])
    && isNonEmptyString(value['profileDigest'])
    && isNonEmptyString(value['skillName'])
    && isNonEmptyString(value['skillDigest'])
    && (value['agentId'] === null || isNonEmptyString(value['agentId']))
    && (value['toolCallId'] === null || isNonEmptyString(value['toolCallId']))
    && isTimestamp(value['turnIndex'])
    && isTimestamp(value['activatedAt'])
}

function isReversalKind(value: unknown): value is ProjectedReversalOperationKind {
  return value === 'inverse' || value === 'compensation'
}

function isReversalStatus(value: unknown): value is ProjectedReversalOfferStatus {
  return value === 'available' || value === 'confirmed' || value === 'stale' || value === 'expired'
}

function isReversalOutcome(value: unknown): value is ProjectedReversalReceiptOutcome {
  return value === 'confirmed' || value === 'stale' || value === 'expired'
}

function isReversalOffer(value: unknown): value is ProjectedEffectReversalOffer {
  return isRecord(value)
    && isNonEmptyString(value['offerId'])
    && isPositiveSequence(value['sequence'])
    && isNonEmptyString(value['runId'])
    && isNonEmptyString(value['effectId'])
    && isNonEmptyString(value['toolCallId'])
    && isNonEmptyString(value['toolName'])
    && isNonEmptyString(value['adapterRef'])
    && isNonEmptyString(value['adapterRevision'])
    && isReversalKind(value['operationKind'])
    && isReversalStatus(value['status'])
    && isTimestamp(value['createdAt'])
    && isNullableTimestamp(value['expiresAt'])
    && isNullableTimestamp(value['resolvedAt'])
    && (value['expiresAt'] === null || value['expiresAt'] > value['createdAt'])
    && (value['resolvedAt'] === null || value['resolvedAt'] >= value['createdAt'])
    && (value['status'] === 'available' ? value['resolvedAt'] === null : value['resolvedAt'] !== null)
}

function isReversalReceipt(value: unknown): value is ProjectedEffectReversalReceipt {
  return isRecord(value)
    && isNonEmptyString(value['receiptId'])
    && isPositiveSequence(value['sequence'])
    && isNonEmptyString(value['offerId'])
    && isNonEmptyString(value['runId'])
    && isNonEmptyString(value['effectId'])
    && isReversalKind(value['operationKind'])
    && isReversalOutcome(value['outcome'])
    && isNonEmptyString(value['authorityRef'])
    && (value['actorKind'] === 'owner' || value['actorKind'] === 'delegated')
    && isTimestamp(value['observedAt'])
}

function hasDuplicateIdentity<T>(
  values: readonly T[],
  id: (value: T) => string,
  sequence: (value: T) => number,
): boolean {
  const ids = new Set<string>()
  const sequences = new Set<number>()
  for (const value of values) {
    const itemId = id(value)
    const itemSequence = sequence(value)
    if (ids.has(itemId) || sequences.has(itemSequence)) return true
    ids.add(itemId)
    sequences.add(itemSequence)
  }
  return false
}
