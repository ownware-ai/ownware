/**
 * `ownware provider verify` — explicit live verification of one provider route.
 *
 * Every input is supplied through dedicated environment variables so a
 * credential can never be copied into shell history as an argument. The
 * command persists only normalized, content-free verification evidence and
 * prints only stable ids, probe statuses, and skip reasons.
 */

import { readFile } from 'node:fs/promises'
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  type ProviderAdapter,
  type ProviderRequest,
} from '@ownware/loom'
import {
  PROVIDER_VERIFICATION_HARNESS_VERSION,
  VerificationEvidenceStore,
  VerificationProbeIdSchema,
  createVerificationEvidence,
  createVerificationEvidenceBundle,
  runProviderRouteVerification,
  type VerificationEvidenceStoreState,
  type VerificationMediaFixtures,
  type VerificationProbeId,
  type VerificationProbeResult,
} from '../provider-hub/index.js'

const PREFIX = 'OWNWARE_PROVIDER_VERIFY_'

const DEFAULT_PROBES: readonly VerificationProbeId[] = [
  'text_streaming',
  'terminal_events',
  'usage_reporting',
]

const ADAPTER_KINDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compatible',
] as const

export type ProviderVerificationAdapterKind = typeof ADAPTER_KINDS[number]

export interface ProviderVerificationEnvironment {
  readonly adapterKind: ProviderVerificationAdapterKind
  readonly adapterId: string
  readonly model: string
  readonly providerRouteId: string
  readonly modelRouteId: string
  readonly catalogGenerationId: string
  readonly outputPath: string
  readonly apiKey: string | null
  readonly baseUrl: string | null
  readonly authKind: 'bearer' | 'none'
  readonly probes: readonly VerificationProbeId[]
  readonly abortAfterMs?: number
  readonly contextChars?: number
  readonly expectRateLimit: boolean
  readonly includeUsage: boolean
  readonly features: ReadonlySet<
    'tool_use' | 'parallel_tool_use' | 'vision' | 'pdf' | 'cache_control'
  >
  readonly imagePath: string | null
  readonly imageMediaType: string
  readonly pdfPath: string | null
}

interface VerificationStore {
  load(): Promise<VerificationEvidenceStoreState>
  replace(candidate: unknown): Promise<unknown>
}

interface ProviderCommandDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly now?: () => Date
  readonly stdout?: (text: string) => void
  readonly readFixture?: (path: string) => Promise<Buffer>
  readonly createAdapter?: (
    config: ProviderVerificationEnvironment,
    credential: string | null,
    forceBearer?: boolean,
  ) => ProviderAdapter
  readonly runVerification?: (options: {
    readonly adapter: ProviderAdapter
    readonly model: string
    readonly probes: readonly VerificationProbeId[]
    readonly media?: VerificationMediaFixtures
    readonly abortAfterMs?: number
    readonly errorDrivers?: Partial<Record<
      'auth_error' | 'rate_limit_error' | 'context_window_error',
      () => Promise<void>
    >>
  }) => Promise<VerificationProbeResult[]>
  readonly createStore?: (path: string) => VerificationStore
}

class VerificationEvidenceRefusal extends Error {}

export function providerVerificationUsage(): string {
  return `ownware provider verify — qualify one exact provider/model route with live probes

Usage:
  ownware provider verify

Required environment:
  ${PREFIX}LIVE=1
  ${PREFIX}ADAPTER=<anthropic|openai|google|openrouter|openai-compatible>
  ${PREFIX}ADAPTER_ID=<runtime-adapter-id>
  ${PREFIX}MODEL=<wire-model-id>
  ${PREFIX}PROVIDER_ROUTE_ID=<catalog-provider-route-id>
  ${PREFIX}MODEL_ROUTE_ID=<catalog-model-route-id>
  ${PREFIX}CATALOG_GENERATION_ID=<catalog-generation-id>
  ${PREFIX}OUTPUT=<verification-evidence-file>

Credential and endpoint environment:
  ${PREFIX}API_KEY=<credential>             required except when AUTH_KIND=none
  ${PREFIX}BASE_URL=<url>                   required for openai-compatible
  ${PREFIX}AUTH_KIND=<bearer|none>          default: bearer

Optional probe environment:
  ${PREFIX}PROBES=<comma-separated probe ids>
  ${PREFIX}ABORT_AFTER_MS=<positive integer>
  ${PREFIX}CONTEXT_CHARS=<positive integer>
  ${PREFIX}EXPECT_RATE_LIMIT=1
  ${PREFIX}STREAM_USAGE=1
  ${PREFIX}TOOL_USE=1
  ${PREFIX}PARALLEL_TOOL_USE=1
  ${PREFIX}VISION=1
  ${PREFIX}PDF=1
  ${PREFIX}CACHE_CONTROL=1
  ${PREFIX}IMAGE_PATH=<path>
  ${PREFIX}IMAGE_MEDIA_TYPE=<media type>    default: image/png
  ${PREFIX}PDF_PATH=<path>

The credential is intentionally not accepted as a command-line argument.
Only stable ids and normalized statuses are printed. Persisted evidence contains
normalized, content-free request and stream facts only.`
}

