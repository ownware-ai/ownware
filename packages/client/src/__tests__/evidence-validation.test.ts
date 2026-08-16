import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../index.js'

const RUN_ID = '88888888-8888-4888-8888-888888888888'
const OTHER_RUN_ID = '99999999-9999-4999-8999-999999999999'
const REQUEST_ID = 'permission_1'
const OFFER_ID = '66666666-6666-4666-8666-666666666666'

function clientReturning(body: unknown, status = 200): OwnwareClient {
  const injectedFetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  return new OwnwareClient({ baseUrl: 'https://ownware.invalid', fetch: injectedFetch })
}

function invalidResponse(code: string): object {
  return {
    name: 'OwnwareError',
    status: 200,
    code,
    category: 'validation',
  }
}

const snapshot = {
  runId: RUN_ID,
  threadId: 'thread_1',
  workspaceId: null,
  profileId: 'assistant',
  candidateId: null,
  model: 'ollama:llama3.2',
  timeoutMs: 60_000,
  egressMode: 'local-only',
  status: 'running',
  consequence: 'none_observed',
  terminal: false,
  outcomeKnown: true,
  acceptedAt: 100,
  startedAt: 101,
  updatedAt: 102,
  terminalAt: null,
  cancelRequestedAt: null,
  startSeq: 0,
  endSeq: null,
  earliestRetainedCursor: null,
  code: null,
  futureSnapshotField: { additive: true },
} as const

const effectReceipt = {
  receiptId: '11111111-1111-4111-8111-111111111111',
  sequence: 1,
  effectId: '22222222-2222-4222-8222-222222222222',
  runId: RUN_ID,
  toolCallId: 'call_1',
  toolName: 'send_message',
  kind: 'authority_confirmed',
  outcome: 'succeeded',
  consequence: 'effect_confirmed',
  authorityKind: 'effect_observer',
  authorityRef: 'connector.message.lookup',
  observedAt: 110,
  futureReceiptField: true,
} as const

const egressReceipt = {
  receiptId: '33333333-3333-4333-8333-333333333333',
  sequence: 1,
  dispatchId: '44444444-4444-4444-8444-444444444444',
  runId: RUN_ID,
  mode: 'local-only',
  sourceKind: 'provider',
  sourceRef: 'ollama',
  transport: 'http',
  mediation: 'platform_fetch',
  destinationOrigin: 'http://127.0.0.1:11434',
  phase: 'dispatch_started',
  reasonCode: null,
  observedAt: 111,
  futureReceiptField: true,
} as const

const skillReceipt = {
  receiptId: '55555555-5555-4555-8555-555555555555',
  sequence: 1,
  runId: RUN_ID,
  profileId: 'assistant',
  profileDigest: `hmac-sha256:${'a'.repeat(64)}`,
  skillName: 'analysis',
  skillDigest: `hmac-sha256:${'b'.repeat(64)}`,
  agentId: null,
  toolCallId: 'call_skill_1',
  turnIndex: 0,
  activatedAt: 112,
  futureReceiptField: true,
} as const

const reversalOffer = {
  offerId: OFFER_ID,
  sequence: 1,
  runId: RUN_ID,
  effectId: effectReceipt.effectId,
  toolCallId: effectReceipt.toolCallId,
  toolName: 'memory.pending-proposal.create',
  adapterRef: 'memory.pending-proposal',
  adapterRevision: '1',
  operationKind: 'compensation',
  status: 'confirmed',
  createdAt: 113,
  expiresAt: null,
  resolvedAt: 114,
  futureOfferField: true,
} as const

const reversalReceipt = {
  receiptId: '77777777-7777-4777-8777-777777777777',
  sequence: 1,
  offerId: OFFER_ID,
  runId: RUN_ID,
  effectId: effectReceipt.effectId,
  operationKind: 'compensation',
  outcome: 'confirmed',
  authorityRef: 'memory.pending-proposal:1',
  actorKind: 'owner',
  observedAt: 114,
  futureReceiptField: true,
} as const

