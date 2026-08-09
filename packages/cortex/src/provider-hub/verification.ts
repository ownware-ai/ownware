import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  CapabilityVerificationSchema,
  IsoDateTimeSchema,
  ProviderCatalogSnapshotSchema,
  StableIdSchema,
  type ModelRoute,
  type ProviderCapability,
  type ProviderCatalogSnapshot,
} from './schema.js'

export const PROVIDER_VERIFICATION_SCHEMA_VERSION = 1
export const PROVIDER_VERIFICATION_HARNESS_VERSION = 'provider-route-contract-v1'

export const VerificationProbeIdSchema = z.enum([
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
])

export const VerificationEventTypeSchema = z.enum([
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_use_args_delta',
  'tool_use_end',
  'message_complete',
  'stream_error',
])

export const VerificationTerminalOutcomeSchema = z.enum([
  'completed',
  'errored',
  'cancelled',
  'timed_out',
  'missing',
])

export const VerificationErrorCategorySchema = z.enum([
  'none',
  'authentication',
  'rate_limit',
  'context_window',
  'provider',
  'cancelled',
  'timeout',
])

export const VerificationAssertionIdSchema = z.enum([
  'stream_delta_seen',
  'completion_seen',
  'terminal_event_seen',
  'tool_start_seen',
  'tool_end_seen',
  'sequential_batches_seen',
  'parallel_batch_seen',
  'cancellation_requested',
  'cancellation_observed',
  'timeout_configured',
  'timeout_observed',
  'reasoning_requested',
  'reasoning_observed',
  'image_submitted',
  'pdf_submitted',
  'structured_schema_requested',
  'structured_output_valid',
  'cache_marker_submitted',
  'cache_usage_observed',
  'usage_tokens_observed',
  'reported_cost_observed',
  'authentication_error_observed',
  'rate_limit_error_observed',
  'context_window_error_observed',
])

export const VerificationSkipReasonSchema = z.enum([
  'not_selected',
  'unsupported_by_adapter',
  'unsafe_without_fixture',
  'missing_input_fixture',
  'inconclusive',
])

export const VerificationObservationSchema = z.object({
  eventTypes: z.array(VerificationEventTypeSchema).max(7),
  terminalOutcome: VerificationTerminalOutcomeSchema,
  toolCallBatches: z.array(z.number().int().min(0).max(1_000)).max(1_000),
  cancellationRequested: z.boolean(),
  timeoutConfigured: z.boolean(),
  request: z.object({
    reasoningOption: z.boolean(),
    inputKinds: z.array(z.enum(['text', 'image', 'pdf'])).max(3),
    structuredOutputSchema: z.boolean(),
    cacheMarkers: z.number().int().min(0).max(1_000),
  }).strict(),
  response: z.object({
    reasoningObserved: z.boolean(),
    structuredOutputValid: z.boolean(),
  }).strict(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().safe().optional(),
    outputTokens: z.number().int().nonnegative().safe().optional(),
    cacheReadTokens: z.number().int().nonnegative().safe().optional(),
    cacheWriteTokens: z.number().int().nonnegative().safe().optional(),
    reasoningTokens: z.number().int().nonnegative().safe().optional(),
    reportedCostUsd: z.number().finite().nonnegative().optional(),
  }).strict(),
  errorCategory: VerificationErrorCategorySchema,
}).strict().superRefine((observation, ctx) => {
  if (new Set(observation.eventTypes).size !== observation.eventTypes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eventTypes'],
      message: 'Normalized verification event types must be unique',
    })
  }
})

const VerificationAssertionSchema = z.object({
  id: VerificationAssertionIdSchema,
  passed: z.boolean(),
}).strict()

export const VerificationProbeResultSchema = z.discriminatedUnion('status', [
  z.object({
    probeId: VerificationProbeIdSchema,
    status: z.literal('passed'),
    observation: VerificationObservationSchema,
    assertions: z.array(VerificationAssertionSchema).min(1).max(20),
  }).strict(),
  z.object({
    probeId: VerificationProbeIdSchema,
    status: z.literal('failed'),
    observation: VerificationObservationSchema,
    assertions: z.array(VerificationAssertionSchema).min(1).max(20),
  }).strict(),
  z.object({
    probeId: VerificationProbeIdSchema,
    status: z.literal('skipped'),
    reason: VerificationSkipReasonSchema,
  }).strict(),
])

