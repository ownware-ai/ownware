import {
  AuthenticationError,
  ContextWindowExceededError,
  RateLimitError,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
} from '@ownware/loom'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROVIDER_VERIFICATION_HARNESS_VERSION,
  VerificationEvidenceBundleSchema,
  VerificationEvidenceStore,
  VerificationObservationSchema,
  applyVerificationEvidenceBundle,
  createVerificationEvidence,
  createVerificationEvidenceBundle,
  evaluateVerificationProbe,
  parseVerificationEvidenceBundleText,
  runProviderRouteVerification,
  verificationEvidenceBundleText,
  type ProviderCatalogSnapshot,
  type VerificationEvidence,
  type VerificationObservation,
  type VerificationProbeId,
} from '../../../src/provider-hub/index.js'

const NOW = '2026-08-09T01:00:00.000Z'
const CATALOG_ID = 'catalog:test-generation'

describe('provider route verification harness', () => {
  it('runs the full adapter contract without retaining response content or raw errors', async () => {
    const probes = [
      'text_streaming',
      'terminal_events',
      'sequential_tool_calls',
      'parallel_tool_calls',
      'cancellation',
      'timeout',
      'reasoning',
      'image_input',
      'pdf_input',
      'structured_output',
      'prompt_caching',
      'usage_reporting',
      'provider_reported_cost',
      'auth_error',
      'rate_limit_error',
      'context_window_error',
    ] satisfies VerificationProbeId[]
    const results = await runProviderRouteVerification({
      adapter: fixtureAdapter(),
      model: 'fixture-model',
      probes,
      abortAfterMs: 1,
      media: {
        image: { mediaType: 'image/png', data: 'fixture-image' },
        pdf: { data: 'fixture-pdf' },
      },
      errorDrivers: {
        auth_error: async () => { throw new AuthenticationError('secret raw error', 'fixture') },
        rate_limit_error: async () => { throw new RateLimitError('secret raw error', 'fixture') },
        context_window_error: async () => { throw new ContextWindowExceededError('secret raw error', 'fixture') },
      },
    })

    expect(results).toHaveLength(probes.length)
    expect(results.find(result => result.probeId === 'structured_output')).toEqual({
      probeId: 'structured_output',
      status: 'skipped',
      reason: 'unsupported_by_adapter',
    })
    expect(results.filter(result => result.probeId !== 'structured_output').map(result => result.status))
      .toEqual(Array.from({ length: probes.length - 1 }, () => 'passed'))
    expect(JSON.stringify(results)).not.toContain('secret raw error')
    expect(JSON.stringify(results)).not.toContain('fixture-image')
    expect(JSON.stringify(results)).not.toContain('fixture-pdf')
  })

  it('evaluates every Slice 9 contract probe from normalized, content-free observations', () => {
    const cases: Array<[VerificationProbeId, VerificationObservation]> = [
      ['text_streaming', observation()],
      ['terminal_events', observation()],
      ['sequential_tool_calls', observation({
        eventTypes: ['tool_use_start', 'tool_use_end', 'message_complete'],
        toolCallBatches: [1, 1],
      })],
      ['parallel_tool_calls', observation({
        eventTypes: ['tool_use_start', 'tool_use_end', 'message_complete'],
        toolCallBatches: [2],
      })],
      ['cancellation', observation({
        eventTypes: [],
        terminalOutcome: 'cancelled',
        cancellationRequested: true,
        errorCategory: 'cancelled',
      })],
      ['timeout', observation({
        eventTypes: [],
        terminalOutcome: 'timed_out',
        timeoutConfigured: true,
        errorCategory: 'timeout',
      })],
      ['reasoning', observation({
        eventTypes: ['thinking_delta', 'message_complete'],
        request: { reasoningOption: true },
        response: { reasoningObserved: true },
      })],
      ['image_input', observation({ request: { inputKinds: ['text', 'image'] } })],
      ['pdf_input', observation({ request: { inputKinds: ['text', 'pdf'] } })],
      ['structured_output', observation({
        request: { structuredOutputSchema: true },
        response: { structuredOutputValid: true },
      })],
      ['prompt_caching', observation({
        request: { cacheMarkers: 1 },
        usage: { cacheReadTokens: 32 },
      })],
      ['usage_reporting', observation()],
      ['provider_reported_cost', observation({ usage: { reportedCostUsd: 0 } })],
      ['auth_error', observation({
        eventTypes: ['stream_error'],
        terminalOutcome: 'errored',
        errorCategory: 'authentication',
      })],
      ['rate_limit_error', observation({
        eventTypes: ['stream_error'],
        terminalOutcome: 'errored',
        errorCategory: 'rate_limit',
      })],
      ['context_window_error', observation({
        eventTypes: ['stream_error'],
        terminalOutcome: 'errored',
        errorCategory: 'context_window',
      })],
    ]

    expect(cases.map(([probeId, value]) => evaluateVerificationProbe(probeId, value).status))
      .toEqual(Array.from({ length: cases.length }, () => 'passed'))
    expect(evaluateVerificationProbe('parallel_tool_calls', observation({ toolCallBatches: [1, 1] })))
      .toMatchObject({ status: 'failed' })

    expect(VerificationObservationSchema.safeParse({
      ...observation(),
      prompt: 'must never be persisted',
    }).success).toBe(false)
    expect(VerificationObservationSchema.safeParse({
      ...observation(),
      rawError: 'Bearer secret-value',
    }).success).toBe(false)
  })

  it('content-addresses evidence and rejects tampered records and bundles', () => {
    const entry = evidence('fixture')
    const bundle = createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'fixture',
      createdAt: NOW,
      entries: [entry],
    })
    expect(parseVerificationEvidenceBundleText(verificationEvidenceBundleText(bundle))).toEqual(bundle)

    const tamperedEntry = {
      ...entry,
      runtimeId: 'different-runtime',
    }
    expect(() => VerificationEvidenceBundleSchema.parse({
      ...bundle,
      entries: [tamperedEntry],
    })).toThrow(/content hash/i)

    expect(() => parseVerificationEvidenceBundleText(JSON.stringify({
      ...bundle,
      createdAt: '2026-08-09T02:00:00.000Z',
    }))).toThrow(/content hash/i)
  })

  it('applies exact evidence while reserving route verification for complete live proof', () => {
    const fixtureBundle = createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'fixture',
      createdAt: NOW,
      entries: [evidence('fixture')],
    })
    const fixtureResult = applyVerificationEvidenceBundle(catalog(), fixtureBundle)
    const fixtureModel = fixtureResult.catalog.models[0]!
    expect(fixtureModel.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: 'text_streaming',
        ownware: expect.objectContaining({ status: 'verified', mode: 'fixture' }),
      }),
      expect.objectContaining({ capability: 'image_input', ownware: { status: 'not_applicable' } }),
    ]))
    expect(fixtureModel.availability.verified).toBe(false)

    const liveBundle = createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'live',
      createdAt: NOW,
      entries: [evidence('live')],
    })
    expect(applyVerificationEvidenceBundle(catalog(), liveBundle).catalog.models[0]?.availability.verified)
      .toBe(true)

    const staleEntry = createVerificationEvidence({
      ...evidenceContent('live'),
      catalogGenerationId: 'catalog:older-generation',
    })
    const stale = applyVerificationEvidenceBundle(catalog(), createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'live',
      createdAt: NOW,
      entries: [staleEntry],
    }))
    expect(stale.catalog.models[0]?.availability.verified).toBe(false)
    expect(stale.warnings).toEqual([expect.stringContaining('different catalog generation')])
  })

  it('does not apply evidence from a different runtime adapter or wire protocol', () => {
    const mismatchedAdapter = createVerificationEvidence({
      ...evidenceContent('live'),
      adapterId: 'different-adapter',
    })
    const adapterResult = applyVerificationEvidenceBundle(catalog(), createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'live',
      createdAt: NOW,
      entries: [mismatchedAdapter],
    }))
    expect(adapterResult.appliedEvidenceIds).toEqual([])
    expect(adapterResult.catalog.models[0]?.availability.verified).toBe(false)
    expect(adapterResult.warnings).toEqual([expect.stringContaining('does not match the provider route transport')])

    const mismatchedProtocol = createVerificationEvidence({
      ...evidenceContent('live'),
      protocol: 'openai_chat_completions',
    })
    const protocolResult = applyVerificationEvidenceBundle(catalog(), createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'live',
      createdAt: NOW,
      entries: [mismatchedProtocol],
    }))
    expect(protocolResult.appliedEvidenceIds).toEqual([])
    expect(protocolResult.catalog.models[0]?.availability.verified).toBe(false)
    expect(protocolResult.warnings).toEqual([expect.stringContaining('does not match the provider route transport')])
  })

  it('keeps the active last-known-good bundle when a replacement is invalid', async () => {
    const writes: string[] = []
    const store = new VerificationEvidenceStore('/unused/verification.json', async (_path, text) => {
      writes.push(text)
    })
    const active = createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'fixture',
      createdAt: NOW,
      entries: [evidence('fixture')],
    })
    await expect(store.replace(active)).resolves.toEqual(active)
    await expect(store.replace({ ...active, createdAt: '2026-08-09T03:00:00.000Z' })).rejects.toThrow()
    expect(writes).toHaveLength(1)
    await expect(store.load()).resolves.toEqual({ bundle: active, status: 'active' })
  })

  it('atomically persists a private evidence file that a fresh store validates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ownware-verification-'))
    const path = join(directory, 'verification-evidence.json')
    const bundle = createVerificationEvidenceBundle({
      harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
      mode: 'fixture',
      createdAt: NOW,
      entries: [evidence('fixture')],
    })

    await new VerificationEvidenceStore(path).replace(bundle)

    await expect(new VerificationEvidenceStore(path).load()).resolves.toEqual({
      bundle,
      status: 'active',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})