describe('runtime capability document validation', () => {
  it('accepts unknown additive fields and unknown well-formed capability IDs', async () => {
    const ownware = clientReturning({
      contract: {
        name: 'ownware.gateway',
        major: 1,
        revision: '0.45.0',
        futureContractField: 'accepted',
      },
      capabilities: [
        { id: 'gateway.capabilities', version: 26, futureCapabilityField: true },
        { id: 'future.evidence.read', version: 1 },
      ],
      futureDocumentField: { accepted: true },
    })

    await expect(ownware.capabilities({
      requiredCapabilities: { 'future.evidence.read': 1 },
    })).resolves.toMatchObject({
      status: 'available',
      contract: { name: 'ownware.gateway', major: 1, revision: '0.45.0' },
      capabilities: [
        { id: 'gateway.capabilities', version: 26 },
        { id: 'future.evidence.read', version: 1 },
      ],
    })
  })

  it('fails honestly on wrong identity, duplicate IDs, and malformed versions', async () => {
    const malformed = [
      {
        contract: { name: 'other.gateway', major: 1, revision: '0.45.0' },
        capabilities: [],
      },
      {
        contract: { name: 'ownware.gateway', major: 1, revision: '0.45.0' },
        capabilities: [
          { id: 'runs.snapshot', version: 5 },
          { id: 'runs.snapshot', version: 6 },
        ],
      },
      {
        contract: { name: 'ownware.gateway', major: 1, revision: 'next' },
        capabilities: [],
      },
      {
        contract: { name: 'ownware.gateway', major: 1.5, revision: '0.45.0' },
        capabilities: [],
      },
      {
        contract: { name: 'ownware.gateway', major: 1, revision: '0.45.0' },
        capabilities: [{ id: 'runs.snapshot', version: 1.5 }],
      },
      {
        contract: { name: 'ownware.gateway', major: 1, revision: '0.45.0' },
        capabilities: [{ id: 'runs.snapshot', version: 0 }],
      },
    ]

    for (const body of malformed) {
      await expect(clientReturning(body).capabilities())
        .rejects.toMatchObject(invalidResponse('gateway_capabilities_invalid'))
    }
  })

  it('rejects malformed known limit shapes but ignores additions', async () => {
    const requiredLimits = {
      jsonBodyBytes: 1_000,
      delegationDefaultTtlSeconds: 60,
      delegationMaxTtlSeconds: 600,
      idempotencyRetentionSeconds: 600,
      rateLimit: {
        enabled: true,
        windowSeconds: 60,
        generalRequests: 100,
        runStarts: 10,
        futureRateLimit: 1,
      },
      futureLimits: { additive: true },
    }
    const document = {
      contract: { name: 'ownware.gateway', major: 1, revision: '0.45.0' },
      capabilities: [],
    }
    await expect(clientReturning({ ...document, limits: requiredLimits }).capabilities())
      .resolves.toMatchObject({ status: 'available', limits: requiredLimits })
    await expect(clientReturning({
      ...document,
      limits: { ...requiredLimits, rateLimit: { ...requiredLimits.rateLimit, enabled: 'yes' } },
    }).capabilities()).rejects.toMatchObject(invalidResponse('gateway_capabilities_invalid'))
  })
})