const VerificationEvidenceBaseSchema = z.object({
  schemaVersion: z.literal(PROVIDER_VERIFICATION_SCHEMA_VERSION),
  harnessVersion: z.string().trim().min(1).max(200),
  providerRouteId: StableIdSchema,
  modelRouteId: StableIdSchema,
  runtimeId: StableIdSchema,
  adapterId: StableIdSchema,
  protocol: z.enum([
    'anthropic_messages',
    'openai_chat_completions',
    'openai_responses',
    'google_generate_content',
    'codex_app_server',
    'local',
    'other',
  ]),
  mode: z.enum(['fixture', 'live']),
  observedAt: IsoDateTimeSchema,
  catalogGenerationId: StableIdSchema,
  results: z.array(VerificationProbeResultSchema).min(1).max(100),
}).strict()

const VerificationEvidenceContentSchema = VerificationEvidenceBaseSchema.superRefine((evidence, ctx) => {
  validateUniqueProbeResults(evidence, ctx)
})

export const VerificationEvidenceSchema = VerificationEvidenceBaseSchema.extend({
  evidenceId: StableIdSchema,
}).strict().superRefine((evidence, ctx) => {
  validateUniqueProbeResults(evidence, ctx)
  const { evidenceId: _evidenceId, ...content } = evidence
  if (evidenceIdFor(content) !== evidence.evidenceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidenceId'],
      message: 'Verification evidence content hash does not match evidenceId',
    })
  }
})

function validateUniqueProbeResults(
  evidence: { readonly results: readonly { readonly probeId: VerificationProbeId }[] },
  ctx: z.RefinementCtx,
): void {
  const ids = evidence.results.map(result => result.probeId)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['results'],
      message: 'A verification probe may appear only once per evidence record',
    })
  }
}

const VerificationEvidenceBundleBaseSchema = z.object({
  schemaVersion: z.literal(PROVIDER_VERIFICATION_SCHEMA_VERSION),
  harnessVersion: z.string().trim().min(1).max(200),
  mode: z.enum(['fixture', 'live']),
  createdAt: IsoDateTimeSchema,
  entries: z.array(VerificationEvidenceSchema).max(10_000),
}).strict()

const VerificationEvidenceBundleContentSchema = VerificationEvidenceBundleBaseSchema.superRefine((bundle, ctx) => {
  validateBundleEntries(bundle, ctx)
})

export const VerificationEvidenceBundleSchema = VerificationEvidenceBundleBaseSchema.extend({
  bundleId: StableIdSchema,
}).strict().superRefine((bundle, ctx) => {
  validateBundleEntries(bundle, ctx)
  const { bundleId: _bundleId, ...content } = bundle
  if (bundleIdFor(content) !== bundle.bundleId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['bundleId'],
      message: 'Verification bundle content hash does not match bundleId',
    })
  }
})

function validateBundleEntries(
  bundle: {
    readonly harnessVersion: string
    readonly mode: 'fixture' | 'live'
    readonly entries: readonly VerificationEvidence[]
  },
  ctx: z.RefinementCtx,
): void {
  const routeKeys = new Set<string>()
  for (const [index, entry] of bundle.entries.entries()) {
    if (entry.harnessVersion !== bundle.harnessVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'harnessVersion'],
        message: 'Evidence harnessVersion must match its bundle',
      })
    }
    if (entry.mode !== bundle.mode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index, 'mode'],
        message: 'Evidence mode must match its bundle',
      })
    }
    const routeKey = `${entry.providerRouteId}\u0000${entry.modelRouteId}`
    if (routeKeys.has(routeKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries', index],
        message: 'A provider/model route may appear only once per bundle',
      })
    }
    routeKeys.add(routeKey)
  }
}

