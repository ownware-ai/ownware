import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_CAPABILITIES,
  loadingProjection,
  partialProjection,
  readyProjection,
  selectCapabilitySupport,
  selectEgress,
  selectReversal,
  selectRunConsequence,
  selectSkillPlacement,
  selectToolEffect,
  type ProjectedEffectReceipt,
  type ProjectedEffectReversalOffer,
  type ProjectedEffectReversalReceipt,
  type ProjectedEgressReceipt,
  type ProjectedRunSnapshot,
  type ProjectedSkillActivationReceipt,
  type ProjectionCapability,
} from '../index.js'

const RUN_ID = 'run-1'

function capabilities(includeExecute = true): readonly ProjectionCapability[] {
  return [
    { id: EVIDENCE_CAPABILITIES.runSnapshot.id, version: EVIDENCE_CAPABILITIES.runSnapshot.minVersion },
    { id: EVIDENCE_CAPABILITIES.effectsRead.id, version: EVIDENCE_CAPABILITIES.effectsRead.minVersion },
    { id: EVIDENCE_CAPABILITIES.egressRead.id, version: EVIDENCE_CAPABILITIES.egressRead.minVersion },
    {
      id: EVIDENCE_CAPABILITIES.skillActivationsRead.id,
      version: EVIDENCE_CAPABILITIES.skillActivationsRead.minVersion,
    },
    { id: EVIDENCE_CAPABILITIES.reversalsRead.id, version: EVIDENCE_CAPABILITIES.reversalsRead.minVersion },
    ...(includeExecute
      ? [{
          id: EVIDENCE_CAPABILITIES.reversalsExecute.id,
          version: EVIDENCE_CAPABILITIES.reversalsExecute.minVersion,
        }]
      : []),
  ]
}

function snapshot(overrides: Partial<ProjectedRunSnapshot> = {}): ProjectedRunSnapshot {
  return {
    runId: RUN_ID,
    status: 'succeeded',
    consequence: 'none_observed',
    terminal: true,
    outcomeKnown: true,
    egressMode: 'unrestricted',
    ...overrides,
  }
}

function effectReceipt(overrides: Partial<ProjectedEffectReceipt> = {}): ProjectedEffectReceipt {
  return {
    receiptId: 'effect-receipt-1',
    sequence: 1,
    effectId: 'effect-1',
    runId: RUN_ID,
    toolCallId: 'tool-call-1',
    toolName: 'arbitrary-new-tool',
    kind: 'outcome_observed',
    outcome: 'succeeded',
    consequence: 'effect_possible',
    authorityKind: 'runtime',
    authorityRef: 'runtime:1',
    observedAt: 100,
    ...overrides,
  }
}

function egressReceipt(overrides: Partial<ProjectedEgressReceipt> = {}): ProjectedEgressReceipt {
  return {
    receiptId: 'egress-receipt-1',
    sequence: 1,
    dispatchId: 'dispatch-1',
    runId: RUN_ID,
    mode: 'local-only',
    sourceKind: 'provider',
    sourceRef: 'provider:1',
    transport: 'https',
    mediation: 'platform_fetch',
    destinationOrigin: 'https://remote.example',
    phase: 'route_unavailable',
    reasonCode: 'local_only_route_unavailable',
    observedAt: 100,
    ...overrides,
  }
}

function skillReceipt(
  overrides: Partial<ProjectedSkillActivationReceipt> = {},
): ProjectedSkillActivationReceipt {
  return {
    receiptId: 'skill-receipt-1',
    sequence: 1,
    runId: RUN_ID,
    profileId: 'profile-1',
    profileDigest: 'profile-digest-1',
    skillName: 'research',
    skillDigest: 'skill-digest-1',
    agentId: null,
    toolCallId: 'tool-call-1',
    turnIndex: 0,
    activatedAt: 100,
    ...overrides,
  }
}

function reversalOffer(
  overrides: Partial<ProjectedEffectReversalOffer> = {},
): ProjectedEffectReversalOffer {
  return {
    offerId: 'offer-1',
    sequence: 1,
    runId: RUN_ID,
    effectId: 'effect-1',
    toolCallId: 'tool-call-1',
    toolName: 'arbitrary-new-tool',
    adapterRef: 'adapter-1',
    adapterRevision: '1',
    operationKind: 'inverse',
    status: 'available',
    createdAt: 100,
    expiresAt: 200,
    resolvedAt: null,
    ...overrides,
  }
}