describe('runtime run and decision evidence validation', () => {
  it('accepts additive legacy/current run starts and rejects identity or egress drift', async () => {
    const input = {
      profileId: 'assistant',
      prompt: 'hello',
      threadId: 'thread_1',
      egressMode: 'local-only',
    } as const
    const valid = {
      runId: RUN_ID,
      threadId: 'thread_1',
      agentId: 'root',
      profileId: 'assistant',
      model: 'ollama:llama3.2',
      status: 'running',
      timeoutMs: 60_000,
      egressMode: 'local-only',
      futureRunField: true,
    } as const
    await expect(clientReturning(valid).run(input)).resolves.toMatchObject(valid)
    await expect(clientReturning({ ...valid, runId: 'not-a-run' }).run(input))
      .rejects.toMatchObject(invalidResponse('run_start_invalid'))
    await expect(clientReturning({ ...valid, profileId: 'other' }).run(input))
      .rejects.toMatchObject(invalidResponse('run_start_invalid'))
    await expect(clientReturning({ ...valid, egressMode: 'unrestricted' }).run(input))
      .rejects.toMatchObject(invalidResponse('run_start_invalid'))

    await expect(clientReturning({ threadId: 'legacy_thread', futureRunField: true }).run({
      profileId: 'assistant',
      prompt: 'hello',
    })).resolves.toMatchObject({ threadId: 'legacy_thread', futureRunField: true })
  })

  it('accepts additive run snapshot fields and rejects unknown semantic variants', async () => {
    await expect(clientReturning(snapshot).runSnapshot(RUN_ID)).resolves.toMatchObject({
      runId: RUN_ID,
      status: 'running',
      futureSnapshotField: { additive: true },
    })

    for (const malformed of [
      { ...snapshot, runId: OTHER_RUN_ID },
      { ...snapshot, status: 'paused' },
      { ...snapshot, consequence: 'safe' },
      { ...snapshot, egressMode: 'air-gapped' },
      { ...snapshot, endSeq: 1.5 },
    ]) {
      await expect(clientReturning(malformed).runSnapshot(RUN_ID))
        .rejects.toMatchObject(invalidResponse('run_snapshot_invalid'))
    }
  })

  it('binds permission decisions to the exact request, operation, and revision', async () => {
    const input = { decision: 'approve', operationHash: 'a'.repeat(64) } as const
    const valid = {
      runId: RUN_ID,
      requestId: REQUEST_ID,
      intentRevision: 1,
      ...input,
      futureDecisionField: true,
    }
    await expect(clientReturning(valid).decidePermission(RUN_ID, REQUEST_ID, input))
      .resolves.toMatchObject(valid)

    for (const malformed of [
      { ...valid, runId: OTHER_RUN_ID },
      { ...valid, requestId: 'permission_2' },
      { ...valid, operationHash: 'b'.repeat(64) },
      { ...valid, decision: 'allow' },
      { ...valid, intentRevision: 2 },
    ]) {
      await expect(clientReturning(malformed).decidePermission(RUN_ID, REQUEST_ID, input))
        .rejects.toMatchObject(invalidResponse('permission_decision_invalid'))
    }
  })

  it('binds sensitive-input and cancellation decisions to their exact run semantics', async () => {
    const provided = {
      runId: RUN_ID,
      requestId: 'sensitive_1',
      accepted: true,
      status: 'provided',
      futureDecisionField: true,
    } as const
    await expect(clientReturning(provided).submitSensitiveInput(RUN_ID, 'sensitive_1', 'secret'))
      .resolves.toMatchObject(provided)
    await expect(clientReturning({ ...provided, status: 'queued' })
      .submitSensitiveInput(RUN_ID, 'sensitive_1', 'secret'))
      .rejects.toMatchObject(invalidResponse('sensitive_input_decision_invalid'))

    const cancellation = {
      runId: RUN_ID,
      status: 'cancel_requested',
      consequence: 'effect_possible',
      terminal: false,
      outcomeKnown: true,
      cancellation: 'requested',
      futureCancellationField: true,
    } as const
    await expect(clientReturning(cancellation).cancel(RUN_ID)).resolves.toMatchObject(cancellation)
    await expect(clientReturning({ ...cancellation, cancellation: 'undone' }).cancel(RUN_ID))
      .rejects.toMatchObject(invalidResponse('run_cancellation_invalid'))
  })
})