export function parseProviderVerificationEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): ProviderVerificationEnvironment {
  requireExact(env, `${PREFIX}LIVE`, '1')
  const adapterKind = requireEnum(env, `${PREFIX}ADAPTER`, ADAPTER_KINDS)
  const adapterId = requireEnv(env, `${PREFIX}ADAPTER_ID`)
  if (adapterKind !== 'openai-compatible' && adapterId !== adapterKind) {
    throw new Error(`${PREFIX}ADAPTER_ID must equal ${adapterKind} for the selected adapter`)
  }
  if (adapterKind === 'openai-compatible' && !isCompatibleAdapterId(adapterId)) {
    throw new Error(
      `${PREFIX}ADAPTER_ID must be a provider slug or an oai_<12 lowercase hex> connection id`,
    )
  }

  const authKind = optionalEnv(env, `${PREFIX}AUTH_KIND`) ?? 'bearer'
  if (authKind !== 'bearer' && authKind !== 'none') {
    throw new Error(`${PREFIX}AUTH_KIND must be bearer or none`)
  }
  if (authKind === 'none' && adapterKind !== 'openai-compatible') {
    throw new Error(`${PREFIX}AUTH_KIND=none is supported only by openai-compatible routes`)
  }

  const probes = selectedProbes(env)
  return {
    adapterKind,
    adapterId,
    model: requireEnv(env, `${PREFIX}MODEL`),
    providerRouteId: requireEnv(env, `${PREFIX}PROVIDER_ROUTE_ID`),
    modelRouteId: requireEnv(env, `${PREFIX}MODEL_ROUTE_ID`),
    catalogGenerationId: requireEnv(env, `${PREFIX}CATALOG_GENERATION_ID`),
    outputPath: requireEnv(env, `${PREFIX}OUTPUT`),
    apiKey: optionalEnv(env, `${PREFIX}API_KEY`),
    baseUrl: optionalEnv(env, `${PREFIX}BASE_URL`),
    authKind,
    probes,
    abortAfterMs: positiveIntegerEnv(env, `${PREFIX}ABORT_AFTER_MS`),
    contextChars: positiveIntegerEnv(env, `${PREFIX}CONTEXT_CHARS`),
    expectRateLimit: exactOptIn(env, `${PREFIX}EXPECT_RATE_LIMIT`),
    includeUsage: exactOptIn(env, `${PREFIX}STREAM_USAGE`),
    features: new Set([
      ...(exactOptIn(env, `${PREFIX}TOOL_USE`) ? ['tool_use' as const] : []),
      ...(exactOptIn(env, `${PREFIX}PARALLEL_TOOL_USE`)
        ? ['parallel_tool_use' as const]
        : []),
      ...(exactOptIn(env, `${PREFIX}VISION`) ? ['vision' as const] : []),
      ...(exactOptIn(env, `${PREFIX}PDF`) ? ['pdf' as const] : []),
      ...(exactOptIn(env, `${PREFIX}CACHE_CONTROL`) ? ['cache_control' as const] : []),
    ]),
    imagePath: optionalEnv(env, `${PREFIX}IMAGE_PATH`),
    imageMediaType: optionalEnv(env, `${PREFIX}IMAGE_MEDIA_TYPE`) ?? 'image/png',
    pdfPath: optionalEnv(env, `${PREFIX}PDF_PATH`),
  }
}

export async function providerCommand(
  argv: readonly string[],
  dependencies: ProviderCommandDependencies = {},
): Promise<void> {
  const [subcommand, ...rest] = argv
  const stdout = dependencies.stdout ?? console.log
  if (
    subcommand == null
    || subcommand === 'help'
    || subcommand === '--help'
    || subcommand === '-h'
    || (subcommand === 'verify' && rest.length === 1 && isHelp(rest[0]))
  ) {
    stdout(providerVerificationUsage())
    return
  }
  if (subcommand !== 'verify') {
    throw new Error('ownware provider supports only the verify subcommand')
  }
  if (rest.length > 0) {
    throw new Error('ownware provider verify accepts no arguments; configure it through environment variables')
  }

  const config = parseProviderVerificationEnvironment(dependencies.env ?? process.env)
  let output: string
  try {
    output = await executeProviderVerification(config, dependencies)
  } catch (error) {
    if (error instanceof VerificationEvidenceRefusal) throw error
    throw new Error('Provider verification failed safely; no unvalidated evidence was promoted.')
  }
  stdout(output)
}