export type VerificationProbeId = z.infer<typeof VerificationProbeIdSchema>
export type VerificationObservation = z.infer<typeof VerificationObservationSchema>
export type VerificationProbeResult = z.infer<typeof VerificationProbeResultSchema>
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>
export type VerificationEvidenceBundle = z.infer<typeof VerificationEvidenceBundleSchema>
export type VerificationEvidenceContent = z.infer<typeof VerificationEvidenceContentSchema>

export function evaluateVerificationProbe(
  probeId: VerificationProbeId,
  observation: VerificationObservation,
): VerificationProbeResult {
  const value = VerificationObservationSchema.parse(observation)
  const hasEvent = (event: z.infer<typeof VerificationEventTypeSchema>) => value.eventTypes.includes(event)
  const assertions: Array<z.infer<typeof VerificationAssertionSchema>> = []
  const assert = (id: z.infer<typeof VerificationAssertionIdSchema>, passed: boolean) => {
    assertions.push({ id, passed })
  }

  switch (probeId) {
    case 'text_streaming':
      assert('stream_delta_seen', hasEvent('text_delta'))
      assert('completion_seen', hasEvent('message_complete') && value.terminalOutcome === 'completed')
      break
    case 'terminal_events':
      assert('terminal_event_seen', terminalEventCount(value) === 1)
      break
    case 'sequential_tool_calls':
      assert('tool_start_seen', hasEvent('tool_use_start'))
      assert('tool_end_seen', hasEvent('tool_use_end'))
      assert('sequential_batches_seen', value.toolCallBatches.length >= 2 && value.toolCallBatches.every(size => size === 1))
      break
    case 'parallel_tool_calls':
      assert('tool_start_seen', hasEvent('tool_use_start'))
      assert('tool_end_seen', hasEvent('tool_use_end'))
      assert('parallel_batch_seen', value.toolCallBatches.some(size => size >= 2))
      break
    case 'cancellation':
      assert('cancellation_requested', value.cancellationRequested)
      assert('cancellation_observed', value.terminalOutcome === 'cancelled' && value.errorCategory === 'cancelled')
      break
    case 'timeout':
      assert('timeout_configured', value.timeoutConfigured)
      assert('timeout_observed', value.terminalOutcome === 'timed_out' && value.errorCategory === 'timeout')
      break
    case 'reasoning':
      assert('reasoning_requested', value.request.reasoningOption)
      assert('reasoning_observed', value.response.reasoningObserved)
      break
    case 'image_input':
      assert('image_submitted', value.request.inputKinds.includes('image'))
      assert('completion_seen', value.terminalOutcome === 'completed' && hasEvent('message_complete'))
      break
    case 'pdf_input':
      assert('pdf_submitted', value.request.inputKinds.includes('pdf'))
      assert('completion_seen', value.terminalOutcome === 'completed' && hasEvent('message_complete'))
      break
    case 'structured_output':
      assert('structured_schema_requested', value.request.structuredOutputSchema)
      assert('structured_output_valid', value.response.structuredOutputValid)
      break
    case 'prompt_caching':
      assert('cache_marker_submitted', value.request.cacheMarkers > 0)
      assert('cache_usage_observed', (value.usage.cacheReadTokens ?? 0) > 0 || (value.usage.cacheWriteTokens ?? 0) > 0)
      break
    case 'usage_reporting':
      assert('usage_tokens_observed', value.usage.inputTokens != null && value.usage.outputTokens != null && value.usage.inputTokens + value.usage.outputTokens > 0)
      break
    case 'provider_reported_cost':
      assert('reported_cost_observed', value.usage.reportedCostUsd != null)
      break
    case 'auth_error':
      assert('authentication_error_observed', value.terminalOutcome === 'errored' && value.errorCategory === 'authentication')
      break
    case 'rate_limit_error':
      assert('rate_limit_error_observed', value.terminalOutcome === 'errored' && value.errorCategory === 'rate_limit')
      break
    case 'context_window_error':
      assert('context_window_error_observed', value.terminalOutcome === 'errored' && value.errorCategory === 'context_window')
      break
  }
  return VerificationProbeResultSchema.parse({
    probeId,
    status: assertions.every(assertion => assertion.passed) ? 'passed' : 'failed',
    observation: value,
    assertions,
  })
}

