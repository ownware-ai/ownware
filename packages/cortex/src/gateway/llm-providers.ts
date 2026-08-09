/**
 * Catalogue of every LLM provider the gateway knows how to wire.
 *
 * One descriptor per provider — `providerId` is the loom registry key,
 * `variableName` is the canonical credential identifier (the env var an
 * SDK adapter would expect). Both `handlers/providers.ts` (Settings UI)
 * and Provider Hub consult this list, so connection and
 * transport discovery do not rebuild a parallel provider catalogue.
 */

/**
 * How a provider may be powered.
 *
 * - `api-key` — a static developer key the account holder pastes in.
 * - `oauth` — a token set obtained by the account holder authorising us, held
 *   and refreshed on their behalf.
 */
export type LlmCredentialKind = 'api-key' | 'oauth'

export interface LlmProviderDescriptor {
  readonly providerId: string
  readonly name: string
  readonly variableName: string
  readonly adapter: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'openai-compatible'
  readonly routeKind: 'direct' | 'router'
  readonly billingKind: 'metered' | 'provider_reported' | 'local' | 'unknown'
  readonly protocol: string
  readonly sdkPackage: string
  readonly apiBaseUrl: string
  /** Credential-only endpoint used by provider-key validation. */
  readonly validationUrl?: string
  /** Provider-specific Chat Completions output-token field. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * The credential kinds this provider may be powered by.
   *
   * This is only a construction capability: what the current gateway provider
   * adapter can accept. It is not a billing, subscription, legal, or permission
   * conclusion. Those route-level decisions live in the runtime/access
   * contract and its accepted evidence, not in a provider catalogue comment.
   */
  readonly credentialKinds: readonly LlmCredentialKind[]
}

export interface LlmProviderRouteBinding {
  readonly kind: LlmProviderDescriptor['routeKind']
  readonly billingKind: LlmProviderDescriptor['billingKind']
  readonly protocol: string
  readonly sdkPackage: string
  readonly apiBaseUrl: string
  readonly modelKind: 'text-generation'
}