async function executeProviderVerification(
  config: ProviderVerificationEnvironment,
  dependencies: ProviderCommandDependencies,
): Promise<string> {
  const createAdapter = dependencies.createAdapter ?? createProviderVerificationAdapter
  const adapter = createAdapter(config, config.apiKey)
  if (adapter.name !== config.adapterId) {
    throw new Error('Constructed adapter identity did not match the requested adapter id')
  }
  const results = await (dependencies.runVerification ?? runProviderRouteVerification)({
    adapter,
    model: config.model,
    probes: config.probes,
    media: await mediaFixtures(config, dependencies.readFixture ?? readFile),
    abortAfterMs: config.abortAfterMs,
    errorDrivers: errorDrivers(config, adapter, createAdapter),
  })
  const observedAt = (dependencies.now ?? (() => new Date()))().toISOString()
  const evidence = createVerificationEvidence({
    schemaVersion: 1,
    harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
    providerRouteId: config.providerRouteId,
    modelRouteId: config.modelRouteId,
    runtimeId: 'loom',
    adapterId: adapter.name,
    protocol: protocolFor(config.adapterKind),
    mode: 'live',
    observedAt,
    catalogGenerationId: config.catalogGenerationId,
    results,
  })
  const store = (dependencies.createStore ?? (path => new VerificationEvidenceStore(path)))(
    config.outputPath,
  )
  const current = await store.load()
  if (current.status === 'error') {
    throw new VerificationEvidenceRefusal(
      'Provider verification refused: the active evidence file is invalid and was not overwritten.',
    )
  }
  if (
    current.bundle != null
    && (
      current.bundle.mode !== 'live'
      || current.bundle.harnessVersion !== PROVIDER_VERIFICATION_HARNESS_VERSION
    )
  ) {
    throw new VerificationEvidenceRefusal(
      'Provider verification refused: the active evidence file is incompatible and was not overwritten.',
    )
  }
  const entries = [
    ...(current.bundle?.entries ?? []).filter(entry => (
      entry.providerRouteId !== config.providerRouteId
      || entry.modelRouteId !== config.modelRouteId
    )),
    evidence,
  ]
  const bundle = createVerificationEvidenceBundle({
    harnessVersion: PROVIDER_VERIFICATION_HARNESS_VERSION,
    mode: 'live',
    createdAt: observedAt,
    entries,
  })
  const output = JSON.stringify({
    bundleId: bundle.bundleId,
    evidenceId: evidence.evidenceId,
    providerRouteId: config.providerRouteId,
    modelRouteId: config.modelRouteId,
    results: results.map(result => ({
      probeId: result.probeId,
      status: result.status,
      ...(result.status === 'skipped' ? { reason: result.reason } : {}),
    })),
  }, null, 2)
  await store.replace(bundle)
  return output
}

function createProviderVerificationAdapter(
  config: ProviderVerificationEnvironment,
  credential: string | null,
  forceBearer = false,
): ProviderAdapter {
  const baseUrl = config.baseUrl
  if (config.adapterKind === 'anthropic') {
    return new AnthropicProvider({
      apiKey: requireCredential(credential, config.adapterKind),
      ...(baseUrl == null ? {} : { baseURL: baseUrl }),
    })
  }
  if (config.adapterKind === 'openai') {
    return new OpenAIProvider({
      apiKey: requireCredential(credential, config.adapterKind),
      ...(baseUrl == null ? {} : { baseURL: baseUrl }),
    })
  }
  if (config.adapterKind === 'google') {
    return new GoogleProvider({
      apiKey: requireCredential(credential, config.adapterKind),
      ...(baseUrl == null ? {} : { baseURL: baseUrl }),
    })
  }
  if (config.adapterKind === 'openrouter') {
    return new OpenRouterProvider({
      apiKey: requireCredential(credential, config.adapterKind),
      ...(baseUrl == null ? {} : { baseURL: baseUrl }),
    })
  }
  if (baseUrl == null) throw new Error(`${PREFIX}BASE_URL is required for openai-compatible`)
  const authKind = forceBearer ? 'bearer' : config.authKind
  return new OpenAICompatibleProvider({
    name: config.adapterId,
    registryKind: config.adapterId.startsWith('oai_') ? 'connection' : 'preset',
    baseURL: baseUrl,
    auth: authKind === 'none'
      ? { kind: 'none' }
      : {
          kind: 'bearer',
          credentialProvider: async () => requireCredential(credential, config.adapterKind),
        },
    includeUsage: config.includeUsage,
    verifiedFeatures: new Set(['streaming', ...config.features]),
  })
}