export function skippedVerificationProbe(
  probeId: VerificationProbeId,
  reason: z.infer<typeof VerificationSkipReasonSchema>,
): VerificationProbeResult {
  return VerificationProbeResultSchema.parse({ probeId, status: 'skipped', reason })
}

export function createVerificationEvidence(
  content: VerificationEvidenceContent,
): VerificationEvidence {
  const parsed = VerificationEvidenceContentSchema.parse(content)
  return VerificationEvidenceSchema.parse({
    ...parsed,
    evidenceId: evidenceIdFor(parsed),
  })
}

export function createVerificationEvidenceBundle(input: {
  readonly harnessVersion: string
  readonly mode: 'fixture' | 'live'
  readonly createdAt: string
  readonly entries: readonly VerificationEvidence[]
}): VerificationEvidenceBundle {
  const content = VerificationEvidenceBundleContentSchema.parse({
    schemaVersion: PROVIDER_VERIFICATION_SCHEMA_VERSION,
    ...input,
  })
  return VerificationEvidenceBundleSchema.parse({
    ...content,
    bundleId: bundleIdFor(content),
  })
}

export function parseVerificationEvidenceBundleText(text: string): VerificationEvidenceBundle {
  return VerificationEvidenceBundleSchema.parse(JSON.parse(text) as unknown)
}

export function verificationEvidenceBundleText(bundle: VerificationEvidenceBundle): string {
  return `${JSON.stringify(VerificationEvidenceBundleSchema.parse(bundle), null, 2)}\n`
}

export interface VerificationApplicationResult {
  readonly catalog: ProviderCatalogSnapshot
  readonly warnings: readonly string[]
  readonly appliedEvidenceIds: readonly string[]
}

export function applyVerificationEvidenceBundle(
  catalogInput: ProviderCatalogSnapshot,
  bundleInput: VerificationEvidenceBundle,
): VerificationApplicationResult {
  const catalog = ProviderCatalogSnapshotSchema.parse(catalogInput)
  const bundle = VerificationEvidenceBundleSchema.parse(bundleInput)
  const warnings: string[] = []
  const appliedEvidenceIds: string[] = []
  const evidenceByModel = new Map(bundle.entries.map(entry => [entry.modelRouteId, entry]))
  const routeById = new Map(catalog.routes.map(route => [route.id, route]))
  const unusableEvidenceIds = new Set<string>()
  for (const evidence of bundle.entries) {
    const route = routeById.get(evidence.providerRouteId)
    if (route == null) {
      warnings.push(`Verification evidence ${evidence.evidenceId} names an unknown provider route; ignored`)
      unusableEvidenceIds.add(evidence.evidenceId)
    } else if (!catalog.models.some(model => model.id === evidence.modelRouteId)) {
      warnings.push(`Verification evidence ${evidence.evidenceId} names an unknown model route; ignored`)
      unusableEvidenceIds.add(evidence.evidenceId)
    } else if (!evidenceMatchesRouteTransport(evidence, route.transport)) {
      warnings.push(`Verification evidence ${evidence.evidenceId} does not match the provider route transport; ignored`)
      unusableEvidenceIds.add(evidence.evidenceId)
    }
  }

  const models = catalog.models.map(model => {
    const evidence = evidenceByModel.get(model.id)
    if (evidence == null) return model
    if (unusableEvidenceIds.has(evidence.evidenceId)) return model
    if (evidence.providerRouteId !== model.providerRouteId) {
      warnings.push(`Verification evidence ${evidence.evidenceId} does not match model route ${model.id}; ignored`)
      return model
    }
    if (evidence.catalogGenerationId !== catalog.generation.id) {
      warnings.push(`Verification evidence ${evidence.evidenceId} targets a different catalog generation; ignored`)
      return model
    }
    appliedEvidenceIds.push(evidence.evidenceId)
    return applyModelEvidence(model, evidence)
  })

  return {
    catalog: ProviderCatalogSnapshotSchema.parse({ ...catalog, models }),
    warnings,
    appliedEvidenceIds,
  }
}

function evidenceMatchesRouteTransport(
  evidence: VerificationEvidence,
  transport: ProviderCatalogSnapshot['routes'][number]['transport'],
): boolean {
  if (evidence.runtimeId !== transport.runtimeId) return false
  if (transport.adapterId == null || evidence.adapterId !== transport.adapterId) return false
  return catalogProtocolsFor(evidence.protocol).has(transport.protocol)
}