function evidence(mode: 'fixture' | 'live'): VerificationEvidence {
  return createVerificationEvidence(evidenceContent(mode))
}

function evidenceContent(mode: 'fixture' | 'live') {
  return {
    schemaVersion: 1 as const,
    harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
    providerRouteId: 'route:test',
    modelRouteId: 'test:model',
    runtimeId: 'loom',
    adapterId: 'fixture',
    protocol: 'other' as const,
    mode,
    observedAt: NOW,
    catalogGenerationId: CATALOG_ID,
    results: [
      evaluateVerificationProbe('text_streaming', observation()),
      evaluateVerificationProbe('sequential_tool_calls', observation({
        eventTypes: ['tool_use_start', 'tool_use_end', 'message_complete'],
        toolCallBatches: [1, 1],
      })),
    ],
  }
}

function observation(overrides: {
  readonly eventTypes?: VerificationObservation['eventTypes']
  readonly terminalOutcome?: VerificationObservation['terminalOutcome']
  readonly toolCallBatches?: VerificationObservation['toolCallBatches']
  readonly cancellationRequested?: boolean
  readonly timeoutConfigured?: boolean
  readonly request?: Partial<VerificationObservation['request']>
  readonly response?: Partial<VerificationObservation['response']>
  readonly usage?: Partial<VerificationObservation['usage']>
  readonly errorCategory?: VerificationObservation['errorCategory']
} = {}): VerificationObservation {
  return VerificationObservationSchema.parse({
    eventTypes: overrides.eventTypes ?? ['text_delta', 'message_complete'],
    terminalOutcome: overrides.terminalOutcome ?? 'completed',
    toolCallBatches: overrides.toolCallBatches ?? [],
    cancellationRequested: overrides.cancellationRequested ?? false,
    timeoutConfigured: overrides.timeoutConfigured ?? false,
    request: {
      reasoningOption: false,
      inputKinds: ['text'],
      structuredOutputSchema: false,
      cacheMarkers: 0,
      ...overrides.request,
    },
    response: {
      reasoningObserved: false,
      structuredOutputValid: false,
      ...overrides.response,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      ...overrides.usage,
    },
    errorCategory: overrides.errorCategory ?? 'none',
  })
}