function reversalReceipt(
  overrides: Partial<ProjectedEffectReversalReceipt> = {},
): ProjectedEffectReversalReceipt {
  return {
    receiptId: 'reversal-receipt-1',
    sequence: 1,
    offerId: 'offer-1',
    runId: RUN_ID,
    effectId: 'effect-1',
    operationKind: 'inverse',
    outcome: 'confirmed',
    authorityRef: 'adapter-1:1',
    actorKind: 'owner',
    observedAt: 150,
    ...overrides,
  }
}

describe('projection capability and resource state', () => {
  it('requires a complete authoritative capability set', () => {
    expect(selectCapabilitySupport(
      readyProjection([{ id: 'runs.effects.read', version: 2 }]),
      EVIDENCE_CAPABILITIES.effectsRead,
    )).toEqual({ state: 'supported', observedVersion: 2 })

    expect(selectCapabilitySupport(
      readyProjection([{ id: 'runs.effects.read', version: 0 }]),
      EVIDENCE_CAPABILITIES.effectsRead,
    )).toEqual({ state: 'unsupported', reason: 'malformed_capability_set' })

    expect(selectCapabilitySupport(
      partialProjection([{ id: 'runs.effects.read', version: 1 }], 'capability_response_partial'),
      EVIDENCE_CAPABILITIES.effectsRead,
    )).toEqual({ state: 'partial', reason: 'capability_response_partial' })

    expect(selectCapabilitySupport(
      readyProjection([]),
      EVIDENCE_CAPABILITIES.effectsRead,
    )).toEqual({ state: 'unavailable', reason: 'capability_absent' })

    expect(selectCapabilitySupport(
      loadingProjection(),
      EVIDENCE_CAPABILITIES.effectsRead,
    )).toEqual({ state: 'loading', reason: 'resource_loading' })
  })
})

describe('EE0 run consequence projection', () => {
  it('does not upgrade successful run status into confirmed effect', () => {
    const projection = selectRunConsequence({
      capabilities: readyProjection(capabilities()),
      snapshot: readyProjection(snapshot({ status: 'succeeded', consequence: 'effect_possible' })),
    })

    expect(projection).toMatchObject({
      state: 'ready',
      status: 'succeeded',
      consequence: 'effect_possible',
      statement: 'An external effect may have occurred.',
    })
  })

  it('fails closed for an unknown consequence variant', () => {
    const future = {
      ...snapshot(),
      consequence: 'future_consequence',
    } as unknown as ProjectedRunSnapshot

    expect(selectRunConsequence({
      capabilities: readyProjection(capabilities()),
      snapshot: readyProjection(future),
    })).toEqual({ state: 'unsupported', reason: 'unknown_run_snapshot_variant' })
  })
})

describe('EE1 tool and effect separation', () => {
  it('keeps a done tool and succeeded lifecycle receipt at effect_possible', () => {
    const projection = selectToolEffect({
      capabilities: readyProjection(capabilities()),
      receipts: readyProjection([effectReceipt({
        toolName: 'effect_confirmed',
        outcome: 'succeeded',
        consequence: 'effect_possible',
      })]),
      runId: RUN_ID,
      toolCallId: 'tool-call-1',
      toolLifecycle: 'done',
    })

    expect(projection).toMatchObject({
      state: 'ready',
      toolLifecycle: 'done',
      effect: {
        state: 'receipt_observed',
        consequence: 'effect_possible',
        statement: 'An external effect may have occurred.',
      },
    })
  })

  it('describes complete absence as no receipt observed, not no effect', () => {
    const projection = selectToolEffect({
      capabilities: readyProjection(capabilities()),
      receipts: readyProjection([]),
      runId: RUN_ID,
      toolCallId: 'tool-call-1',
      toolLifecycle: 'error',
    })

    expect(projection).toMatchObject({
      state: 'ready',
      toolLifecycle: 'error',
      effect: { state: 'not_observed' },
    })
    if (projection.state === 'ready') {
      expect(projection.effect.statement).toContain('No supported effect receipt')
    }
  })

  it('does not project partial or unknown receipt sets as evidence', () => {
    expect(selectToolEffect({
      capabilities: readyProjection(capabilities()),
      receipts: partialProjection([effectReceipt()], 'next_page_not_loaded'),
      runId: RUN_ID,
      toolCallId: 'tool-call-1',
      toolLifecycle: 'done',
    })).toEqual({ state: 'partial', reason: 'next_page_not_loaded' })

    const unknown = { ...effectReceipt(), kind: 'future_receipt_kind' } as unknown as ProjectedEffectReceipt
    expect(selectToolEffect({
      capabilities: readyProjection(capabilities()),
      receipts: readyProjection([unknown]),
      runId: RUN_ID,
      toolCallId: 'tool-call-1',
      toolLifecycle: 'done',
    })).toEqual({ state: 'unsupported', reason: 'malformed_effect_receipt_set' })
  })
})