function catalogProtocolsFor(protocol: VerificationEvidence['protocol']): ReadonlySet<string> {
  switch (protocol) {
    case 'anthropic_messages':
      return new Set(['anthropic_messages', 'anthropic-messages'])
    case 'openai_chat_completions':
      return new Set([
        'openai_chat_completions',
        'openai-chat-completions',
        'openai-compatible',
        'openrouter',
        'ollama-openai-compatible',
      ])
    case 'openai_responses':
      return new Set(['openai_responses', 'openai-responses'])
    case 'google_generate_content':
      return new Set(['google_generate_content', 'google-generate-content'])
    case 'codex_app_server':
      return new Set(['codex_app_server', 'codex-app-server'])
    case 'local':
      return new Set(['local'])
    case 'other':
      return new Set(['other'])
  }
}

function applyModelEvidence(model: ModelRoute, evidence: VerificationEvidence): ModelRoute {
  const resultByProbe = new Map(evidence.results.map(result => [result.probeId, result]))
  const capabilities = model.capabilities.map(capability => {
    if (capability.upstream.status === 'unsupported') {
      return { ...capability, ownware: { status: 'not_applicable' as const } }
    }
    const required = CAPABILITY_PROBES[capability.capability]
    if (required.length === 0) return capability
    const results = required.map(probe => resultByProbe.get(probe))
    const hasFailed = results.some(result => result?.status === 'failed')
    const allPassed = results.every(result => result?.status === 'passed')
    const status = hasFailed ? 'failed' : allPassed ? 'verified' : 'untested'
    const ownware: z.infer<typeof CapabilityVerificationSchema> = status === 'untested'
      ? { status, note: 'Required verification probes were missing or skipped.' }
      : {
          status,
          evidenceId: evidence.evidenceId,
          harnessVersion: evidence.harnessVersion,
          observedAt: evidence.observedAt,
          mode: evidence.mode,
        }
    return { ...capability, ownware }
  })
  const supported = capabilities.filter(capability => capability.upstream.status === 'supported')
  const streaming = capabilities.find(capability => capability.capability === 'text_streaming')
  const liveVerified = evidence.mode === 'live'
    && streaming?.ownware.status === 'verified'
    && supported.length > 0
    && supported.every(capability => capability.ownware.status === 'verified')
  return {
    ...model,
    capabilities,
    availability: {
      ...model.availability,
      verified: liveVerified,
      ...(!liveVerified && model.availability.verified
        ? { reason: 'The active verification evidence does not prove every supported route capability.' }
        : {}),
    },
  }
}

const CAPABILITY_PROBES: Readonly<Record<ProviderCapability, readonly VerificationProbeId[]>> = {
  text_streaming: ['text_streaming'],
  terminal_events: ['terminal_events'],
  error_semantics: ['auth_error', 'rate_limit_error', 'context_window_error'],
  tool_calls: ['sequential_tool_calls'],
  parallel_tool_calls: ['parallel_tool_calls'],
  cancellation: ['cancellation', 'timeout'],
  reasoning: ['reasoning'],
  image_input: ['image_input'],
  pdf_input: ['pdf_input'],
  audio_input: [],
  video_input: [],
  structured_output: ['structured_output'],
  prompt_caching: ['prompt_caching'],
  usage_reporting: ['usage_reporting'],
  provider_reported_cost: ['provider_reported_cost'],
}

function terminalEventCount(observation: VerificationObservation): number {
  const normalizedTerminalEvents = observation.eventTypes.filter(event =>
    event === 'message_complete' || event === 'stream_error',
  ).length
  const externalTerminal = observation.terminalOutcome === 'cancelled'
    || observation.terminalOutcome === 'timed_out'
  return normalizedTerminalEvents + Number(externalTerminal)
}

function evidenceIdFor(content: object): string {
  return `evidence:${sha256(JSON.stringify(content))}`
}

function bundleIdFor(content: object): string {
  return `verification:${sha256(JSON.stringify(content))}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