function catalog(): ProviderCatalogSnapshot {
  return {
    schemaVersion: 1,
    generation: {
      id: CATALOG_ID,
      schemaVersion: 1,
      source: 'bundled',
      generatedAt: NOW,
      sha256: 'a'.repeat(64),
    },
    families: [{ id: 'test', name: 'Test', lifecycle: 'active' }],
    routes: [{
      id: 'route:test',
      familyId: 'test',
      name: 'Test route',
      kind: 'direct',
      transport: { runtimeId: 'loom', adapterId: 'fixture', protocol: 'other' },
      connectable: true,
      lifecycle: 'active',
    }],
    models: [{
      id: 'test:model',
      providerRouteId: 'route:test',
      wireModelId: 'model',
      name: 'Test model',
      aliases: [],
      contextWindow: 16_000,
      maxInputTokens: null,
      maxOutputTokens: 2_000,
      capabilities: [
        {
          capability: 'text_streaming',
          upstream: { status: 'unknown' },
          ownware: { status: 'untested' },
        },
        {
          capability: 'tool_calls',
          upstream: { status: 'supported', source: 'provider' },
          ownware: { status: 'untested' },
        },
        {
          capability: 'image_input',
          upstream: { status: 'unsupported', source: 'provider' },
          ownware: { status: 'untested' },
        },
      ],
      variants: [],
      availability: {
        catalogued: true,
        connectable: true,
        credentialed: true,
        verified: false,
        recommended: false,
        lifecycle: 'active',
        connectionIds: ['connection:test'],
      },
      billingKind: 'metered',
      catalogSourceRef: 'fixture',
    }],
    prices: [],
  }
}

function fixtureAdapter(): ProviderAdapter {
  return {
    name: 'fixture',
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      if (request.signal != null) {
        if (!request.signal.aborted) {
          await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }))
        }
        throw new Error('fixture aborted')
      }
      if (request.thinking?.enabled === true) yield { type: 'thinking_delta', text: 'private reasoning' }
      const toolNames = request.tools.map(tool => tool.name)
      const toolBlocks = toolNames.map((name, index) => ({
        type: 'tool_use' as const,
        id: `tool-${index}`,
        name,
        input: {},
      }))
      for (const block of toolBlocks) {
        yield { type: 'tool_use_start', id: block.id, name: block.name }
        yield { type: 'tool_use_end', id: block.id }
      }
      if (toolBlocks.length === 0) yield { type: 'text_delta', text: 'private response' }
      yield {
        type: 'message_complete',
        content: toolBlocks.length > 0 ? toolBlocks : [{ type: 'text', text: 'private response' }],
        stopReason: toolBlocks.length > 0 ? 'tool_use' : 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: Array.isArray(request.system) ? 5 : 0,
          cacheCreationTokens: Array.isArray(request.system) ? 10 : 0,
          ...(request.thinking?.enabled === true ? { reasoningTokens: 1 } : {}),
          reportedCostUsd: 0.001,
        },
      }
    },
    async countTokens() { return 1 },
    supportsFeature() { return true },
    formatTools(tools) { return tools },
    getModelPricing() { return null },
  }
}