export const LLM_PROVIDERS: readonly LlmProviderDescriptor[] = [
  {
    providerId: 'anthropic',
    name: 'Anthropic API Key',
    variableName: 'ANTHROPIC_API_KEY',
    adapter: 'anthropic',
    routeKind: 'direct',
    billingKind: 'metered',
    protocol: 'anthropic-messages',
    sdkPackage: '@anthropic-ai/sdk',
    apiBaseUrl: 'https://api.anthropic.com/v1',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'openai',
    name: 'OpenAI API Key',
    variableName: 'OPENAI_API_KEY',
    adapter: 'openai',
    routeKind: 'direct',
    billingKind: 'metered',
    protocol: 'openai-chat-completions',
    sdkPackage: 'openai',
    apiBaseUrl: 'https://api.openai.com/v1',
    validationUrl: 'https://api.openai.com/v1/models',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'google',
    name: 'Google API Key',
    variableName: 'GOOGLE_API_KEY',
    adapter: 'google',
    routeKind: 'direct',
    billingKind: 'metered',
    protocol: 'google-generate-content',
    sdkPackage: '@google/generative-ai',
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'openrouter',
    name: 'OpenRouter API Key',
    variableName: 'OPENROUTER_API_KEY',
    adapter: 'openrouter',
    routeKind: 'router',
    billingKind: 'provider_reported',
    protocol: 'openrouter',
    sdkPackage: 'openai',
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    validationUrl: 'https://openrouter.ai/api/v1/auth/key',
    credentialKinds: ['api-key'],
  },
  {
    providerId: 'xai', name: 'xAI API Key', variableName: 'XAI_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.x.ai/v1',
    validationUrl: 'https://api.x.ai/v1/models', credentialKinds: ['api-key'],
  },
  {
    providerId: 'mistral', name: 'Mistral API Key', variableName: 'MISTRAL_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.mistral.ai/v1',
    validationUrl: 'https://api.mistral.ai/v1/models', credentialKinds: ['api-key'],
  },
  {
    providerId: 'groq', name: 'Groq API Key', variableName: 'GROQ_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.groq.com/openai/v1',
    validationUrl: 'https://api.groq.com/openai/v1/models',
    maxTokensField: 'max_completion_tokens', credentialKinds: ['api-key'],
  },
  {
    providerId: 'togetherai', name: 'Together AI API Key', variableName: 'TOGETHER_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.together.ai/v1',
    validationUrl: 'https://api.together.ai/v1/models', credentialKinds: ['api-key'],
  },
  {
    providerId: 'deepinfra', name: 'DeepInfra API Key', variableName: 'DEEPINFRA_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.deepinfra.com/v1/openai',
    validationUrl: 'https://api.deepinfra.com/v1/openai/models', credentialKinds: ['api-key'],
  },
  {
    providerId: 'fireworks-ai', name: 'Fireworks AI API Key', variableName: 'FIREWORKS_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.fireworks.ai/inference/v1',
    validationUrl: 'https://api.fireworks.ai/v1/accounts', credentialKinds: ['api-key'],
  },
  {
    providerId: 'cerebras', name: 'Cerebras API Key', variableName: 'CEREBRAS_API_KEY',
    adapter: 'openai-compatible', routeKind: 'direct', billingKind: 'metered', protocol: 'openai-compatible',
    sdkPackage: 'openai', apiBaseUrl: 'https://api.cerebras.ai/v1',
    validationUrl: 'https://api.cerebras.ai/v1/models',
    maxTokensField: 'max_completion_tokens', credentialKinds: ['api-key'],
  },
  {
    providerId: 'vercel', name: 'Vercel AI Gateway API Key', variableName: 'AI_GATEWAY_API_KEY',
    adapter: 'openai-compatible', routeKind: 'router', billingKind: 'metered',
    protocol: 'openai-compatible', sdkPackage: 'openai',
    apiBaseUrl: 'https://ai-gateway.vercel.sh/v1', credentialKinds: ['api-key'],
  },
  {
    providerId: 'helicone', name: 'Helicone AI Gateway API Key', variableName: 'HELICONE_API_KEY',
    adapter: 'openai-compatible', routeKind: 'router', billingKind: 'metered',
    protocol: 'openai-compatible', sdkPackage: 'openai',
    apiBaseUrl: 'https://ai-gateway.helicone.ai/v1', credentialKinds: ['api-key'],
  },
]

/** Secret-free route bindings consumed by Provider Hub catalog projection. */
export const LLM_PROVIDER_ROUTE_BINDINGS: ReadonlyMap<string, LlmProviderRouteBinding> = new Map(
  LLM_PROVIDERS.map((provider) => [
    provider.providerId,
    {
      kind: provider.routeKind,
      billingKind: provider.billingKind,
      protocol: provider.protocol,
      sdkPackage: provider.sdkPackage,
      apiBaseUrl: provider.apiBaseUrl,
      modelKind: 'text-generation' as const,
    },
  ] as const),
)

/**
 * Whether this provider may be powered by the given credential kind.
 *
 * Returns `false` for an unknown provider id because no adapter capability was
 * declared. This does not answer whether a provider permits a route.
 */
export function supportsCredentialKind(providerId: string, kind: LlmCredentialKind): boolean {
  return llmProviderById(providerId)?.credentialKinds.includes(kind) ?? false
}

/** Reverse lookup: variableName → providerId. */
export const VARIABLE_NAME_TO_PROVIDER_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(LLM_PROVIDERS.map((d) => [d.variableName, d.providerId])),
)

/** Lookup helper used by handlers when they have a providerId in hand. */
export function llmProviderById(providerId: string): LlmProviderDescriptor | undefined {
  return LLM_PROVIDERS.find((d) => d.providerId === providerId)
}