describe('EE3 egress projection', () => {
  it('shows enforced local-only mode without turning receipt absence into network proof', () => {
    const projection = selectEgress({
      capabilities: readyProjection(capabilities()),
      snapshot: readyProjection(snapshot({ egressMode: 'local-only' })),
      receipts: readyProjection([]),
    })

    expect(projection).toMatchObject({
      state: 'ready',
      mode: 'local-only',
      receiptSetComplete: true,
      observations: [],
    })
    if (projection.state === 'ready') {
      expect(projection.modeStatement).toContain('enforced local-only mode')
      expect(projection.observationStatement).toContain('not proof of universal network inactivity')
    }
  })

  it('preserves the authority-recorded route phase and destination without classifying text', () => {
    const receipt = egressReceipt()
    const projection = selectEgress({
      capabilities: readyProjection(capabilities()),
      snapshot: readyProjection(snapshot({ egressMode: 'local-only' })),
      receipts: readyProjection([receipt]),
    })

    expect(projection).toMatchObject({
      state: 'ready',
      observations: [{
        destinationOrigin: 'https://remote.example',
        phase: 'route_unavailable',
        reasonCode: 'local_only_route_unavailable',
      }],
    })
  })
})

describe('EE5 skill placement projection', () => {
  it('states exact placement without claiming the skill was followed', () => {
    const projection = selectSkillPlacement({
      capabilities: readyProjection(capabilities()),
      receipts: readyProjection([skillReceipt()]),
      runId: RUN_ID,
    })

    expect(projection).toMatchObject({ state: 'ready', placement: 'observed' })
    if (projection.state === 'ready') {
      expect(projection.statement).toContain('placed into the conversation')
      expect(projection.statement).toContain('behavioral compliance is not proven')
    }
  })

  it('treats complete absence only as no supported placement observed', () => {
    expect(selectSkillPlacement({
      capabilities: readyProjection(capabilities()),
      receipts: readyProjection([]),
      runId: RUN_ID,
    })).toMatchObject({
      state: 'ready',
      placement: 'not_observed',
      statement: 'No supported skill-body placement was observed for this run.',
    })
  })
})

describe('EE6 reversal projection', () => {
  it('enables only an exact available inverse using explicit observation time', () => {
    expect(selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: readyProjection([reversalOffer()]),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 150,
    })).toMatchObject({
      state: 'ready',
      operationLabel: 'Reverse effect',
      action: { enabled: true, reason: 'available' },
    })
  })

  it('presents compensation as a separate effect rather than Undo', () => {
    const projection = selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: readyProjection([reversalOffer({ operationKind: 'compensation' })]),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 150,
    })

    expect(projection).toMatchObject({
      state: 'ready',
      operationLabel: 'Apply compensation',
      action: { enabled: true, reason: 'available' },
    })
    if (projection.state === 'ready') {
      expect(projection.operationStatement).toContain('original effect remains in history')
    }
  })

  it('fails closed for expiry, absent execution capability, and partial evidence', () => {
    expect(selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: readyProjection([reversalOffer()]),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 200,
    })).toMatchObject({ action: { enabled: false, reason: 'expired_at_observed_time' } })

    expect(selectReversal({
      capabilities: readyProjection(capabilities(false)),
      offers: readyProjection([reversalOffer()]),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 150,
    })).toMatchObject({ action: { enabled: false, reason: 'execute_capability_unavailable' } })

    expect(selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: partialProjection([reversalOffer()], 'offer_pages_incomplete'),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 150,
    })).toEqual({ state: 'partial', reason: 'offer_pages_incomplete' })
  })

  it('keeps confirmed history visible but disables execution', () => {
    const offer = reversalOffer({ status: 'confirmed', resolvedAt: 150 })
    const receipt = reversalReceipt()
    expect(selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: readyProjection([offer]),
      receipts: readyProjection([receipt]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 160,
    })).toMatchObject({
      state: 'ready',
      latestReceipt: { outcome: 'confirmed' },
      action: { enabled: false, reason: 'offer_confirmed' },
    })
  })

  it('rejects unknown operation kinds instead of treating them as inverse', () => {
    const unknown = {
      ...reversalOffer(),
      operationKind: 'future_operation',
    } as unknown as ProjectedEffectReversalOffer

    expect(selectReversal({
      capabilities: readyProjection(capabilities()),
      offers: readyProjection([unknown]),
      receipts: readyProjection([]),
      runId: RUN_ID,
      offerId: 'offer-1',
      now: 150,
    })).toEqual({ state: 'unsupported', reason: 'malformed_reversal_evidence' })
  })
})