function errorDrivers(
  config: ProviderVerificationEnvironment,
  adapter: ProviderAdapter,
  createAdapter: NonNullable<ProviderCommandDependencies['createAdapter']>,
): Partial<Record<
  'auth_error' | 'rate_limit_error' | 'context_window_error',
  () => Promise<void>
>> {
  const selected = new Set(config.probes)
  return {
    ...(selected.has('auth_error')
      ? {
          auth_error: async () => consume(
            createAdapter(config, 'ownware-deliberately-invalid-verification-key', true),
            request(config.model),
          ),
        }
      : {}),
    ...(selected.has('rate_limit_error') && config.expectRateLimit
      ? { rate_limit_error: async () => consume(adapter, request(config.model)) }
      : {}),
    ...(selected.has('context_window_error') && config.contextChars != null
      ? {
          context_window_error: async () => consume(
            adapter,
            request(config.model, 'x'.repeat(Math.min(50_000_000, config.contextChars!))),
          ),
        }
      : {}),
  }
}

async function consume(adapter: ProviderAdapter, value: ProviderRequest): Promise<void> {
  for await (const _chunk of adapter.stream(value)) {
    // Drain the normalized stream. Provider content is deliberately discarded.
  }
}

function request(model: string, prompt = 'Reply with OK.'): ProviderRequest {
  return {
    model,
    system: 'Follow the verification instruction exactly.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    maxTokens: 32,
    temperature: 0,
    stallWarnMs: 10_000,
    stallTimeoutMs: 30_000,
  }
}

async function mediaFixtures(
  config: ProviderVerificationEnvironment,
  fixtureReader: (path: string) => Promise<Buffer>,
): Promise<VerificationMediaFixtures | undefined> {
  if (config.imagePath == null && config.pdfPath == null) return undefined
  return {
    ...(config.imagePath == null
      ? {}
      : {
          image: {
            mediaType: config.imageMediaType,
            data: (await fixtureReader(config.imagePath)).toString('base64'),
          },
        }),
    ...(config.pdfPath == null
      ? {}
      : { pdf: { data: (await fixtureReader(config.pdfPath)).toString('base64') } }),
  }
}

function selectedProbes(
  env: Readonly<Record<string, string | undefined>>,
): VerificationProbeId[] {
  const raw = optionalEnv(env, `${PREFIX}PROBES`)
  if (raw == null) return [...DEFAULT_PROBES]
  const values = raw.split(',').map(value => value.trim())
  if (values.some(value => value.length === 0)) {
    throw new Error(`${PREFIX}PROBES must be a comma-separated list without empty entries`)
  }
  const parsed = values.map(value => VerificationProbeIdSchema.parse(value))
  if (parsed.length === 0) throw new Error(`${PREFIX}PROBES must select at least one probe`)
  return [...new Set(parsed)]
}

function protocolFor(kind: ProviderVerificationAdapterKind) {
  if (kind === 'anthropic') return 'anthropic_messages' as const
  if (kind === 'google') return 'google_generate_content' as const
  return 'openai_chat_completions' as const
}

function requireCredential(value: string | null, kind: string): string {
  if (value == null) throw new Error(`An explicit verification credential is required for ${kind}`)
  return value
}

function requireExact(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  expected: string,
): void {
  if (env[name] !== expected) {
    throw new Error(`${name}=${expected} is required to opt into paid/network provider probes`)
  }
}

function exactOptIn(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = optionalEnv(env, name)
  if (value == null) return false
  if (value !== '1') throw new Error(`${name} must be 1 when enabled`)
  return true
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = optionalEnv(env, name)
  if (value == null) throw new Error(`${name} is required`)
  return value
}

function optionalEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | null {
  const value = env[name]?.trim()
  return value == null || value.length === 0 ? null : value
}

function requireEnum<const T extends readonly string[]>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  values: T,
): T[number] {
  const value = requireEnv(env, name)
  if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}`)
  return value as T[number]
}

function positiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = optionalEnv(env, name)
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function isCompatibleAdapterId(value: string): boolean {
  return /^oai_[a-f0-9]{12}$/.test(value) || /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function isHelp(value: string | undefined): boolean {
  return value === 'help' || value === '--help' || value === '-h'
}
