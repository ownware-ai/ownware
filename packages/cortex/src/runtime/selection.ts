import { z } from 'zod'

const ProviderApiAccessSchema = z.object({
  route: z.literal('provider-api'),
}).strict()

const DirectChatGptAccessSchema = z.object({
  route: z.literal('openai-chatgpt-direct'),
  /**
   * Direct transport is not a documented provider integration contract.
   * Requiring a literal prevents an old/default configuration from drifting
   * into it merely because a new route value became parseable.
   */
  experimentalOptIn: z.literal(true),
  /**
   * Names the exact behavioral envelope the person accepted. A later
   * incompatible envelope is a new explicit decision, never a silent upgrade.
   */
  capabilityEnvelope: z.literal('openai-chatgpt-direct.v1'),
}).strict()

const ManagedChatGptAccessSchema = z.object({
  route: z.literal('openai-chatgpt-managed'),
}).strict()

/**
 * A runtime selection is deliberately a union of valid runtime/access pairs.
 *
 * The direct ChatGPT route is model access for Ownware's existing loop. The
 * managed ChatGPT route belongs to the external Codex loop. Encoding those
 * pairs in the schema prevents a caller from accidentally describing one as
 * the other.
 */
export const RuntimeSelectionSchema = z.discriminatedUnion('runtime', [
  z.object({
    runtime: z.literal('ownware'),
    access: z.union([
      ProviderApiAccessSchema,
      DirectChatGptAccessSchema,
    ]),
  }).strict(),
  z.object({
    runtime: z.literal('openai-codex'),
    access: ManagedChatGptAccessSchema,
  }).strict(),
])

export type RuntimeSelection = z.infer<typeof RuntimeSelectionSchema>

export const CapabilityProvenanceSchema = z.object({
  authority: z.enum([
    'ownware-contract',
    'provider-documentation',
    'provider-observation',
    'runtime-observation',
    'operator-configuration',
  ]),
  source: z.string().trim().min(1).max(512),
  observedAt: z.string().datetime(),
  /**
   * `null` means the authority supplied no defensible freshness window.
   * Consumers must display that as unknown rather than treating it as fresh.
   */
  validUntil: z.string().datetime().nullable(),
}).strict().superRefine((value, ctx) => {
  if (
    value.validUntil !== null &&
    Date.parse(value.validUntil) <= Date.parse(value.observedAt)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'validUntil must be later than observedAt',
    })
  }
})

export const CapabilityAssessmentSchema = z.object({
  /** Open-world capability key; adding one does not require a core enum edit. */
  capability: z.string().trim().min(1).max(128),
  status: z.enum(['supported', 'unsupported', 'unknown']),
  detail: z.string().trim().min(1).max(1_024),
  provenance: CapabilityProvenanceSchema,
}).strict()

export type CapabilityAssessment = z.infer<typeof CapabilityAssessmentSchema>

export const RuntimePlanSchema = z.object({
  schemaVersion: z.literal(1),
  selection: RuntimeSelectionSchema,
  support: z.enum(['supported', 'experimental']),
  plannedAt: z.string().datetime(),
  capabilities: z.array(CapabilityAssessmentSchema),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>()
  for (const [index, item] of value.capabilities.entries()) {
    if (seen.has(item.capability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'capability'],
        message: `duplicate capability "${item.capability}"`,
      })
    }
    seen.add(item.capability)
  }
})

export type RuntimePlan = z.infer<typeof RuntimePlanSchema>
export type CapabilityFreshness = 'current' | 'stale' | 'unknown'

const ThreadRuntimeBindingInputSchema = z.object({
  threadId: z.string().trim().min(1).max(256),
  selection: RuntimeSelectionSchema,
  boundAt: z.string().datetime(),
  migratedFromThreadId: z.string().trim().min(1).max(256).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.migratedFromThreadId === value.threadId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['migratedFromThreadId'],
      message: 'a runtime migration must create a different thread',
    })
  }
})

export const ThreadRuntimeBindingSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string().trim().min(1).max(256),
  selection: RuntimeSelectionSchema,
  boundAt: z.string().datetime(),
  migratedFromThreadId: z.string().trim().min(1).max(256).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.migratedFromThreadId === value.threadId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['migratedFromThreadId'],
      message: 'a runtime migration must create a different thread',
    })
  }
})

export type ThreadRuntimeBinding = z.infer<typeof ThreadRuntimeBindingSchema>

export class RuntimeBindingConflictError extends Error {
  public override readonly name = 'RuntimeBindingConflictError'
  public readonly threadId: string
  public readonly current: RuntimeSelection
  public readonly requested: RuntimeSelection

  constructor(
    threadId: string,
    current: RuntimeSelection,
    requested: RuntimeSelection,
  ) {
    super(
      `Thread "${threadId}" is already bound to runtime "${current.runtime}" ` +
      `with access route "${current.access.route}". Create an explicit migrated ` +
      `thread to use runtime "${requested.runtime}" with route ` +
      `"${requested.access.route}".`,
    )
    this.threadId = threadId
    this.current = current
    this.requested = requested
  }
}

const DEFAULT_RUNTIME_SELECTION: RuntimeSelection = {
  runtime: 'ownware',
  access: { route: 'provider-api' },
}

/**
 * Resolve an optional runtime selection.
 *
 * An absent selection is the legacy configuration and therefore keeps the
 * existing Ownware execution path. Explicit selections are added only when
 * their runtime/access combination is implemented and validated.
 */
export function resolveRuntimeSelection(
  input?: unknown,
): RuntimeSelection {
  return RuntimeSelectionSchema.parse(input ?? DEFAULT_RUNTIME_SELECTION)
}

/**
 * Build an inspectable plan without starting a model or external process.
 *
 * Support status is derived from the mechanism. It is not caller-controlled:
 * schema version 1 classifies direct ChatGPT transport as experimental.
 */
export function createRuntimePlan(
  input: unknown,
  capabilities: readonly unknown[],
  plannedAt: string,
): RuntimePlan {
  const selection = resolveRuntimeSelection(input)
  const support = selection.access.route === 'openai-chatgpt-direct'
    ? 'experimental'
    : 'supported'

  return RuntimePlanSchema.parse({
    schemaVersion: 1,
    selection,
    support,
    plannedAt,
    capabilities,
  })
}

export function capabilityFreshness(
  assessment: CapabilityAssessment,
  at: string,
): CapabilityFreshness {
  const parsed = CapabilityAssessmentSchema.parse(assessment)
  const now = z.string().datetime().parse(at)
  const validUntil = parsed.provenance.validUntil
  if (validUntil === null) return 'unknown'
  return Date.parse(now) < Date.parse(validUntil) ? 'current' : 'stale'
}

/**
 * Bind a thread to one execution mechanism.
 *
 * Repeating the same request is idempotent. Changing the mechanism for an
 * existing thread is forbidden because output or effects may already belong
 * to the original loop. A deliberate migration is represented by creating a
 * new binding whose `migratedFromThreadId` names the source thread.
 */
export function bindThreadRuntime(
  existing: unknown | undefined,
  request: unknown,
): ThreadRuntimeBinding {
  const input = ThreadRuntimeBindingInputSchema.parse(request)
  const requested = ThreadRuntimeBindingSchema.parse({
    schemaVersion: 1,
    ...input,
  })

  if (existing === undefined) return requested

  const current = ThreadRuntimeBindingSchema.parse(existing)
  const sameThread = current.threadId === requested.threadId
  const sameSelection =
    current.selection.runtime === requested.selection.runtime &&
    current.selection.access.route === requested.selection.access.route
  const sameMigration =
    current.migratedFromThreadId === requested.migratedFromThreadId

  if (sameThread && sameSelection && sameMigration) {
    return existing as ThreadRuntimeBinding
  }

  throw new RuntimeBindingConflictError(
    requested.threadId,
    current.selection,
    requested.selection,
  )
}