describe('runtime receipt and reversal evidence validation', () => {
  it('accepts additive fields in every evidence page', async () => {
    const page = (item: unknown) => ({ items: [item], nextCursor: null, futurePageField: true })
    await expect(clientReturning(page(effectReceipt)).listEffectReceipts(RUN_ID))
      .resolves.toMatchObject(page(effectReceipt))
    await expect(clientReturning(page(egressReceipt)).listEgressReceipts(RUN_ID))
      .resolves.toMatchObject(page(egressReceipt))
    await expect(clientReturning(page(skillReceipt)).listSkillActivationReceipts(RUN_ID))
      .resolves.toMatchObject(page(skillReceipt))
    await expect(clientReturning(page(reversalOffer)).listEffectReversalOffers(RUN_ID))
      .resolves.toMatchObject(page(reversalOffer))
    await expect(clientReturning(page(reversalReceipt)).listEffectReversalReceipts(RUN_ID))
      .resolves.toMatchObject(page(reversalReceipt))
  })

  it('rejects unknown receipt enums across EE1, EE3, EE5, and EE6', async () => {
    const cases: ReadonlyArray<readonly [Promise<unknown>, string]> = [
      [
        clientReturning({ items: [{ ...effectReceipt, outcome: 'maybe' }], nextCursor: null })
          .listEffectReceipts(RUN_ID),
        'effect_receipt_page_invalid',
      ],
      [
        clientReturning({ items: [{ ...egressReceipt, phase: 'redirected' }], nextCursor: null })
          .listEgressReceipts(RUN_ID),
        'egress_receipt_page_invalid',
      ],
      [
        clientReturning({
          items: [{ ...skillReceipt, skillDigest: 'sha256:not-authoritative' }],
          nextCursor: null,
        }).listSkillActivationReceipts(RUN_ID),
        'skill_activation_receipt_page_invalid',
      ],
      [
        clientReturning({ items: [{ ...reversalOffer, status: 'queued' }], nextCursor: null })
          .listEffectReversalOffers(RUN_ID),
        'effect_reversal_offer_page_invalid',
      ],
      [
        clientReturning({ items: [{ ...reversalReceipt, actorKind: 'system' }], nextCursor: null })
          .listEffectReversalReceipts(RUN_ID),
        'effect_reversal_receipt_page_invalid',
      ],
    ]

    for (const [request, code] of cases) {
      await expect(request).rejects.toMatchObject(invalidResponse(code))
    }
  })

  it('rejects malformed pages, duplicates, out-of-order sequences, and cross-run items', async () => {
    const malformed = [
      { items: 'not-an-array', nextCursor: null },
      { items: [effectReceipt], nextCursor: 'not-a-cursor' },
      { items: [{ ...effectReceipt, runId: OTHER_RUN_ID }], nextCursor: null },
      {
        items: [effectReceipt, { ...effectReceipt, sequence: 2 }],
        nextCursor: null,
      },
      {
        items: [
          { ...effectReceipt, receiptId: '12121212-1212-4212-8212-121212121212', sequence: 2 },
          effectReceipt,
        ],
        nextCursor: null,
      },
    ]
    for (const page of malformed) {
      await expect(clientReturning(page).listEffectReceipts(RUN_ID))
        .rejects.toMatchObject(invalidResponse('effect_receipt_page_invalid'))
    }
  })

  it('validates the complete reversal execution correlation graph', async () => {
    const execution = {
      disposition: 'executed',
      offer: reversalOffer,
      receipt: reversalReceipt,
      futureExecutionField: true,
    } as const
    await expect(clientReturning(execution).executeEffectReversal(
      RUN_ID,
      OFFER_ID,
      { idempotencyKey: '89898989-8989-4989-8989-898989898989' },
    )).resolves.toMatchObject(execution)

    for (const malformed of [
      { ...execution, disposition: 'queued' },
      { ...execution, offer: { ...reversalOffer, offerId: '67676767-6767-4676-8676-676767676767' } },
      { ...execution, receipt: { ...reversalReceipt, effectId: '68686868-6868-4686-8686-686868686868' } },
      { ...execution, receipt: { ...reversalReceipt, outcome: 'stale' } },
    ]) {
      await expect(clientReturning(malformed).executeEffectReversal(
        RUN_ID,
        OFFER_ID,
        { idempotencyKey: '89898989-8989-4989-8989-898989898989' },
      )).rejects.toMatchObject(invalidResponse('effect_reversal_execution_invalid'))
    }
  })

  it('does not echo a malformed JSON body through validation errors', async () => {
    const canary = 'private-response-canary'
    const injectedFetch = (async () => new Response(`{${canary}`, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    const ownware = new OwnwareClient({ baseUrl: 'https://ownware.invalid', fetch: injectedFetch })
    const thrown = await ownware.runSnapshot(RUN_ID).catch((error: unknown) => error)
    expect(thrown).toMatchObject(invalidResponse('run_snapshot_invalid'))
    expect(String(thrown)).not.toContain(canary)
  })
})
